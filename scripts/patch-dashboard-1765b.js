#!/usr/bin/env node
// Patch script 1765b — /screenshot endpoint + route param

const fs = require('fs');
const path = require('path');

const WT = path.resolve(__dirname, '..');

// ─── Patch dashboard-server.js: /screenshot accepts ?route= param ────────────
const dashSrc = path.join(WT, '.claude', 'dashboard-server.js');
let dc = fs.readFileSync(dashSrc, 'utf8');

const OLD_SCREENSHOT = `  } else if (pathname === "/screenshot") {
    const width = parseInt(url.searchParams.get("w")) || 375;
    const height = parseInt(url.searchParams.get("h")) || 640;
    takeScreenshot(width, height).then(buf => {
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
      res.end(buf);
    }).catch(err => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Screenshot error: " + err.message + "\\nInstall puppeteer: npm install puppeteer");
    });`;

const NEW_SCREENSHOT = `  } else if (pathname === "/screenshot") {
    const width = parseInt(url.searchParams.get("w")) || 375;
    const height = parseInt(url.searchParams.get("h")) || 640;
    // route param para screenshot de sección específica (#1765)
    const routeParam = url.searchParams.get("route") || null;
    const screenshotOpts = routeParam ? { targetPath: routeParam } : {};
    takeScreenshot(width, height, screenshotOpts).then(buf => {
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
      res.end(buf);
    }).catch(err => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Screenshot error: " + err.message + "\\nInstall puppeteer: npm install puppeteer");
    });`;

if (!dc.includes(OLD_SCREENSHOT)) {
  console.error('Screenshot handler not found'); process.exit(1);
}
dc = dc.replace(OLD_SCREENSHOT, NEW_SCREENSHOT);
console.log('p7 (/screenshot route param):', dc.includes('routeParam'));
fs.writeFileSync(dashSrc, dc, 'utf8');
console.log('dashboard-server.js updated');

// ─── Patch command-dispatcher.js ──────────────────────────────────────────────
const dispSrc = path.join(WT, '.claude', 'hooks', 'commander', 'command-dispatcher.js');
let disp = fs.readFileSync(dispSrc, 'utf8');

// Add /dash-* parsing in parseCommand (before the generic startsWith("/") block)
const OLD_PARSE = `    if (trimmed === "/reset-sprint" || trimmed === "/reset-sprint confirm") {
        return { type: "reset_sprint", confirmed: trimmed === "/reset-sprint confirm" };
    }

    if (trimmed.startsWith("/")) {`;

const NEW_PARSE = `    if (trimmed === "/reset-sprint" || trimmed === "/reset-sprint confirm") {
        return { type: "reset_sprint", confirmed: trimmed === "/reset-sprint confirm" };
    }

    // Comandos de dashboard por sección (#1765)
    const dashMatch = trimmed.match(/^\\/dash-(overview|flow|activity|roadmap|cicd|logs)$/);
    if (dashMatch) {
        return { type: "dash_section", section: dashMatch[1] };
    }

    if (trimmed.startsWith("/")) {`;

if (!disp.includes(OLD_PARSE)) {
  console.error('parseCommand target not found'); process.exit(1);
}
disp = disp.replace(OLD_PARSE, NEW_PARSE);
console.log('p_disp1 (dash parse):', disp.includes('dash_section'));

// Add handleDashSection function (before module.exports)
const OLD_EXPORTS = 'module.exports = {';
const DASH_FN = `// ─── Handler: /dash-* (#1765) ───────────────────────────────────────────────

const http = require("http");
const DASHBOARD_PORT_LOCAL = 3100;

async function handleDashSection(section) {
    const sectionLabels = {
        overview: "\\ud83d\\udcca Overview",
        flow: "\\ud83d\\udd00 Flujo de Agentes",
        activity: "\\ud83d\\udce1 Actividad & M\\u00e9tricas",
        roadmap: "\\ud83d\\uddfa\\ufe0f Roadmap",
        cicd: "\\u2699\\ufe0f CI/CD",
        logs: "\\ud83d\\udcc3 Logs en vivo",
    };
    const label = sectionLabels[section] || section;
    const route = "/" + section;
    const w = 800;
    const h = 600;

    await _tgApi.sendMessage("\\ud83d\\udcf8 Capturando " + label + "...");
    _log("handleDashSection: capturando " + route);

    const screenshotPromise = new Promise((resolve) => {
        const screenshotUrl = "http://localhost:" + DASHBOARD_PORT_LOCAL + "/screenshot?route=" + encodeURIComponent(route) + "&w=" + w + "&h=" + h;
        const req = http.get(screenshotUrl, { timeout: 20000 }, (res) => {
            if (res.statusCode !== 200) { resolve(null); return; }
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks)));
        });
        req.on("error", () => resolve(null));
        req.on("timeout", () => { req.destroy(); resolve(null); });
    });

    const buf = await screenshotPromise;
    if (buf && buf.length > 1000) {
        const ts = new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
        const caption = "\\ud83d\\udcca <b>Intrale Monitor \\u2014 " + _tgApi.escHtml(label) + "</b>\\n" + ts;
        await _tgApi.sendTelegramPhoto(buf, caption, false);
        _log("handleDashSection: enviado OK " + section + " (" + buf.length + " bytes)");
    } else {
        await _tgApi.sendMessage("\\u26a0\\ufe0f No se pudo capturar <b>" + _tgApi.escHtml(label) + "</b>.\\n\\u00bfEst\\u00e1 corriendo el dashboard en localhost:" + DASHBOARD_PORT_LOCAL + "?");
        _log("handleDashSection: screenshot fallido para " + section);
    }
}

`;

if (!disp.includes(OLD_EXPORTS)) {
  console.error('module.exports not found'); process.exit(1);
}
disp = disp.replace(OLD_EXPORTS, DASH_FN + OLD_EXPORTS);
console.log('p_disp2 (handleDashSection):', disp.includes('function handleDashSection('));

// Add handleDashSection to exports
const OLD_EXP_LIST = '    handleResetSprint,\n    CLEANUP_TTL_MS,\n};';
const NEW_EXP_LIST = '    handleResetSprint,\n    handleDashSection,\n    CLEANUP_TTL_MS,\n};';
if (!disp.includes(OLD_EXP_LIST)) {
  console.error('exports list not found'); process.exit(1);
}
disp = disp.replace(OLD_EXP_LIST, NEW_EXP_LIST);
console.log('p_disp3 (export):', disp.includes('handleDashSection,'));

fs.writeFileSync(dispSrc, disp, 'utf8');
console.log('command-dispatcher.js updated');

// ─── Patch telegram-commander.js ──────────────────────────────────────────────
const tgSrc = path.join(WT, '.claude', 'hooks', 'telegram-commander.js');
let tg = fs.readFileSync(tgSrc, 'utf8');

const OLD_CASE = `                    case "reset_sprint":
                        dispatcher.handleResetSprint(cmd.confirmed).catch(e => {
                            log("Error en handleResetSprint: " + e.message);
                            tgApi.sendMessage("❌ Error: <code>" + tgApi.escHtml(e.message) + "</code>").catch(() => {});
                        });
                        break;
                    case "unknown_command":`;

const NEW_CASE = `                    case "reset_sprint":
                        dispatcher.handleResetSprint(cmd.confirmed).catch(e => {
                            log("Error en handleResetSprint: " + e.message);
                            tgApi.sendMessage("❌ Error: <code>" + tgApi.escHtml(e.message) + "</code>").catch(() => {});
                        });
                        break;
                    case "dash_section":
                        // Comandos /dash-* — captura screenshot de sección del dashboard (#1765)
                        dispatcher.handleDashSection(cmd.section).catch(e => {
                            log("Error en handleDashSection: " + e.message);
                            tgApi.sendMessage("❌ Error capturando sección: <code>" + tgApi.escHtml(e.message) + "</code>").catch(() => {});
                        });
                        break;
                    case "unknown_command":`;

if (!tg.includes(OLD_CASE)) {
  console.error('switch case target not found in telegram-commander.js'); process.exit(1);
}
tg = tg.replace(OLD_CASE, NEW_CASE);
console.log('p_tg1 (dash_section case):', tg.includes('case "dash_section":'));
fs.writeFileSync(tgSrc, tg, 'utf8');
console.log('telegram-commander.js updated');

// ─── Also add /dash-* to /help message ────────────────────────────────────────
const OLD_HELP = '    msg += "  /reset-sprint — Resetear sprint al estado original\\n";';
const NEW_HELP = `    msg += "  /dash-overview — Screenshot del panel Overview\\n";
    msg += "  /dash-flow — Screenshot del Flujo de Agentes\\n";
    msg += "  /dash-activity — Screenshot de Actividad & Métricas\\n";
    msg += "  /dash-roadmap — Screenshot del Roadmap\\n";
    msg += "  /dash-cicd — Screenshot de CI/CD\\n";
    msg += "  /dash-logs — Screenshot de Logs en vivo\\n";
    msg += "  /reset-sprint — Resetear sprint al estado original\\n";`;

if (!disp.includes(OLD_HELP)) {
  console.log('WARN: help message target not found — skipping');
} else {
  disp = fs.readFileSync(dispSrc, 'utf8');
  disp = disp.replace(OLD_HELP, NEW_HELP);
  fs.writeFileSync(dispSrc, disp, 'utf8');
  console.log('p_disp4 (help updated):', true);
}

console.log('\nAll patches applied.');
