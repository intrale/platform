#!/usr/bin/env node
// google-drive-oauth-setup.js — Configura OAuth 2.0 para Google Drive (cuenta personal)
//
// Uso:
//   1. Crear OAuth Client ID en Google Cloud Console (tipo Desktop)
//   2. Ejecutar: node scripts/google-drive-oauth-setup.js <client_id> <client_secret>
//   3. Abrir la URL que muestra en el browser
//   4. Autorizar y copiar el code
//   5. Pegar el code cuando lo pida
//   6. Guarda refresh_token en .claude/hooks/telegram-config.json
//
// Prerequisitos:
//   - Proyecto en Google Cloud Console con Drive API habilitada
//   - OAuth 2.0 Client ID tipo "Desktop app" (no Web, no Service Account)

const fs = require("fs");
const path = require("path");
const https = require("https");
const readline = require("readline");

const CONFIG_PATH = path.resolve(__dirname, "..", ".claude", "hooks", "telegram-config.json");

const clientId = process.argv[2];
const clientSecret = process.argv[3];

if (!clientId || !clientSecret) {
    console.log("Uso: node scripts/google-drive-oauth-setup.js <client_id> <client_secret>");
    console.log("");
    console.log("Pasos previos:");
    console.log("  1. Ir a https://console.cloud.google.com/apis/credentials");
    console.log("  2. Click 'Crear credenciales' > 'ID de cliente OAuth'");
    console.log("  3. Tipo: 'App de escritorio' (Desktop app)");
    console.log("  4. Copiar Client ID y Client Secret");
    console.log("  5. Ejecutar este script con esos valores");
    process.exit(1);
}

const SCOPES = "https://www.googleapis.com/auth/drive.file";
const REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";

// Paso 1: Generar URL de autorizacion
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
console.log("1. Abri esta URL en tu browser:");
console.log("");
console.log("   " + authUrl);
console.log("");
console.log("2. Autorizá con tu cuenta Google");
console.log("3. Copiá el código que te da");
console.log("");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question("4. Pegá el código acá: ", function(code) {
    rl.close();
    code = code.trim();
    if (!code) { console.log("Código vacío. Abortando."); process.exit(1); }

    // Paso 2: Intercambiar code por tokens
    const payload = "code=" + encodeURIComponent(code) +
        "&client_id=" + encodeURIComponent(clientId) +
        "&client_secret=" + encodeURIComponent(clientSecret) +
        "&redirect_uri=" + encodeURIComponent(REDIRECT_URI) +
        "&grant_type=authorization_code";

    const req = https.request({
        hostname: "oauth2.googleapis.com",
        path: "/token",
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(payload),
        },
    }, function(res) {
        var data = "";
        res.on("data", function(c) { data += c; });
        res.on("end", function() {
            try {
                var tokens = JSON.parse(data);
                if (tokens.error) {
                    console.log("Error: " + tokens.error + " — " + (tokens.error_description || ""));
                    process.exit(1);
                }
                if (!tokens.refresh_token) {
                    console.log("No se recibió refresh_token. Intentá de nuevo con prompt=consent.");
                    process.exit(1);
                }

                console.log("");
                console.log("=== Tokens recibidos ===");
                console.log("  access_token: " + tokens.access_token.substring(0, 20) + "...");
                console.log("  refresh_token: " + tokens.refresh_token.substring(0, 20) + "...");
                console.log("  expires_in: " + tokens.expires_in + "s");

                // Guardar en telegram-config.json
                var config = {};
                try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch(e) {}

                config.google_oauth_client_id = clientId;
                config.google_oauth_client_secret = clientSecret;
                config.google_oauth_refresh_token = tokens.refresh_token;

                fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
                console.log("");
                console.log("Guardado en " + CONFIG_PATH);
                console.log("");
                console.log("Ahora configurá google_drive_folder_id:");
                console.log("  1. Creá una carpeta 'Intrale QA' en Google Drive");
                console.log("  2. Copiá el ID de la URL (después de /folders/)");
                console.log("  3. Agregalo a telegram-config.json como google_drive_folder_id");

            } catch(e) {
                console.log("Error parseando respuesta: " + e.message);
                console.log("Respuesta: " + data);
            }
        });
    });
    req.on("error", function(e) { console.log("Error: " + e.message); });
    req.write(payload);
    req.end();
});
