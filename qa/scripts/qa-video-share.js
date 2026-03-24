#!/usr/bin/env node
// qa-video-share.js — Distribuye videos de evidencia QA a stakeholders vía Google Drive + Telegram
//
// Uso:
//   node qa/scripts/qa-video-share.js \
//     --issue 1112 \
//     --title "Login — happy path" \
//     --sprint "SPR-0051" \
//     --videos "qa/recordings/maestro-shard-5554.mp4,qa/recordings/maestro-shard-5556.mp4" \
//     --verdict "APROBADO" \
//     --passed 3 --total 3
//
// Estrategia en 3 niveles:
//   1. Google Drive (si google_credentials_path configurado en telegram-config.json):
//      → Sube video a "Intrale QA / SPR-XXXX / #issue-titulo /"
//      → Permisos "anyone with link" (reader)
//      → Envía link por Telegram (mensaje descriptivo)
//      → Guarda video_url en qa-report.json
//   2. Video <= 50MB y Drive no disponible → sendVideo directo por Telegram Bot API
//   3. Video > 50MB sin Drive → subir a Cloudflare R2 + enviar link (si R2 configurado)
//      (requiere R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET en env)
//
// Dependencias: ninguna (Node.js puro, https/crypto nativos)
// Config Telegram: lee de .claude/hooks/telegram-config.json
// Config Drive: google_credentials_path + google_drive_folder_id en telegram-config.json
//               O GOOGLE_CREDENTIALS_PATH + GOOGLE_DRIVE_FOLDER_ID en env

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

// --- Constantes ---

const TELEGRAM_MAX_VIDEO_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;
const R2_PRESIGNED_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 dias

// --- Config ---

const HOOKS_DIR = path.resolve(__dirname, "../../.claude/hooks");
const CONFIG_PATH = path.join(HOOKS_DIR, "telegram-config.json");

let BOT_TOKEN = "";
let CHAT_ID = "";
let DRIVE_FOLDER_ID = "";
let DRIVE_CREDENTIALS_PATH = "";
try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    BOT_TOKEN = cfg.bot_token || "";
    // Preferir sponsor_chat_id si existe, fallback a chat_id
    CHAT_ID = cfg.sponsor_chat_id || cfg.chat_id || "";
    DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || cfg.google_drive_folder_id || "";
    DRIVE_CREDENTIALS_PATH = process.env.GOOGLE_CREDENTIALS_PATH || cfg.google_credentials_path || "";
} catch (e) {
    console.error("[qa-video-share] No se pudo leer telegram-config.json:", e.message);
    process.exit(1);
}

// R2 config (opcional, desde env)
const R2_CONFIG = {
    accountId: process.env.R2_ACCOUNT_ID || "",
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
    bucket: process.env.R2_BUCKET || "intrale-qa-evidence",
};

// --- Argument parsing ---

function parseArgs() {
    const args = process.argv.slice(2);
    const result = {
        issue: "0",
        title: "",
        sprint: "",
        videos: "",
        verdict: "DESCONOCIDO",
        passed: "0",
        total: "0",
    };
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case "--issue":   result.issue   = args[++i] || "0"; break;
            case "--title":   result.title   = args[++i] || ""; break;
            case "--sprint":  result.sprint  = args[++i] || ""; break;
            case "--videos":  result.videos  = args[++i] || ""; break;
            case "--verdict": result.verdict = args[++i] || "DESCONOCIDO"; break;
            case "--passed":  result.passed  = args[++i] || "0"; break;
            case "--total":   result.total   = args[++i] || "0"; break;
        }
    }
    return result;
}

// --- Telegram: sendVideo (multipart/form-data) ---

function sendTelegramVideo(videoBuffer, filename, caption) {
    return new Promise((resolve, reject) => {
        const boundary = "----QAVideoBoundary" + Date.now().toString(36);
        const CRLF = "\r\n";

        let textParts = "";
        textParts += "--" + boundary + CRLF;
        textParts += 'Content-Disposition: form-data; name="chat_id"' + CRLF + CRLF;
        textParts += CHAT_ID + CRLF;

        if (caption) {
            textParts += "--" + boundary + CRLF;
            textParts += 'Content-Disposition: form-data; name="caption"' + CRLF + CRLF;
            textParts += caption + CRLF;
        }

        textParts += "--" + boundary + CRLF;
        textParts += 'Content-Disposition: form-data; name="supports_streaming"' + CRLF + CRLF;
        textParts += "true" + CRLF;

        textParts += "--" + boundary + CRLF;
        textParts += 'Content-Disposition: form-data; name="parse_mode"' + CRLF + CRLF;
        textParts += "Markdown" + CRLF;

        const preFile = Buffer.from(
            textParts +
            "--" + boundary + CRLF +
            'Content-Disposition: form-data; name="video"; filename="' + filename + '"' + CRLF +
            "Content-Type: video/mp4" + CRLF + CRLF
        );
        const postFile = Buffer.from(CRLF + "--" + boundary + "--" + CRLF);
        const fullBody = Buffer.concat([preFile, videoBuffer, postFile]);

        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + BOT_TOKEN + "/sendVideo",
            method: "POST",
            headers: {
                "Content-Type": "multipart/form-data; boundary=" + boundary,
                "Content-Length": fullBody.length,
            },
            timeout: 120000,
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.ok) resolve(r);
                    else reject(new Error(d));
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout (120s)")); });
        req.on("error", (e) => reject(e));
        req.write(fullBody);
        req.end();
    });
}

// --- Telegram: sendMessage ---

function sendTelegramMessage(text) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            chat_id: CHAT_ID,
            text: text,
            parse_mode: "Markdown",
            disable_web_page_preview: false,
        });
        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + BOT_TOKEN + "/sendMessage",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
            },
            timeout: 15000,
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.ok) resolve(r);
                    else reject(new Error(d));
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.on("error", (e) => reject(e));
        req.write(payload);
        req.end();
    });
}

// --- Google Drive: Service Account JWT + REST API (Node.js puro) ---

// OAuth config (alternativa a Service Account — funciona con cuentas personales)
let OAUTH_CLIENT_ID = "";
let OAUTH_CLIENT_SECRET = "";
let OAUTH_REFRESH_TOKEN = "";
try {
    const cfg2 = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || cfg2.google_oauth_client_id || "";
    OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || cfg2.google_oauth_client_secret || "";
    OAUTH_REFRESH_TOKEN = process.env.GOOGLE_OAUTH_REFRESH_TOKEN || cfg2.google_oauth_refresh_token || "";
} catch (e) {}

function driveAvailable() {
    // OAuth tiene prioridad sobre Service Account
    if (OAUTH_REFRESH_TOKEN && OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET) return true;
    if (!DRIVE_CREDENTIALS_PATH) return false;
    const resolved = path.resolve(DRIVE_CREDENTIALS_PATH);
    return fs.existsSync(resolved);
}

function loadDriveCredentials() {
    const resolved = path.resolve(DRIVE_CREDENTIALS_PATH);
    return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

// Generar JWT firmado para Service Account
function createServiceAccountJWT(credentials) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
        iss: credentials.client_email,
        scope: "https://www.googleapis.com/auth/drive",
        aud: "https://oauth2.googleapis.com/token",
        exp: now + 3600,
        iat: now,
    })).toString("base64url");
    const unsigned = header + "." + payload;
    const sign = crypto.createSign("RSA-SHA256");
    sign.update(unsigned);
    const signature = sign.sign(credentials.private_key, "base64url");
    return unsigned + "." + signature;
}

// Obtener access token via OAuth refresh token (cuenta personal)
function getOAuthAccessToken() {
    return new Promise((resolve, reject) => {
        const payload = "client_id=" + encodeURIComponent(OAUTH_CLIENT_ID) +
            "&client_secret=" + encodeURIComponent(OAUTH_CLIENT_SECRET) +
            "&refresh_token=" + encodeURIComponent(OAUTH_REFRESH_TOKEN) +
            "&grant_type=refresh_token";
        const req = https.request({
            hostname: "oauth2.googleapis.com", path: "/token", method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(payload) },
            timeout: 15000,
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.access_token) resolve(r.access_token);
                    else reject(new Error("OAuth token error: " + d));
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("OAuth token timeout")); });
        req.on("error", (e) => reject(e));
        req.write(payload);
        req.end();
    });
}

// Obtener access token via JWT grant (Service Account)
function getGoogleAccessToken(credentials) {
    // Prioridad: OAuth refresh token > Service Account JWT
    if (OAUTH_REFRESH_TOKEN && OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET) {
        return getOAuthAccessToken();
    }
    return new Promise((resolve, reject) => {
        const jwt = createServiceAccountJWT(credentials);
        const payload = "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") +
            "&assertion=" + encodeURIComponent(jwt);
        const req = https.request({
            hostname: "oauth2.googleapis.com",
            path: "/token",
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(payload),
            },
            timeout: 15000,
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.access_token) resolve(r.access_token);
                    else reject(new Error("Token error: " + d));
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("token request timeout")); });
        req.on("error", (e) => reject(e));
        req.write(payload);
        req.end();
    });
}

// Listar carpetas hijas con un nombre dado dentro de un padre
function driveListFolder(accessToken, name, parentId) {
    return new Promise((resolve, reject) => {
        const q = encodeURIComponent(
            "mimeType='application/vnd.google-apps.folder'" +
            " and name='" + name.replace(/'/g, "\\'") + "'" +
            " and '" + parentId + "' in parents" +
            " and trashed=false"
        );
        const req = https.request({
            hostname: "www.googleapis.com",
            path: "/drive/v3/files?q=" + q + "&fields=files(id,name)&spaces=drive",
            method: "GET",
            headers: { Authorization: "Bearer " + accessToken },
            timeout: 15000,
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    resolve((r.files || []));
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("list folder timeout")); });
        req.on("error", (e) => reject(e));
        req.end();
    });
}

// Crear carpeta en Drive
function driveCreateFolder(accessToken, name, parentId) {
    return new Promise((resolve, reject) => {
        const metadata = JSON.stringify({
            name: name,
            mimeType: "application/vnd.google-apps.folder",
            parents: [parentId],
        });
        const req = https.request({
            hostname: "www.googleapis.com",
            path: "/drive/v3/files?fields=id,name",
            method: "POST",
            headers: {
                Authorization: "Bearer " + accessToken,
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(metadata),
            },
            timeout: 15000,
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.id) resolve(r);
                    else reject(new Error("createFolder error: " + d));
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("create folder timeout")); });
        req.on("error", (e) => reject(e));
        req.write(metadata);
        req.end();
    });
}

// Obtener o crear carpeta (idempotente)
async function driveGetOrCreateFolder(accessToken, name, parentId) {
    const existing = await driveListFolder(accessToken, name, parentId);
    if (existing.length > 0) {
        return existing[0].id;
    }
    const created = await driveCreateFolder(accessToken, name, parentId);
    return created.id;
}

// Subir video a Drive (multipart upload)
function driveUploadFile(accessToken, videoBuffer, filename, folderId) {
    return new Promise((resolve, reject) => {
        const boundary = "----DriveBoundary" + Date.now().toString(36);
        const CRLF = "\r\n";
        const metadata = JSON.stringify({ name: filename, parents: [folderId] });

        const preamble = Buffer.from(
            "--" + boundary + CRLF +
            "Content-Type: application/json; charset=UTF-8" + CRLF + CRLF +
            metadata + CRLF +
            "--" + boundary + CRLF +
            "Content-Type: video/mp4" + CRLF + CRLF
        );
        const postamble = Buffer.from(CRLF + "--" + boundary + "--" + CRLF);
        const body = Buffer.concat([preamble, videoBuffer, postamble]);

        const req = https.request({
            hostname: "www.googleapis.com",
            path: "/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink",
            method: "POST",
            headers: {
                Authorization: "Bearer " + accessToken,
                "Content-Type": "multipart/related; boundary=" + boundary,
                "Content-Length": body.length,
            },
            timeout: 600000, // 10 min para videos grandes
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.id) resolve(r);
                    else reject(new Error("Drive upload error: " + d));
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("Drive upload timeout")); });
        req.on("error", (e) => reject(e));
        req.write(body);
        req.end();
    });
}

// Hacer el archivo público (anyone with link, reader)
function driveSetPublic(accessToken, fileId) {
    return new Promise((resolve, reject) => {
        const permission = JSON.stringify({ type: "anyone", role: "reader" });
        const req = https.request({
            hostname: "www.googleapis.com",
            path: "/drive/v3/files/" + fileId + "/permissions",
            method: "POST",
            headers: {
                Authorization: "Bearer " + accessToken,
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(permission),
            },
            timeout: 15000,
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    resolve(r);
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("setPublic timeout")); });
        req.on("error", (e) => reject(e));
        req.write(permission);
        req.end();
    });
}

// Obtener webViewLink de un archivo (para link compartible)
function driveGetFileLink(accessToken, fileId) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: "www.googleapis.com",
            path: "/drive/v3/files/" + fileId + "?fields=webViewLink",
            method: "GET",
            headers: { Authorization: "Bearer " + accessToken },
            timeout: 10000,
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    resolve(r.webViewLink || "");
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("getFileLink timeout")); });
        req.on("error", (e) => reject(e));
        req.end();
    });
}

// Subir video completo a Google Drive: auth + carpetas + upload + permisos
async function uploadToDrive(videoBuffer, filename, issueNumber, issueTitle, sprintId) {
    const credentials = loadDriveCredentials();
    const accessToken = await getGoogleAccessToken(credentials);

    // Carpeta raíz configurada (ej. ID de "Intrale QA" en Drive)
    const rootFolderId = DRIVE_FOLDER_ID;

    // Estructura: rootFolderId / SPR-XXXX / #issue-titulo /
    const sprintFolder = sprintId || "QA";
    const issueFolder = issueTitle
        ? "#" + issueNumber + "-" + issueTitle.replace(/[/\\?%*:|"<>]/g, "-").slice(0, 40)
        : "#" + issueNumber;

    console.log("[qa-video-share] Drive: creando estructura " + sprintFolder + " / " + issueFolder);
    const sprintFolderId = await driveGetOrCreateFolder(accessToken, sprintFolder, rootFolderId);
    const issueFolderId = await driveGetOrCreateFolder(accessToken, issueFolder, sprintFolderId);

    console.log("[qa-video-share] Drive: subiendo " + filename + " (" + formatSize(videoBuffer.length) + ")...");
    const uploaded = await driveUploadFile(accessToken, videoBuffer, filename, issueFolderId);
    await driveSetPublic(accessToken, uploaded.id);

    // Preferir webViewLink (abre el video en el navegador)
    let driveLink = uploaded.webViewLink;
    if (!driveLink) {
        driveLink = await driveGetFileLink(accessToken, uploaded.id);
    }
    if (!driveLink) {
        driveLink = "https://drive.google.com/file/d/" + uploaded.id + "/view";
    }
    return driveLink;
}

// Actualizar video_url en qa-report.json
function updateQaReport(issueNumber, videoUrl) {
    const PROJECT_ROOT = path.resolve(__dirname, "../..");
    const reportPath = path.join(PROJECT_ROOT, "qa", "evidence", String(issueNumber), "qa-report.json");
    if (!fs.existsSync(reportPath)) return;
    try {
        const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
        report.video_url = videoUrl;
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
        console.log("[qa-video-share] qa-report.json actualizado con video_url");
    } catch (e) {
        console.error("[qa-video-share] No se pudo actualizar qa-report.json:", e.message);
    }
}

// --- Cloudflare R2: upload con presigned URL (S3-compatible, Node.js puro) ---

function r2Available() {
    return R2_CONFIG.accountId && R2_CONFIG.accessKeyId && R2_CONFIG.secretAccessKey;
}

function hmacSha256(key, data) {
    return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data) {
    return crypto.createHash("sha256").update(data).digest("hex");
}

// AWS Signature V4 para PUT en R2 (compatible S3)
function uploadToR2(videoBuffer, objectKey) {
    return new Promise((resolve, reject) => {
        const host = R2_CONFIG.accountId + ".r2.cloudflarestorage.com";
        const region = "auto";
        const service = "s3";
        const now = new Date();
        const dateStamp = now.toISOString().replace(/[-:]/g, "").slice(0, 8);
        const amzDate = dateStamp + "T" + now.toISOString().replace(/[-:]/g, "").slice(9, 15) + "Z";
        const contentHash = sha256Hex(videoBuffer);

        const canonicalUri = "/" + R2_CONFIG.bucket + "/" + objectKey;
        const canonicalQueryString = "";
        const canonicalHeaders =
            "content-type:video/mp4\n" +
            "host:" + host + "\n" +
            "x-amz-content-sha256:" + contentHash + "\n" +
            "x-amz-date:" + amzDate + "\n";
        const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";

        const canonicalRequest = [
            "PUT", canonicalUri, canonicalQueryString,
            canonicalHeaders, signedHeaders, contentHash,
        ].join("\n");

        const credentialScope = dateStamp + "/" + region + "/" + service + "/aws4_request";
        const stringToSign = [
            "AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest),
        ].join("\n");

        let signingKey = hmacSha256("AWS4" + R2_CONFIG.secretAccessKey, dateStamp);
        signingKey = hmacSha256(signingKey, region);
        signingKey = hmacSha256(signingKey, service);
        signingKey = hmacSha256(signingKey, "aws4_request");
        const signature = crypto.createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

        const authHeader = "AWS4-HMAC-SHA256 Credential=" + R2_CONFIG.accessKeyId + "/" + credentialScope +
            ", SignedHeaders=" + signedHeaders + ", Signature=" + signature;

        const req = https.request({
            hostname: host,
            path: canonicalUri,
            method: "PUT",
            headers: {
                "Content-Type": "video/mp4",
                "Content-Length": videoBuffer.length,
                "Host": host,
                "x-amz-content-sha256": contentHash,
                "x-amz-date": amzDate,
                "Authorization": authHeader,
            },
            timeout: 300000, // 5 min para uploads grandes
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve({ key: objectKey, status: res.statusCode });
                } else {
                    reject(new Error("R2 upload failed: " + res.statusCode + " " + d));
                }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("R2 upload timeout")); });
        req.on("error", (e) => reject(e));
        req.write(videoBuffer);
        req.end();
    });
}

// Generar presigned GET URL para R2
function generateR2PresignedUrl(objectKey) {
    const host = R2_CONFIG.accountId + ".r2.cloudflarestorage.com";
    const region = "auto";
    const service = "s3";
    const now = new Date();
    const dateStamp = now.toISOString().replace(/[-:]/g, "").slice(0, 8);
    const amzDate = dateStamp + "T" + now.toISOString().replace(/[-:]/g, "").slice(9, 15) + "Z";
    const credentialScope = dateStamp + "/" + region + "/" + service + "/aws4_request";
    const credential = R2_CONFIG.accessKeyId + "/" + credentialScope;

    const canonicalUri = "/" + R2_CONFIG.bucket + "/" + objectKey;
    const queryParams = [
        "X-Amz-Algorithm=AWS4-HMAC-SHA256",
        "X-Amz-Credential=" + encodeURIComponent(credential),
        "X-Amz-Date=" + amzDate,
        "X-Amz-Expires=" + R2_PRESIGNED_EXPIRY_SECONDS,
        "X-Amz-SignedHeaders=host",
    ].sort().join("&");

    const canonicalRequest = [
        "GET", canonicalUri, queryParams,
        "host:" + host + "\n", "host", "UNSIGNED-PAYLOAD",
    ].join("\n");

    const stringToSign = [
        "AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest),
    ].join("\n");

    let signingKey = hmacSha256("AWS4" + R2_CONFIG.secretAccessKey, dateStamp);
    signingKey = hmacSha256(signingKey, region);
    signingKey = hmacSha256(signingKey, service);
    signingKey = hmacSha256(signingKey, "aws4_request");
    const signature = crypto.createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

    return "https://" + host + canonicalUri + "?" + queryParams + "&X-Amz-Signature=" + signature;
}

// --- Retry wrapper ---

async function withRetry(fn, label) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await fn();
        } catch (e) {
            console.error("[qa-video-share] " + label + " intento " + attempt + "/" + MAX_RETRIES + ": " + e.message);
            if (attempt < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            } else {
                throw e;
            }
        }
    }
}

// --- Formateo de tamanio ---

function formatSize(bytes) {
    if (bytes < 1024) return bytes + "B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "KB";
    return (bytes / (1024 * 1024)).toFixed(1) + "MB";
}

// --- Leer sprint activo desde roadmap.json (fallback si no se pasa --sprint) ---

function readActiveSprint() {
    try {
        const roadmapPath = path.resolve(__dirname, "../../scripts/roadmap.json");
        const roadmap = JSON.parse(fs.readFileSync(roadmapPath, "utf8"));
        const active = (roadmap.sprints || []).find(s => s.status === "active");
        return active ? active.id : "";
    } catch (e) {
        return "";
    }
}

// --- Main ---

async function main() {
    const data = parseArgs();

    if (!BOT_TOKEN || !CHAT_ID) {
        console.error("[qa-video-share] Telegram no configurado");
        process.exit(1);
    }

    const videoPaths = data.videos.split(",").filter(v => v.trim());
    if (videoPaths.length === 0) {
        console.log("[qa-video-share] No hay videos para compartir");
        process.exit(0);
    }

    // Resolución del sprint: parámetro > roadmap.json
    const sprintId = data.sprint || readActiveSprint();

    const verdictIcon = data.verdict === "APROBADO" ? "\u2705" : "\u274C";
    const timestamp = new Date().toLocaleString("es-AR", {
        day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });

    console.log("[qa-video-share] Distribuyendo " + videoPaths.length + " video(s) para issue #" + data.issue);
    if (driveAvailable()) {
        console.log("[qa-video-share] Modo: Google Drive → Telegram link");
    } else {
        // Drive no configurado — bloquear en vez de fallback silencioso.
        // La evidencia de QA debe quedar persistida en Drive, no solo en Telegram.
        console.error("[qa-video-share] ERROR: Google Drive no configurado.");
        console.error("[qa-video-share] Sin Drive, la evidencia de video se pierde.");
        console.error("[qa-video-share] Configurar OAuth con: node scripts/google-drive-oauth-setup.js <CLIENT_ID> <CLIENT_SECRET>");
        console.error("[qa-video-share] O definir google_oauth_* en .claude/hooks/telegram-config.json");
        // Enviar alerta a Telegram y fallar
        try {
            await sendTelegramMessage(
                "⚠️ *QA Evidence BLOQUEADO* — Issue #" + data.issue + "\n" +
                "Google Drive no configurado. " + videoPaths.length + " video(s) sin persistir.\n" +
                "Ejecutar setup OAuth para desbloquear pipeline."
            );
        } catch (e) {}
        process.exit(2); // Exit code 2 = Drive no disponible
    }

    let sent = 0;
    let failed = 0;
    let firstDriveUrl = "";

    for (const videoPath of videoPaths) {
        const fullPath = path.resolve(videoPath.trim());
        if (!fs.existsSync(fullPath)) {
            console.error("[qa-video-share] Video no encontrado: " + fullPath);
            failed++;
            continue;
        }

        const stats = fs.statSync(fullPath);
        const filename = path.basename(fullPath);
        const sizeStr = formatSize(stats.size);
        const hasNarration = filename.includes("-narrated");
        const audioTag = hasNarration ? " \uD83D\uDD0A con narracion" : "";

        // ── Nivel 1: Google Drive ──────────────────────────────────────────
        if (driveAvailable()) {
            console.log("[qa-video-share] " + filename + " (" + sizeStr + ") -> Google Drive");
            try {
                const videoBuffer = fs.readFileSync(fullPath);
                const driveLink = await withRetry(
                    () => uploadToDrive(videoBuffer, filename, data.issue, data.title, sprintId),
                    "Drive upload " + filename
                );

                // Guardar primer link de Drive para qa-report.json
                if (!firstDriveUrl) {
                    firstDriveUrl = driveLink;
                    updateQaReport(data.issue, driveLink);
                }

                // Mensaje Telegram con formato del issue #1805
                const issueLabel = data.title
                    ? "QA #" + data.issue + ": " + data.title
                    : "QA #" + data.issue;
                const repoReportPath = "qa/evidence/" + data.issue + "/qa-report.json";
                const message =
                    "\uD83D\uDCF9 *" + issueLabel + "*\n" +
                    verdictIcon + " " + data.verdict + " | " + data.passed + "/" + data.total + " test cases" + audioTag + "\n" +
                    "\uD83C\uDFAC Video: [Ver en Google Drive](" + driveLink + ")\n" +
                    "\uD83D\uDCCB Reporte: `" + repoReportPath + "`\n" +
                    "\uD83D\uDD52 " + timestamp;

                await withRetry(() => sendTelegramMessage(message), "sendMessage Drive link " + filename);
                console.log("[qa-video-share] " + filename + " subido a Drive, link enviado OK");
                sent++;
            } catch (e) {
                console.error("[qa-video-share] Drive fallo para " + filename + ": " + e.message);
                console.error("[qa-video-share] ERROR: No se pudo subir evidencia a Drive. Pipeline fallido.");
                // Notificar el fallo a Telegram
                try {
                    await sendTelegramMessage(
                        "❌ *Drive Upload FALLIDO* — Issue #" + data.issue + "\n" +
                        "Video: `" + filename + "` (" + sizeStr + ")\n" +
                        "Error: " + e.message.substring(0, 200)
                    );
                } catch (e2) {}
                failed++;
            }
            continue;
        }

        // ── Fallback cuando Drive no está configurado ──────────────────────
        await sendFallback(filename, fullPath, stats, sizeStr, data, verdictIcon, timestamp);
        sent++;
    }

    // Resumen final
    console.log("[qa-video-share] Resultado: " + sent + " enviados, " + failed + " fallidos de " + videoPaths.length + " totales");

    if (failed > 0 && sent === 0) {
        process.exit(1);
    }
}

// Flujo de envío fallback (Telegram directo o R2)
async function sendFallback(filename, fullPath, stats, sizeStr, data, verdictIcon, timestamp) {
    const hasNarration = filename.includes("-narrated");
    const audioTag = hasNarration ? " \uD83D\uDD0A Con narracion" : " \uD83D\uDD07 Sin audio";
    const caption =
        verdictIcon + " *QA Evidence* \u2014 Issue #" + data.issue + "\n" +
        "\uD83C\uDFAC `" + filename + "` (" + sizeStr + ")" + audioTag + "\n" +
        "\uD83D\uDCCA Tests: " + data.passed + "/" + data.total + " pasaron\n" +
        "\uD83D\uDD52 " + timestamp;

    if (stats.size <= TELEGRAM_MAX_VIDEO_SIZE) {
        // Envio directo por Telegram
        console.log("[qa-video-share] " + filename + " (" + sizeStr + ") -> Telegram sendVideo");
        try {
            const videoBuffer = fs.readFileSync(fullPath);
            await withRetry(() => sendTelegramVideo(videoBuffer, filename, caption), "sendVideo " + filename);
            console.log("[qa-video-share] " + filename + " enviado OK");
        } catch (e) {
            console.error("[qa-video-share] Fallo sendVideo " + filename + ": " + e.message);
            try {
                await sendTelegramMessage(caption + "\n\n\u26A0 _Video no se pudo enviar directamente (" + sizeStr + ")_");
            } catch (e2) {
                throw e2;
            }
        }
    } else if (r2Available()) {
        // R2 para videos > 50MB
        console.log("[qa-video-share] " + filename + " (" + sizeStr + ") -> R2 upload + link Telegram");
        const objectKey = "qa/issue-" + data.issue + "/" + filename;
        const videoBuffer = fs.readFileSync(fullPath);
        await withRetry(() => uploadToR2(videoBuffer, objectKey), "R2 upload " + filename);
        const presignedUrl = generateR2PresignedUrl(objectKey);
        const linkCaption =
            caption + "\n\n" +
            "\uD83D\uDD17 [Descargar video](" + presignedUrl + ")\n" +
            "_Link valido por 7 dias_";
        await withRetry(() => sendTelegramMessage(linkCaption), "sendMessage link " + filename);
        console.log("[qa-video-share] " + filename + " subido a R2, link enviado OK");
    } else {
        // Video > 50MB, sin Drive ni R2: texto solamente
        console.log("[qa-video-share] " + filename + " (" + sizeStr + ") excede 50MB, Drive/R2 no configurado -> texto");
        await sendTelegramMessage(
            caption + "\n\n" +
            "\u26A0 _Video " + sizeStr + " requiere configurar Google Drive o Cloudflare R2._\n" +
            "_Ruta local: `" + fullPath + "`_"
        );
    }
}

main().catch(e => {
    console.error("[qa-video-share] Error fatal:", e.message);
    process.exit(1);
});
