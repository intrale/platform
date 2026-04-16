#!/usr/bin/env node
// google-drive-oauth-setup.js — Configura OAuth 2.0 para Google Drive (cuenta personal)
//
// Uso:
//   1. Crear OAuth Client ID en Google Cloud Console (tipo Desktop)
//   2. Ejecutar: node scripts/google-drive-oauth-setup.js <client_id> <client_secret>
//   3. Se abre el browser automáticamente
//   4. Autorizar con tu cuenta Google
//   5. El script captura el token automáticamente
//
// Prerequisitos:
//   - Proyecto en Google Cloud Console con Drive API habilitada
//   - OAuth 2.0 Client ID tipo "Desktop app"

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { exec } = require("child_process");

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
const PORT = 18923; // Puerto local para el redirect
const REDIRECT_URI = "http://localhost:" + PORT;

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
                    console.log("No se recibio refresh_token. Intentá de nuevo.");
                    server.close();
                    process.exit(1);
                    return;
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
                console.log("Listo — el refresh token no expira si la app esta publicada.");

            } catch(e) {
                console.log("Error parseando respuesta: " + e.message);
                console.log("Respuesta: " + data);
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
