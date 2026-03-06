#!/usr/bin/env node
// qa-video-share.js — Distribuye videos de evidencia QA a stakeholders vía Telegram
//
// Uso:
//   node qa/scripts/qa-video-share.js \
//     --issue 1112 \
//     --videos "qa/recordings/maestro-shard-5554.mp4,qa/recordings/maestro-shard-5556.mp4" \
//     --verdict "APROBADO" \
//     --passed 3 --total 3
//
// Estrategia en 2 niveles:
//   1. Video <= 50MB → sendVideo directo por Telegram Bot API (costo $0, sin config extra)
//   2. Video > 50MB  → subir a Cloudflare R2 + enviar link por Telegram
//      (requiere R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET en env)
//
// Dependencias: ninguna (Node.js puro, https nativo)
// Config Telegram: lee de .claude/hooks/telegram-config.json (campos bot_token, chat_id/sponsor_chat_id)

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
try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    BOT_TOKEN = cfg.bot_token || "";
    // Preferir sponsor_chat_id si existe, fallback a chat_id
    CHAT_ID = cfg.sponsor_chat_id || cfg.chat_id || "";
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
    const result = { issue: "0", videos: "", verdict: "DESCONOCIDO", passed: "0", total: "0" };
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case "--issue": result.issue = args[++i] || "0"; break;
            case "--videos": result.videos = args[++i] || ""; break;
            case "--verdict": result.verdict = args[++i] || "DESCONOCIDO"; break;
            case "--passed": result.passed = args[++i] || "0"; break;
            case "--total": result.total = args[++i] || "0"; break;
        }
    }
    return result;
}

// --- Telegram: sendVideo (multipart/form-data, patron de telegram-image-utils.js) ---

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
            timeout: 120000, // 2 min para videos grandes
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

        // Signing key
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

// Generar presigned GET URL para R2 (AWS Signature V4 query string)
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

    const verdictIcon = data.verdict === "APROBADO" ? "\u2705" : "\u274C";
    const timestamp = new Date().toLocaleString("es-AR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

    console.log("[qa-video-share] Distribuyendo " + videoPaths.length + " video(s) para issue #" + data.issue);

    let sent = 0;
    let failed = 0;

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
        const audioTag = hasNarration ? " \uD83D\uDD0A Con narracion" : " \uD83D\uDD07 Sin audio";
        const caption =
            verdictIcon + " *QA Evidence* \u2014 Issue #" + data.issue + "\n" +
            "\uD83C\uDFAC `" + filename + "` (" + sizeStr + ")" + audioTag + "\n" +
            "\uD83D\uDCCA Tests: " + data.passed + "/" + data.total + " pasaron\n" +
            "\uD83D\uDD52 " + timestamp;

        if (stats.size <= TELEGRAM_MAX_VIDEO_SIZE) {
            // Nivel 1: envio directo por Telegram
            console.log("[qa-video-share] " + filename + " (" + sizeStr + ") -> Telegram sendVideo");
            try {
                const videoBuffer = fs.readFileSync(fullPath);
                await withRetry(() => sendTelegramVideo(videoBuffer, filename, caption), "sendVideo " + filename);
                console.log("[qa-video-share] " + filename + " enviado OK");
                sent++;
            } catch (e) {
                console.error("[qa-video-share] Fallo sendVideo " + filename + ": " + e.message);
                // Fallback: enviar mensaje de texto
                try {
                    await sendTelegramMessage(caption + "\n\n\u26A0 _Video no se pudo enviar directamente (" + sizeStr + ")_");
                    sent++;
                } catch (e2) {
                    failed++;
                }
            }
        } else if (r2Available()) {
            // Nivel 2: subir a R2 y enviar link
            console.log("[qa-video-share] " + filename + " (" + sizeStr + ") -> R2 upload + link Telegram");
            const objectKey = "qa/issue-" + data.issue + "/" + filename;
            try {
                const videoBuffer = fs.readFileSync(fullPath);
                await withRetry(() => uploadToR2(videoBuffer, objectKey), "R2 upload " + filename);
                const presignedUrl = generateR2PresignedUrl(objectKey);
                const linkCaption =
                    caption + "\n\n" +
                    "\uD83D\uDD17 [Descargar video](" + presignedUrl + ")\n" +
                    "_Link valido por 7 dias_";
                await withRetry(() => sendTelegramMessage(linkCaption), "sendMessage link " + filename);
                console.log("[qa-video-share] " + filename + " subido a R2, link enviado OK");
                sent++;
            } catch (e) {
                console.error("[qa-video-share] Fallo R2+Telegram " + filename + ": " + e.message);
                failed++;
            }
        } else {
            // R2 no configurado y video > 50MB: enviar solo texto
            console.log("[qa-video-share] " + filename + " (" + sizeStr + ") excede 50MB, R2 no configurado -> texto");
            try {
                await sendTelegramMessage(
                    caption + "\n\n" +
                    "\u26A0 _Video excede 50MB. Configurar Cloudflare R2 para compartir videos grandes._\n" +
                    "_Ruta local: `" + fullPath + "`_"
                );
                sent++;
            } catch (e) {
                failed++;
            }
        }
    }

    // Resumen final
    console.log("[qa-video-share] Resultado: " + sent + " enviados, " + failed + " fallidos de " + videoPaths.length + " totales");

    if (failed > 0 && sent === 0) {
        process.exit(1);
    }
}

main().catch(e => {
    console.error("[qa-video-share] Error fatal:", e.message);
    process.exit(1);
});
