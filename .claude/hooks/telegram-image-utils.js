// telegram-image-utils.js — Utilidades compartidas para imágenes PNG en Telegram
// Pure Node.js. canvas es una dependencia opcional (try/catch en require).
// Exporta: { renderTextAsPng, sendTelegramPhoto }

const https = require("https");

// Canvas opcional — si no está disponible, renderTextAsPng devuelve null
let createCanvas = null;
try { createCanvas = require("canvas").createCanvas; } catch(e) { /* canvas no disponible */ }

// Colores del tema oscuro (Catppuccin Mocha)
const COLORS = {
    BG: "#1E1E2E",
    TEXT: "#CDD6F4",
    DIM: "#6C7086",
    ACCENT: "#B4BEFE",
};

const FONT_SIZE = 13;
const FONT_FAMILY = "monospace";
const CANVAS_WIDTH = 800;
const PADDING = 16;
const LINE_HEIGHT = FONT_SIZE + 5;
// Máximo de caracteres por línea antes de hacer wrap (ajustado a ~100 chars a 800px con fuente 13px monospace)
const MAX_CHARS_PER_LINE = 100;

/**
 * Divide un texto en líneas, respetando saltos de línea existentes
 * y haciendo wrap automático cada MAX_CHARS_PER_LINE caracteres.
 * @param {string} text
 * @returns {string[]}
 */
function wrapText(text) {
    const rawLines = text.split("\n");
    const result = [];
    for (const rawLine of rawLines) {
        if (rawLine.length <= MAX_CHARS_PER_LINE) {
            result.push(rawLine);
        } else {
            // Wrap en trozos de MAX_CHARS_PER_LINE
            let remaining = rawLine;
            while (remaining.length > MAX_CHARS_PER_LINE) {
                // Intentar cortar en el último espacio dentro del límite
                let cutAt = MAX_CHARS_PER_LINE;
                const lastSpace = remaining.lastIndexOf(" ", MAX_CHARS_PER_LINE);
                if (lastSpace > MAX_CHARS_PER_LINE * 0.6) cutAt = lastSpace;
                result.push(remaining.substring(0, cutAt));
                remaining = remaining.substring(cutAt).replace(/^ /, "");
            }
            if (remaining.length > 0) result.push(remaining);
        }
    }
    return result;
}

/**
 * Renderiza texto plano como imagen PNG con fondo oscuro y fuente monoespaciada.
 * Útil para enviar resúmenes largos a Telegram cuando superan el límite de texto.
 *
 * @param {string} text  Texto a renderizar (puede incluir tablas markdown en ASCII)
 * @param {object} [options]
 * @param {number} [options.width]       Ancho del canvas (default 800)
 * @param {number} [options.fontSize]    Tamaño de fuente (default 13)
 * @param {string} [options.bgColor]     Color de fondo (default #1E1E2E)
 * @param {string} [options.textColor]   Color de texto (default #CDD6F4)
 * @returns {Buffer|null}  Buffer PNG, o null si canvas no está disponible
 */
function renderTextAsPng(text, options) {
    if (!createCanvas) return null;

    options = options || {};
    const w = options.width || CANVAS_WIDTH;
    const fontSize = options.fontSize || FONT_SIZE;
    const bgColor = options.bgColor || COLORS.BG;
    const textColor = options.textColor || COLORS.TEXT;
    const lineHeight = fontSize + 5;
    const padding = PADDING;

    const lines = wrapText(text || "");
    const contentH = lines.length * lineHeight;
    const h = Math.max(80, contentH + padding * 2);

    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext("2d");

    // Fondo
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, w, h);

    // Texto
    ctx.font = fontSize + "px " + FONT_FAMILY;
    ctx.fillStyle = textColor;
    ctx.textBaseline = "top";

    for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], padding, padding + i * lineHeight);
    }

    return canvas.toBuffer("image/png");
}

/**
 * Envía una imagen PNG a Telegram via sendPhoto (multipart/form-data).
 * Firma parametrizada para ser usada tanto desde stop-notify.js como desde dashboard.js.
 *
 * @param {string} botToken      Token del bot de Telegram
 * @param {string} chatId        ID del chat de destino
 * @param {Buffer} imageBuffer   Buffer PNG a enviar
 * @param {string} [caption]     Texto corto que acompaña la imagen (opcional)
 * @returns {Promise<object>}    Resultado de la API de Telegram
 */
function sendTelegramPhoto(botToken, chatId, imageBuffer, caption) {
    return new Promise((resolve, reject) => {
        const boundary = "----TgImgBoundary" + Date.now().toString(36);
        const CRLF = "\r\n";

        let textParts = "";
        textParts += "--" + boundary + CRLF;
        textParts += "Content-Disposition: form-data; name=\"chat_id\"" + CRLF + CRLF;
        textParts += chatId + CRLF;

        if (caption) {
            textParts += "--" + boundary + CRLF;
            textParts += "Content-Disposition: form-data; name=\"caption\"" + CRLF + CRLF;
            textParts += caption + CRLF;
        }

        const preFile = Buffer.from(
            textParts +
            "--" + boundary + CRLF +
            "Content-Disposition: form-data; name=\"photo\"; filename=\"summary.png\"" + CRLF +
            "Content-Type: image/png" + CRLF + CRLF
        );
        const postFile = Buffer.from(CRLF + "--" + boundary + "--" + CRLF);
        const fullBody = Buffer.concat([preFile, imageBuffer, postFile]);

        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + botToken + "/sendPhoto",
            method: "POST",
            headers: {
                "Content-Type": "multipart/form-data; boundary=" + boundary,
                "Content-Length": fullBody.length,
            },
            timeout: 15000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.ok) resolve(r);
                    else reject(new Error(d));
                } catch(e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.on("error", (e) => reject(e));
        req.write(fullBody);
        req.end();
    });
}

module.exports = { renderTextAsPng, sendTelegramPhoto };
