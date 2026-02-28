#!/usr/bin/env node
// delivery-report.js — Genera imagen PNG con resumen de delivery y la envía a Telegram
// Uso: node .claude/hooks/delivery-report.js --branch <branch> --pr <url> --pr-number <N>
//        --state <MERGED|ERROR> --commits "<lista>" --files "<lista con stats>"
//        --changes "<bullets de cambios>"
// Dependencia: canvas (npm) — si no está disponible, fallback a texto plano vía sendMessage.

const fs = require("fs");
const path = require("path");
const https = require("https");

// Canvas opcional
let createCanvas = null;
try { createCanvas = require("canvas").createCanvas; } catch (e) { /* canvas no disponible */ }

// Paleta Catppuccin Mocha (misma que dashboard.js)
const IMG = {
    BG: "#1E1E2E",
    PANEL_BG: "#2A2A3E",
    HEADER: "#CDD6F4",
    TEXT: "#BAC2DE",
    DIM: "#6C7086",
    GREEN: "#2ECC71",
    YELLOW: "#F1C40F",
    GRAY: "#7F8C8D",
    RED: "#E74C3C",
    CYAN: "#89B4FA",
    ACCENT: "#B4BEFE",
    BORDER: "#313244",
    SEP: "#45475A",
};

// Config Telegram
const CONFIG_PATH = path.join(__dirname, "telegram-config.json");
let BOT_TOKEN = "";
let CHAT_ID = "";
try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    BOT_TOKEN = cfg.bot_token || "";
    CHAT_ID = cfg.chat_id || "";
} catch (e) {
    console.error("[delivery-report] No se pudo leer telegram-config.json:", e.message);
}

const TMP_DIR = path.join(__dirname, "..", "tmp");
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;

// --- Argument parsing ---

function parseArgs() {
    const args = process.argv.slice(2);
    const result = {
        branch: "",
        pr: "",
        prNumber: "",
        state: "MERGED",
        commits: "",
        files: "",
        changes: "",
    };
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case "--branch": result.branch = args[++i] || ""; break;
            case "--pr": result.pr = args[++i] || ""; break;
            case "--pr-number": result.prNumber = args[++i] || ""; break;
            case "--state": result.state = (args[++i] || "MERGED").toUpperCase(); break;
            case "--commits": result.commits = args[++i] || ""; break;
            case "--files": result.files = args[++i] || ""; break;
            case "--changes": result.changes = args[++i] || ""; break;
        }
    }
    return result;
}

// --- Canvas helpers ---

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
}

function truncate(str, max) {
    if (!str) return "";
    return str.length > max ? str.substring(0, max - 1) + "\u2026" : str;
}

function wrapTextPixel(ctx, text, maxWidth) {
    const rawLines = text.split("\n");
    const result = [];
    for (const rawLine of rawLines) {
        if (rawLine.trim() === "") { result.push(""); continue; }
        if (ctx.measureText(rawLine).width <= maxWidth) { result.push(rawLine); continue; }
        const words = rawLine.split(" ");
        let current = "";
        for (const word of words) {
            const test = current ? current + " " + word : word;
            if (ctx.measureText(test).width <= maxWidth) {
                current = test;
            } else {
                if (current) result.push(current);
                current = word;
            }
        }
        if (current) result.push(current);
    }
    return result;
}

// --- PNG generation ---

function buildDeliveryImage(data) {
    if (!createCanvas) return null;

    const W = 800;
    const PAD = 24;
    const RADIUS = 10;

    const isError = data.state === "ERROR";
    const accentColor = isError ? IMG.RED : IMG.GREEN;
    const headerTitle = isError ? "Delivery fallido" : "Delivery completado";
    const headerIcon = isError ? "\u274C" : "\uD83D\uDE80";

    // Parse data
    const commitLines = (data.commits || "").split("\n").filter(l => l.trim());
    const fileLines = (data.files || "").split("\n").filter(l => l.trim());
    const changeLines = (data.changes || "").split("\n").filter(l => l.trim());

    // Timestamp
    const now = new Date();
    const timestamp = now.toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "numeric" }) +
        " " + now.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });

    // --- Pre-measure para calcular altura ---
    const tmpCanvas = createCanvas(1, 1);
    const tCtx = tmpCanvas.getContext("2d");

    // Medir cambios con wrap
    tCtx.font = "14px monospace";
    const maxTextW = W - PAD * 2 - 20;
    let wrappedChangeLines = [];
    for (const line of changeLines) {
        const wrapped = wrapTextPixel(tCtx, line, maxTextW);
        wrappedChangeLines = wrappedChangeLines.concat(wrapped);
    }

    // Calcular altura total
    const HEADER_H = 60;
    const TABLE_ROW_H = 28;
    const TABLE_ROWS = 3; // Branch, PR, Estado
    const tableH = TABLE_ROWS * TABLE_ROW_H + 16;
    const SECTION_TITLE_H = 28;
    const LINE_H = 22;

    const commitsH = commitLines.length > 0 ? SECTION_TITLE_H + commitLines.length * LINE_H + 12 : 0;
    const filesH = fileLines.length > 0 ? SECTION_TITLE_H + fileLines.length * LINE_H + 12 : 0;
    const changesH = wrappedChangeLines.length > 0 ? SECTION_TITLE_H + wrappedChangeLines.length * LINE_H + 12 : 0;
    const FOOTER_H = 44;

    const H = HEADER_H + 16 + tableH + commitsH + filesH + changesH + FOOTER_H + PAD;

    // --- Render ---
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d");
    ctx.textBaseline = "top";

    // Background
    ctx.fillStyle = IMG.BG;
    ctx.fillRect(0, 0, W, H);

    let y = 0;

    // === HEADER ===
    ctx.fillStyle = IMG.PANEL_BG;
    ctx.fillRect(0, y, W, HEADER_H);
    ctx.fillStyle = accentColor;
    ctx.fillRect(0, y + HEADER_H - 2, W, 2);

    ctx.font = "bold 20px monospace";
    ctx.fillStyle = accentColor;
    ctx.fillText(headerIcon + " " + headerTitle, PAD, y + 16);

    ctx.font = "13px monospace";
    ctx.fillStyle = IMG.DIM;
    ctx.fillText(timestamp + "  |  Claude Code", W - PAD - ctx.measureText(timestamp + "  |  Claude Code").width, y + 22);
    y += HEADER_H + 12;

    // === TABLA CAMPOS ===
    const tableX = PAD;
    const tableW = W - PAD * 2;
    const labelW = 100;

    // Fondo panel tabla
    roundRect(ctx, tableX - 8, y - 4, tableW + 16, tableH + 8, 8);
    ctx.fillStyle = IMG.PANEL_BG;
    ctx.fill();

    // Row: Branch
    ctx.font = "bold 14px monospace";
    ctx.fillStyle = IMG.ACCENT;
    ctx.fillText("Branch", tableX, y + 6);
    ctx.font = "14px monospace";
    ctx.fillStyle = IMG.CYAN;
    ctx.fillText(truncate(data.branch, 60), tableX + labelW, y + 6);
    y += TABLE_ROW_H;

    // Row: PR
    ctx.font = "bold 14px monospace";
    ctx.fillStyle = IMG.ACCENT;
    ctx.fillText("PR", tableX, y + 6);
    ctx.font = "14px monospace";
    ctx.fillStyle = IMG.TEXT;
    const prDisplay = data.prNumber ? "#" + data.prNumber + " " + truncate(data.pr, 50) : truncate(data.pr, 60);
    ctx.fillText(prDisplay, tableX + labelW, y + 6);
    y += TABLE_ROW_H;

    // Row: Estado
    ctx.font = "bold 14px monospace";
    ctx.fillStyle = IMG.ACCENT;
    ctx.fillText("Estado", tableX, y + 6);
    ctx.font = "bold 14px monospace";
    ctx.fillStyle = accentColor;
    ctx.fillText(data.state, tableX + labelW, y + 6);

    // Badge de estado (pill)
    const stateW = ctx.measureText(data.state).width;
    roundRect(ctx, tableX + labelW - 4, y + 2, stateW + 8, 20, 4);
    ctx.fillStyle = accentColor + "30"; // semi-transparente
    ctx.fill();
    ctx.fillStyle = accentColor;
    ctx.fillText(data.state, tableX + labelW, y + 6);
    y += TABLE_ROW_H + 16;

    // === COMMITS ===
    if (commitLines.length > 0) {
        ctx.fillStyle = IMG.SEP;
        ctx.fillRect(PAD, y, W - PAD * 2, 1);
        y += 8;

        ctx.font = "bold 14px monospace";
        ctx.fillStyle = IMG.ACCENT;
        ctx.fillText("COMMITS", PAD, y);
        y += SECTION_TITLE_H;

        ctx.font = "14px monospace";
        for (const line of commitLines) {
            // Hash en cyan, mensaje en texto normal
            const parts = line.match(/^([a-f0-9]+)\s+(.*)$/);
            if (parts) {
                ctx.fillStyle = IMG.CYAN;
                ctx.fillText(parts[1], PAD + 12, y);
                ctx.fillStyle = IMG.TEXT;
                ctx.fillText(truncate(parts[2], 65), PAD + 12 + ctx.measureText(parts[1] + "  ").width, y);
            } else {
                ctx.fillStyle = IMG.TEXT;
                ctx.fillText(truncate(line, 80), PAD + 12, y);
            }
            y += LINE_H;
        }
        y += 4;
    }

    // === ARCHIVOS ===
    if (fileLines.length > 0) {
        ctx.fillStyle = IMG.SEP;
        ctx.fillRect(PAD, y, W - PAD * 2, 1);
        y += 8;

        ctx.font = "bold 14px monospace";
        ctx.fillStyle = IMG.ACCENT;
        ctx.fillText("ARCHIVOS MODIFICADOS", PAD, y);
        y += SECTION_TITLE_H;

        ctx.font = "13px monospace";
        for (const line of fileLines) {
            // Detectar stats: +N/-M o "N insertions", "M deletions"
            const statsMatch = line.match(/(\d+)\s+insert|(\d+)\s+delet|\+(\d+)|-(\d+)/);
            const plusMatch = line.match(/\+(\d+)/);
            const minusMatch = line.match(/-(\d+)/);

            ctx.fillStyle = IMG.TEXT;
            ctx.fillText(truncate(line.replace(/\|.*$/, "").trim(), 55), PAD + 12, y);

            // Stats coloreados al final
            const statsX = W - PAD - 120;
            if (plusMatch) {
                ctx.fillStyle = IMG.GREEN;
                ctx.fillText("+" + plusMatch[1], statsX, y);
            }
            if (minusMatch) {
                ctx.fillStyle = IMG.RED;
                ctx.fillText("-" + minusMatch[1], statsX + 50, y);
            }
            y += LINE_H;
        }
        y += 4;
    }

    // === CAMBIOS ===
    if (wrappedChangeLines.length > 0) {
        ctx.fillStyle = IMG.SEP;
        ctx.fillRect(PAD, y, W - PAD * 2, 1);
        y += 8;

        ctx.font = "bold 14px monospace";
        ctx.fillStyle = IMG.ACCENT;
        ctx.fillText("CAMBIOS", PAD, y);
        y += SECTION_TITLE_H;

        ctx.font = "14px monospace";
        ctx.fillStyle = IMG.TEXT;
        for (const line of wrappedChangeLines) {
            if (line.startsWith("-") || line.startsWith("\u2022") || line.startsWith("*")) {
                ctx.fillStyle = IMG.GREEN;
                ctx.fillText("\u2022", PAD + 8, y);
                ctx.fillStyle = IMG.TEXT;
                ctx.fillText(truncate(line.replace(/^[-\u2022*]\s*/, ""), 75), PAD + 24, y);
            } else {
                ctx.fillStyle = IMG.TEXT;
                ctx.fillText(truncate(line, 80), PAD + 12, y);
            }
            y += LINE_H;
        }
        y += 4;
    }

    // === FOOTER ===
    ctx.fillStyle = IMG.SEP;
    ctx.fillRect(0, H - FOOTER_H, W, 1);

    ctx.font = "12px monospace";
    ctx.fillStyle = IMG.DIM;
    ctx.fillText("intrale/platform", PAD, H - FOOTER_H + 16);

    const botLabel = "\uD83E\uDD16 Claude Code";
    const botW = ctx.measureText(botLabel).width;
    ctx.fillText(botLabel, W - PAD - botW, H - FOOTER_H + 16);

    return canvas.toBuffer("image/png");
}

// --- Telegram ---

function sendTelegramPhoto(imageBuffer, caption) {
    return new Promise((resolve, reject) => {
        const boundary = "----DeliveryBoundary" + Date.now().toString(36);
        const CRLF = "\r\n";

        let textParts = "";
        textParts += "--" + boundary + CRLF;
        textParts += "Content-Disposition: form-data; name=\"chat_id\"" + CRLF + CRLF;
        textParts += CHAT_ID + CRLF;

        if (caption) {
            textParts += "--" + boundary + CRLF;
            textParts += "Content-Disposition: form-data; name=\"caption\"" + CRLF + CRLF;
            textParts += caption + CRLF;
        }

        const preFile = Buffer.from(
            textParts +
            "--" + boundary + CRLF +
            "Content-Disposition: form-data; name=\"photo\"; filename=\"delivery-report.png\"" + CRLF +
            "Content-Type: image/png" + CRLF + CRLF
        );
        const postFile = Buffer.from(CRLF + "--" + boundary + "--" + CRLF);
        const fullBody = Buffer.concat([preFile, imageBuffer, postFile]);

        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + BOT_TOKEN + "/sendPhoto",
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
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.on("error", (e) => reject(e));
        req.write(fullBody);
        req.end();
    });
}

function sendTelegramText(text) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            chat_id: CHAT_ID,
            text: text,
            parse_mode: "Markdown",
            disable_web_page_preview: true,
        });
        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + BOT_TOKEN + "/sendMessage",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
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
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.on("error", (e) => reject(e));
        req.write(payload);
        req.end();
    });
}

function buildTextFallback(data) {
    const icon = data.state === "ERROR" ? "\u274C" : "\uD83D\uDE80";
    const title = data.state === "ERROR" ? "Delivery fallido" : "Delivery completado";
    let msg = `${icon} *${title}*\n\n`;
    msg += `*Branch:* \`${data.branch}\`\n`;
    if (data.pr) msg += `*PR:* ${data.pr}\n`;
    msg += `*Estado:* ${data.state}\n`;
    if (data.commits) msg += `\n*Commits:*\n\`\`\`\n${data.commits}\n\`\`\`\n`;
    if (data.files) msg += `\n*Archivos:*\n\`\`\`\n${data.files}\n\`\`\`\n`;
    if (data.changes) msg += `\n*Cambios:*\n${data.changes}\n`;
    msg += `\n_intrale/platform_ | _Claude Code_`;
    return msg;
}

// --- Message registry ---

function registerMessage(messageId) {
    try {
        const registryPath = path.join(__dirname, "telegram-message-registry.js");
        if (fs.existsSync(registryPath)) {
            const registry = require(registryPath);
            if (typeof registry.register === "function") {
                registry.register(messageId, "delivery");
            }
        }
    } catch (e) { /* registro opcional */ }
}

// --- Main ---

async function main() {
    const data = parseArgs();

    if (!BOT_TOKEN || !CHAT_ID) {
        console.error("[delivery-report] Telegram no configurado (falta bot_token/chat_id)");
        process.exit(1);
    }

    if (!data.branch) {
        console.error("[delivery-report] Falta --branch");
        process.exit(1);
    }

    // Intentar generar PNG
    let pngBuffer = null;
    let pngPath = null;
    try {
        pngBuffer = buildDeliveryImage(data);
        if (pngBuffer) {
            // Guardar temporalmente
            if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
            pngPath = path.join(TMP_DIR, "delivery-report-" + Date.now() + ".png");
            fs.writeFileSync(pngPath, pngBuffer);
        }
    } catch (e) {
        console.error("[delivery-report] Error generando PNG:", e.message);
    }

    // Enviar a Telegram con reintentos
    const caption = (data.state === "ERROR" ? "\u274C" : "\uD83D\uDE80") +
        " Delivery " + (data.state === "ERROR" ? "fallido" : "completado") +
        " | " + data.branch +
        (data.prNumber ? " | PR #" + data.prNumber : "");

    let sent = false;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            if (pngBuffer) {
                const result = await sendTelegramPhoto(pngBuffer, caption);
                if (result && result.result && result.result.message_id) {
                    registerMessage(result.result.message_id);
                }
                sent = true;
                console.log("[delivery-report] PNG enviado a Telegram");
                break;
            } else {
                // Fallback a texto plano
                const text = buildTextFallback(data);
                const result = await sendTelegramText(text);
                if (result && result.result && result.result.message_id) {
                    registerMessage(result.result.message_id);
                }
                sent = true;
                console.log("[delivery-report] Texto fallback enviado a Telegram (canvas no disponible)");
                break;
            }
        } catch (e) {
            console.error("[delivery-report] Intento " + attempt + "/" + MAX_RETRIES + " falló:", e.message);
            if (attempt < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            }
        }
    }

    // Limpiar PNG temporal
    if (pngPath && fs.existsSync(pngPath)) {
        try { fs.unlinkSync(pngPath); } catch (e) { /* ignorar */ }
    }

    if (!sent) {
        console.error("[delivery-report] No se pudo enviar a Telegram después de " + MAX_RETRIES + " intentos");
        process.exit(1);
    }
}

main().catch(e => {
    console.error("[delivery-report] Error fatal:", e.message);
    process.exit(1);
});
