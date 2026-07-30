#!/usr/bin/env node
// google-drive-oauth-setup.js — Configura OAuth 2.0 para Google Drive (cuenta personal)
//
// Uso:
//   1. Crear OAuth Client ID en Google Cloud Console (tipo Desktop)
//   2. Ejecutar: node scripts/google-drive-oauth-setup.js [client_id]
//      → el client SECRET se pide por prompt (no se pasa por linea de comandos)
//        o se toma de la variable de entorno GOOGLE_OAUTH_CLIENT_SECRET
//   3. Se abre el browser automaticamente
//   4. Autorizar con tu cuenta Google
//   5. El script captura el token y lo persiste en el store canonico
//
// Destino (#5217 · CA-4): ~/.claude/secrets/credentials.json, bajo el namespace
// `google_drive`. NUNCA en un archivo del repo: `git reset --hard` en cada
// respawn borraria las credenciales, y ademas el archivo esta trackeado (un
// `git add -A` commitearia un client secret y un refresh token de Google).
// La escritura pasa por `writeCanonicalPaths`, que aporta backup pre-save,
// escritura atomica, `chmod 0600` y retencion de backups.
//
// Prerequisitos:
//   - Proyecto en Google Cloud Console con Drive API habilitada
//   - OAuth 2.0 Client ID tipo "Desktop app"

const http = require("http");
const https = require("https");
const path = require("path");
const readline = require("readline");
const { exec } = require("child_process");

const secretsRw = require(path.resolve(__dirname, "..", ".pipeline", "lib", "multi-provider", "secrets-rw.js"));

const SCOPES = "https://www.googleapis.com/auth/drive.file";
const PORT = 18923; // Puerto local para el redirect
const REDIRECT_URI = "http://localhost:" + PORT;

// Dot-paths canonicos que escribe este script. Se listan al operador al final
// (CA-12), por NOMBRE — nunca por valor ni por prefijo.
const CANONICAL_KEYS = {
    clientId: "google_drive.oauth_client_id",
    clientSecret: "google_drive.oauth_client_secret",
    refreshToken: "google_drive.oauth_refresh_token",
    folderId: "google_drive.drive_folder_id",
};

function printUsage() {
    console.log("Uso: node scripts/google-drive-oauth-setup.js [client_id]");
    console.log("");
    console.log("El client SECRET no se pasa por linea de comandos: los argumentos son");
    console.log("visibles en la tabla de procesos del SO y quedan en el historial del shell.");
    console.log("Se pide por prompt, o se toma de GOOGLE_OAUTH_CLIENT_SECRET.");
    console.log("");
    console.log("Pasos previos:");
    console.log("  1. Ir a https://console.cloud.google.com/apis/credentials");
    console.log("  2. Click 'Crear credenciales' > 'ID de cliente OAuth'");
    console.log("  3. Tipo: 'App de escritorio' (Desktop app)");
    console.log("  4. Copiar Client ID y Client Secret");
    console.log("  5. Ejecutar este script (el secret se pide de forma interactiva)");
}

// Lee un valor sin eco en pantalla. Si stdin no es una terminal (CI, pipe), el
// valor tiene que venir por variable de entorno: no hay forma de pedirlo.
function promptHidden(label) {
    return new Promise(function(resolve, reject) {
        if (!process.stdin.isTTY) {
            reject(new Error("stdin no es una terminal: defini GOOGLE_OAUTH_CLIENT_SECRET en el entorno."));
            return;
        }
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        rl.muted = false;
        rl._writeToOutput = function(s) { if (!rl.muted) rl.output.write(s); };
        process.stdout.write(label);
        rl.muted = true;
        rl.question("", function(answer) {
            rl.muted = false;
            rl.close();
            process.stdout.write("\n");
            resolve(String(answer == null ? "" : answer).trim());
        });
    });
}

function promptVisible(label) {
    return new Promise(function(resolve, reject) {
        if (!process.stdin.isTTY) {
            reject(new Error("stdin no es una terminal: pasa el client_id como argumento o por GOOGLE_OAUTH_CLIENT_ID."));
            return;
        }
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        rl.question(label, function(answer) {
            rl.close();
            resolve(String(answer == null ? "" : answer).trim());
        });
    });
}

// El client_id NO es secreto (viaja en la URL de autorizacion), asi que puede ir
// por argv. El client_secret SI lo es: solo por env o prompt (CWE-214).
async function resolveClientCredentials() {
    if (process.argv[3]) {
        console.log("");
        console.log("ERROR: el client secret ya no se pasa por linea de comandos.");
        console.log("Los argumentos son visibles en la tabla de procesos y quedan en el");
        console.log("historial del shell (CWE-214). Rota ese secret en Google Cloud Console");
        console.log("y volve a ejecutar sin el segundo argumento.");
        console.log("");
        printUsage();
        process.exit(1);
    }

    let clientId = process.argv[2] || process.env.GOOGLE_OAUTH_CLIENT_ID || "";
    if (!clientId) clientId = await promptVisible("Client ID: ");
    if (!clientId) {
        printUsage();
        process.exit(1);
    }

    let clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
    if (!clientSecret) clientSecret = await promptHidden("Client Secret (no se muestra): ");
    if (!clientSecret) {
        console.log("");
        console.log("ERROR: client secret vacio.");
        printUsage();
        process.exit(1);
    }

    // El folder ID no es secreto y es opcional: si el operador lo deja vacio se
    // conserva el que ya este en el store (persistTokens no pisa con vacio).
    const folderId = (process.env.GOOGLE_DRIVE_FOLDER_ID || "").trim()
        || await promptVisible("Drive folder ID de QA (ENTER para conservar el actual): ");

    return { clientId: clientId, clientSecret: clientSecret, folderId: folderId };
}

// `folderId` no es secreto (es el ID de la carpeta de QA en Drive), pero SI es
// parte de la provision: sin el, la evidencia se sube a la raiz del Drive.
// Antes solo se podia setear a mano en el archivo trackeado del repo — o sea,
// se perdia en cada `reset --hard`. Se persiste en el store canonico, junto al
// resto, y solo si el operador lo aporta (env o prompt): vacio NO pisa el valor
// ya guardado.
function persistTokens(clientId, clientSecret, refreshToken, folderId, opts) {
    const updates = {};
    updates[CANONICAL_KEYS.clientId] = clientId;
    updates[CANONICAL_KEYS.clientSecret] = clientSecret;
    updates[CANONICAL_KEYS.refreshToken] = refreshToken;
    if (folderId) updates[CANONICAL_KEYS.folderId] = folderId;
    return secretsRw.writeCanonicalPaths(updates, opts || {});
}

function startOAuthFlow(clientId, clientSecret, folderId) {
    // Paso 1: Levantar server HTTP local para capturar el code
    const server = http.createServer(function(req, res) {
        const url = new URL(req.url, "http://localhost:" + PORT);
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end("<h2>Error: " + error + "</h2><p>Podés cerrar esta ventana.</p>");
            console.log("\nError de autorizacion: " + error);
            server.close();
            process.exit(1);
            return;
        }

        if (!code) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end("<p>Esperando autorizacion...</p>");
            return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h2>Autorizado correctamente</h2><p>Podés cerrar esta ventana. Volvé a la terminal.</p>");

        // Paso 2: Intercambiar code por tokens
        console.log("\nCode recibido. Intercambiando por tokens...");

        const payload = "code=" + encodeURIComponent(code) +
            "&client_id=" + encodeURIComponent(clientId) +
            "&client_secret=" + encodeURIComponent(clientSecret) +
            "&redirect_uri=" + encodeURIComponent(REDIRECT_URI) +
            "&grant_type=authorization_code";

        const tokenReq = https.request({
            hostname: "oauth2.googleapis.com",
            path: "/token",
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(payload),
            },
        }, function(tokenRes) {
            var data = "";
            tokenRes.on("data", function(c) { data += c; });
            tokenRes.on("end", function() {
                try {
                    var tokens = JSON.parse(data);
                    if (tokens.error) {
                        console.log("Error: " + tokens.error + " — " + (tokens.error_description || ""));
                        server.close();
                        process.exit(1);
                        return;
                    }
                    if (!tokens.refresh_token) {
                        console.log("No se recibio refresh_token. Intenta de nuevo.");
                        server.close();
                        process.exit(1);
                        return;
                    }

                    // Confirmacion por FORMA, sin valores ni prefijos (CWE-532):
                    // los logs del pipeline se archivan y se comparten en reportes.
                    console.log("");
                    console.log("=== Tokens recibidos ===");
                    console.log("  access_token: presente");
                    console.log("  refresh_token: presente");
                    console.log("  expires_in: " + tokens.expires_in + "s");

                    var saved = persistTokens(clientId, clientSecret, tokens.refresh_token, folderId);

                    // CA-12: el operador tiene que saber DONDE quedo guardado y
                    // QUE claves se escribieron, sin ver ningun valor.
                    console.log("");
                    console.log("Guardado en el store canonico: " + saved.targetPath);
                    console.log("Claves escritas:");
                    saved.written.forEach(function(k) { console.log("  - " + k); });
                    if (saved.backupPath) console.log("Backup previo: " + saved.backupPath);
                    console.log("");
                    if (saved.written.indexOf(CANONICAL_KEYS.folderId) === -1) {
                        console.log("Nota: no se aporto Drive folder ID, se conserva el valor ya");
                        console.log("guardado en google_drive.drive_folder_id del mismo store.");
                        console.log("Si ese valor no existe, la evidencia se sube a la RAIZ del Drive.");
                    }
                    console.log("Listo — el refresh token no expira si la app esta publicada.");

                } catch(e) {
                    console.log("Error procesando la respuesta: " + e.message);
                }
                server.close();
                process.exit(0);
            });
        });
        tokenReq.on("error", function(e) { console.log("Error: " + e.message); server.close(); });
        tokenReq.write(payload);
        tokenReq.end();
    });

    server.listen(PORT, function() {
        // Paso 1b: Construir URL de autorizacion y abrir en browser
        const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" +
            "client_id=" + encodeURIComponent(clientId) +
            "&redirect_uri=" + encodeURIComponent(REDIRECT_URI) +
            "&response_type=code" +
            "&scope=" + encodeURIComponent(SCOPES) +
            "&access_type=offline" +
            "&prompt=consent";

        console.log("");
        console.log("=== Google Drive OAuth Setup ===");
        console.log("");
        console.log("Abriendo browser para autorizar...");
        console.log("Si no se abre, copiá esta URL manualmente:");
        console.log("");
        console.log("  " + authUrl);
        console.log("");

        // Abrir en browser (Windows)
        exec('start "" "' + authUrl + '"');
    });

    // Timeout de 5 minutos
    setTimeout(function() {
        console.log("\nTimeout — no se recibio autorizacion en 5 minutos.");
        server.close();
        process.exit(1);
    }, 300000);
}

async function main() {
    const creds = await resolveClientCredentials();
    startOAuthFlow(creds.clientId, creds.clientSecret, creds.folderId);
}

if (require.main === module) {
    main().catch(function(e) {
        console.log("");
        console.log("ERROR: " + e.message);
        process.exit(1);
    });
}

module.exports = { CANONICAL_KEYS, persistTokens };
