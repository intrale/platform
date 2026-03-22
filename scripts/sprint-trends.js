#!/usr/bin/env node
// sprint-trends.js — Dashboard de tendencias cross-sprint para métricas de agentes
// Uso: node scripts/sprint-trends.js [--last N] [--json] [--check-alerts]
// Exporta: persistSprintRecord(), buildTrendsText(), buildTrendsHtmlSection(), checkAndSendAlerts()
// Issue: #1807

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

// --- Config ---
const REPO_ROOT = path.resolve(__dirname, "..");
const METRICS_DIR = path.join(__dirname, "metrics");
const SPRINT_HISTORY_FILE = path.join(METRICS_DIR, "sprint-history.jsonl");
const ROADMAP_FILE = path.join(__dirname, "roadmap.json");
const API_HISTORY_FILE = path.join(__dirname, "logs", "api-usage-history.jsonl");
const TELEGRAM_CONFIG = path.join(REPO_ROOT, ".claude", "hooks", "telegram-config.json");
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "sprint-trends.log");

// Umbrales de alerta (configurables)
const ALERT_SUCCESS_RATE_DROP_PCT = 20;   // Si tasa de éxito baja más del 20% respecto al promedio → alerta
const ALERT_COST_STORY_RISE_PCT = 30;     // Si costo/historia sube más del 30% respecto al promedio → alerta
const DEFAULT_LOOKBACK = 10;              // Sprints a mostrar por defecto

// --- Logging ---
function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(msg) {
    try {
        ensureDir(LOG_DIR);
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
    } catch (e) { /* ignore */ }
}

// --- I/O helpers ---
function readJson(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
        log(`Error leyendo ${filePath}: ${e.message}`);
        return null;
    }
}

function readJsonl(filePath) {
    try {
        if (!fs.existsSync(filePath)) return [];
        return fs.readFileSync(filePath, "utf8").trim().split("\n")
            .filter(l => l.trim())
            .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
            .filter(Boolean);
    } catch (e) {
        log(`Error leyendo JSONL ${filePath}: ${e.message}`);
        return [];
    }
}

// --- Telegram ---
function sendTelegram(message) {
    try {
        const cfg = readJson(TELEGRAM_CONFIG);
        if (!cfg || !cfg.bot_token || !cfg.chat_id) { log("telegram-config.json no disponible"); return; }
        const postData = JSON.stringify({
            chat_id: cfg.chat_id,
            text: message,
            parse_mode: "HTML",
            disable_notification: false
        });
        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + cfg.bot_token + "/sendMessage",
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
            timeout: 10000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => log("Telegram OK: " + d.substring(0, 80)));
        });
        req.on("error", (e) => log("Telegram error: " + e.message));
        req.write(postData);
        req.end();
    } catch (e) {
        log("Error enviando Telegram: " + e.message);
    }
}

// --- Bootstrap desde roadmap.json ---
// Crea registros históricos para sprints "done" del roadmap que no estén en sprint-history.jsonl.
function bootstrapFromRoadmap() {
    const roadmap = readJson(ROADMAP_FILE);
    if (!roadmap || !roadmap.sprints) return [];

    const existing = readJsonl(SPRINT_HISTORY_FILE);
    const existingIds = new Set(existing.map(r => r.sprint));

    // También leer datos de cotos de api-usage-history si existe
    const apiHistory = readJsonl(API_HISTORY_FILE);

    const newRecords = [];
    for (const sp of roadmap.sprints) {
        if (sp.status !== "done" && sp.status !== "closed") continue;
        if (existingIds.has(sp.id)) continue;

        const stories = sp.stories || [];
        const storiesDone = stories.filter(s => s.status === "done").length;
        const storiesFailed = stories.filter(s => s.status === "failed" || s.status === "moved").length;
        const storiesTotal = stories.length;

        // Buscar costos en api-usage-history para este sprint
        const sprintApiData = apiHistory.filter(e => e.sprint === sp.id);
        const costUsd = sprintApiData.length > 0
            ? sprintApiData.reduce((sum, e) => sum + (e.estimated_cost_usd || 0), 0)
            : null;
        const totalTokens = sprintApiData.length > 0
            ? sprintApiData.reduce((sum, e) => sum + (e.input_tokens || 0) + (e.output_tokens || 0), 0)
            : null;
        const avgDurationMin = sprintApiData.length > 0
            ? Math.round(sprintApiData.reduce((sum, e) => sum + (e.duration_min || 0), 0) / sprintApiData.length)
            : null;

        const record = {
            sprint: sp.id,
            closed_at: sp.closed_at || sp.started_at || null,
            stories_total: storiesTotal,
            stories_done: storiesDone,
            stories_failed: storiesFailed,
            agents_launched: storiesTotal,
            agents_ok: storiesDone,
            avg_duration_min: avgDurationMin,
            total_tokens: totalTokens,
            cost_usd: costUsd !== null ? parseFloat(costUsd.toFixed(4)) : null,
            _source: "roadmap_bootstrap"
        };
        newRecords.push(record);
    }

    if (newRecords.length > 0) {
        ensureDir(METRICS_DIR);
        // Ordenar por sprint ID antes de escribir
        newRecords.sort((a, b) => (a.sprint || "").localeCompare(b.sprint || ""));
        for (const r of newRecords) {
            fs.appendFileSync(SPRINT_HISTORY_FILE, JSON.stringify(r) + "\n");
        }
        log(`Bootstrap: ${newRecords.length} sprints importados desde roadmap.json`);
    }
    return newRecords;
}

// --- Persistir registro de sprint al cierre ---
// Llamado por sprint-report.js cuando cierra un sprint.
function persistSprintRecord(plan, issueInfos, mergedPRs, apiHistory) {
    try {
        ensureDir(METRICS_DIR);

        const sprintId = plan.sprint_id || ("sprint-" + (plan.started_at || "").split("T")[0]);
        const allStories = [
            ...(plan.agentes || []),
            ...(plan._completed || []),
            ...(plan._incomplete || []),
            ...(plan._queue || [])
        ];

        const storiesDone = allStories.filter(a => {
            const info = issueInfos[a.issue] || {};
            return info.state === "CLOSED";
        }).length;
        const storiesTotal = allStories.length;
        const storiesFailed = storiesTotal - storiesDone;
        const agentsLaunched = storiesTotal;
        const agentsOk = storiesDone;

        // Costos desde api-usage-history filtrado por sprint
        const sprintApi = (apiHistory || []).filter(e => e.sprint === sprintId);
        const costUsd = sprintApi.length > 0
            ? parseFloat(sprintApi.reduce((sum, e) => sum + (e.estimated_cost_usd || 0), 0).toFixed(4))
            : null;
        const totalTokens = sprintApi.length > 0
            ? sprintApi.reduce((sum, e) => sum + (e.input_tokens || 0) + (e.output_tokens || 0), 0)
            : null;
        const avgDurationMin = sprintApi.length > 0
            ? Math.round(sprintApi.reduce((sum, e) => sum + (e.duration_min || 0), 0) / sprintApi.length)
            : null;

        const record = {
            sprint: sprintId,
            closed_at: plan.closed_at || new Date().toISOString(),
            stories_total: storiesTotal,
            stories_done: storiesDone,
            stories_failed: storiesFailed,
            agents_launched: agentsLaunched,
            agents_ok: agentsOk,
            avg_duration_min: avgDurationMin,
            total_tokens: totalTokens,
            cost_usd: costUsd,
            _source: "sprint_report"
        };

        // Evitar duplicados: solo escribir si no existe ya el sprint en el JSONL
        const existing = readJsonl(SPRINT_HISTORY_FILE);
        if (existing.some(r => r.sprint === sprintId)) {
            log(`Sprint ${sprintId} ya existe en sprint-history.jsonl — no se duplica`);
            return record;
        }

        fs.appendFileSync(SPRINT_HISTORY_FILE, JSON.stringify(record) + "\n");
        log(`Sprint ${sprintId} persistido en sprint-history.jsonl`);
        return record;
    } catch (e) {
        log("Error persistiendo sprint record: " + e.message);
        return null;
    }
}

// --- Cargar historial (con bootstrap automático si es necesario) ---
function loadHistory(nSprints) {
    // Bootstrap si no existe el archivo o está vacío
    const existing = readJsonl(SPRINT_HISTORY_FILE);
    if (existing.length === 0) {
        log("sprint-history.jsonl vacío — ejecutando bootstrap desde roadmap.json");
        bootstrapFromRoadmap();
    } else {
        // Bootstrap incremental: agrega sprints nuevos del roadmap si faltan
        bootstrapFromRoadmap();
    }

    const all = readJsonl(SPRINT_HISTORY_FILE);
    // Ordenar por sprint ID (SPR-NNNN orden natural)
    all.sort((a, b) => (a.sprint || "").localeCompare(b.sprint || ""));

    // Retornar los últimos N
    return nSprints > 0 ? all.slice(-nSprints) : all;
}

// --- Sparkline ASCII ---
// Chars de menor a mayor: ▁▂▃▄▅▆▇█
const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

function sparkline(values) {
    const nums = values.map(v => (v === null || v === undefined || isNaN(v)) ? null : Number(v));
    const valid = nums.filter(v => v !== null);
    if (valid.length === 0) return "—";
    const min = Math.min(...valid);
    const max = Math.max(...valid);
    const range = max - min;
    return nums.map(v => {
        if (v === null) return "·";
        if (range === 0) return SPARK_CHARS[4]; // Mitad si todos iguales
        const idx = Math.min(SPARK_CHARS.length - 1, Math.floor((v - min) / range * (SPARK_CHARS.length - 1)));
        return SPARK_CHARS[idx];
    }).join("");
}

// --- Calcular métricas por sprint ---
function toMetrics(record) {
    const successRate = record.agents_launched > 0
        ? Math.round(record.agents_ok / record.agents_launched * 100)
        : null;
    const costPerStory = (record.cost_usd !== null && record.stories_done > 0)
        ? parseFloat((record.cost_usd / record.stories_done).toFixed(3))
        : null;
    return {
        sprint: record.sprint,
        velocity: record.stories_done,
        successRate,
        avgDurationMin: record.avg_duration_min,
        costUsd: record.cost_usd,
        costPerStory
    };
}

// --- Tabla de tendencias (texto para CLI) ---
function buildTrendsText(nSprints) {
    const history = loadHistory(nSprints || DEFAULT_LOOKBACK);

    if (history.length === 0) {
        return "\nSin historial de sprints disponible. El historial se genera automáticamente al cerrar sprints.\n";
    }

    const metrics = history.map(toMetrics);
    const cols = metrics.map(m => m.sprint);
    const colW = Math.max(8, ...cols.map(c => c.length)) + 2;

    function row(label, values, format) {
        const cells = values.map(v => {
            if (v === null || v === undefined) return "—".padStart(colW);
            return format(v).padStart(colW);
        });
        return label.padEnd(20) + cells.join("");
    }

    // Calcular promedio de los últimos 5 excluyendo el actual
    const ref = metrics.slice(0, -1).slice(-5);
    function avg(arr) {
        const v = arr.filter(x => x !== null && x !== undefined);
        if (v.length === 0) return null;
        return v.reduce((a, b) => a + b, 0) / v.length;
    }
    const avgVelocity = avg(ref.map(m => m.velocity));
    const avgSuccess = avg(ref.map(m => m.successRate));
    const avgDur = avg(ref.map(m => m.avgDurationMin));
    const avgCostStory = avg(ref.map(m => m.costPerStory));

    const header = "Métrica".padEnd(20) + cols.map(c => c.padStart(colW)).join("");
    const sep = "─".repeat(20 + cols.length * colW);

    const velocityRow = row("Velocidad (hist.)", metrics.map(m => m.velocity), v => String(v));
    const successRow = row("Tasa éxito (%)", metrics.map(m => m.successRate), v => v + "%");
    const durationRow = row("Duración avg (min)", metrics.map(m => m.avgDurationMin), v => v + "m");
    const costRow = row("Costo total (USD)", metrics.map(m => m.costUsd), v => "$" + v.toFixed(2));
    const costStoryRow = row("Costo/historia", metrics.map(m => m.costPerStory), v => "$" + v.toFixed(3));

    // Sparklines
    const sparkVelocity = sparkline(metrics.map(m => m.velocity));
    const sparkSuccess = sparkline(metrics.map(m => m.successRate));
    const sparkDur = sparkline(metrics.map(m => m.avgDurationMin));
    const sparkCost = sparkline(metrics.map(m => m.costPerStory));

    let output = "\n";
    output += "╔" + "═".repeat(sep.length - 2) + "╗\n";
    output += "║" + " 📊 TENDENCIAS CROSS-SPRINT".padEnd(sep.length - 2) + "║\n";
    output += "╠" + "═".repeat(sep.length - 2) + "╣\n";
    output += "║ " + header.padEnd(sep.length - 3) + "║\n";
    output += "║ " + sep.padEnd(sep.length - 3) + "║\n";
    output += "║ " + velocityRow.padEnd(sep.length - 3) + "║\n";
    output += "║ " + successRow.padEnd(sep.length - 3) + "║\n";
    output += "║ " + durationRow.padEnd(sep.length - 3) + "║\n";
    output += "║ " + costRow.padEnd(sep.length - 3) + "║\n";
    output += "║ " + costStoryRow.padEnd(sep.length - 3) + "║\n";
    output += "╠" + "═".repeat(sep.length - 2) + "╣\n";
    output += "║ " + ("Tendencias:").padEnd(sep.length - 3) + "║\n";
    output += "║ " + ("  Velocidad:  " + sparkVelocity).padEnd(sep.length - 3) + "║\n";
    output += "║ " + ("  Tasa éxito: " + sparkSuccess).padEnd(sep.length - 3) + "║\n";
    output += "║ " + ("  Duración:   " + sparkDur).padEnd(sep.length - 3) + "║\n";
    output += "║ " + ("  Costo/hist: " + sparkCost).padEnd(sep.length - 3) + "║\n";

    if (avgVelocity !== null || avgSuccess !== null) {
        output += "╠" + "═".repeat(sep.length - 2) + "╣\n";
        output += "║ " + ("Promedio histórico (últ. 5 sprints):").padEnd(sep.length - 3) + "║\n";
        if (avgVelocity !== null) output += "║ " + ("  Velocidad:        " + avgVelocity.toFixed(1) + " hist/sprint").padEnd(sep.length - 3) + "║\n";
        if (avgSuccess !== null) output += "║ " + ("  Tasa de éxito:    " + avgSuccess.toFixed(1) + "%").padEnd(sep.length - 3) + "║\n";
        if (avgDur !== null) output += "║ " + ("  Duración promedio: " + avgDur.toFixed(0) + " min/agente").padEnd(sep.length - 3) + "║\n";
        if (avgCostStory !== null) output += "║ " + ("  Costo/historia:   $" + avgCostStory.toFixed(3)).padEnd(sep.length - 3) + "║\n";
    }

    output += "╚" + "═".repeat(sep.length - 2) + "╝\n";
    return output;
}

// --- Sección HTML para sprint-report.js ---
function buildTrendsHtmlSection(nSprints) {
    try {
        const history = loadHistory(nSprints || 5);
        if (history.length === 0) {
            return `<div style="padding:16px;color:#fbbf24;"><p>Sin historial de sprints disponible aún. Se generará automáticamente al cerrar el próximo sprint.</p></div>`;
        }

        const metrics = history.map(toMetrics);
        const ref = metrics.slice(0, -1).slice(-5);
        function avg(arr) {
            const v = arr.filter(x => x !== null && x !== undefined);
            if (v.length === 0) return null;
            return v.reduce((a, b) => a + b, 0) / v.length;
        }
        const avgVelocity = avg(ref.map(m => m.velocity));
        const avgSuccess = avg(ref.map(m => m.successRate));
        const avgCostStory = avg(ref.map(m => m.costPerStory));

        const current = metrics[metrics.length - 1];

        // Generar filas de tabla
        const headerCells = metrics.map(m =>
            `<th style="background:#0f3460;color:#fff;padding:8px 12px;text-align:right;">${m.sprint}</th>`
        ).join("");

        function tableRow(label, values, format, highlightLast) {
            const cells = values.map((v, i) => {
                const isLast = i === values.length - 1;
                const formatted = v !== null && v !== undefined ? format(v) : "—";
                const bg = (isLast && highlightLast) ? "background:#1e293b;" : "";
                return `<td style="padding:7px 12px;text-align:right;${bg}">${formatted}</td>`;
            });
            return `<tr><td style="padding:7px 12px;font-weight:600;">${label}</td>${cells.join("")}</tr>`;
        }

        const sparkVelocity = sparkline(metrics.map(m => m.velocity));
        const sparkSuccess = sparkline(metrics.map(m => m.successRate));
        const sparkCostStory = sparkline(metrics.map(m => m.costPerStory));

        // Comparación con promedio
        function cmpRow(label, current, avg, format, lowerIsBetter) {
            if (current === null || avg === null) return "";
            const diff = ((current - avg) / avg * 100).toFixed(1);
            const improved = lowerIsBetter ? current <= avg : current >= avg;
            const color = improved ? "#22c55e" : "#f87171";
            const arrow = improved ? "▲" : "▼";
            return `<tr>
                <td style="padding:6px 12px;">${label}</td>
                <td style="padding:6px 12px;text-align:right;">${format(current)}</td>
                <td style="padding:6px 12px;text-align:right;">${format(avg)}</td>
                <td style="padding:6px 12px;text-align:right;color:${color};font-weight:bold;">${arrow} ${Math.abs(parseFloat(diff))}%</td>
            </tr>`;
        }

        let html = `
<div style="border-top:3px solid #7c3aed;margin-top:40px;padding-top:20px;">
  <h1 style="color:#7c3aed;font-size:24px;">Tendencias Cross-Sprint</h1>
  <p style="color:#888;font-size:13px;">Últimos ${metrics.length} sprints. Generado automáticamente al cierre del sprint.</p>

  <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
    <thead>
      <tr>
        <th style="background:#0f3460;color:#fff;padding:8px 12px;text-align:left;">Métrica</th>
        ${headerCells}
      </tr>
    </thead>
    <tbody>
      ${tableRow("Velocidad (hist.)", metrics.map(m => m.velocity), v => String(v), true)}
      ${tableRow("Tasa éxito (%)", metrics.map(m => m.successRate), v => v + "%", true)}
      ${tableRow("Duración avg (min)", metrics.map(m => m.avgDurationMin), v => v !== null ? v + "m" : "—", true)}
      ${tableRow("Costo total (USD)", metrics.map(m => m.costUsd), v => v !== null ? "$" + v.toFixed(2) : "—", true)}
      ${tableRow("Costo/historia", metrics.map(m => m.costPerStory), v => v !== null ? "$" + v.toFixed(3) : "—", true)}
    </tbody>
  </table>

  <h2 style="color:#7c3aed;font-size:18px;margin-top:24px;">Sparklines</h2>
  <div style="font-family:monospace;font-size:16px;line-height:2;background:#f1f5f9;padding:12px 16px;border-radius:8px;">
    <div>Velocidad:    ${sparkVelocity}</div>
    <div>Tasa éxito:  ${sparkSuccess}</div>
    <div>Costo/hist:  ${sparkCostStory}</div>
  </div>`;

        if (avgVelocity !== null || avgSuccess !== null || avgCostStory !== null) {
            html += `
  <h2 style="color:#7c3aed;font-size:18px;margin-top:24px;">Comparación vs Promedio (últ. 5 sprints)</h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead>
      <tr>
        <th style="background:#0f3460;color:#fff;padding:8px 12px;text-align:left;">Métrica</th>
        <th style="background:#0f3460;color:#fff;padding:8px 12px;text-align:right;">Sprint actual</th>
        <th style="background:#0f3460;color:#fff;padding:8px 12px;text-align:right;">Promedio hist.</th>
        <th style="background:#0f3460;color:#fff;padding:8px 12px;text-align:right;">Variación</th>
      </tr>
    </thead>
    <tbody>
      ${cmpRow("Velocidad", current.velocity, avgVelocity, v => String(v), false)}
      ${cmpRow("Tasa éxito (%)", current.successRate, avgSuccess, v => v + "%", false)}
      ${cmpRow("Costo/historia", current.costPerStory, avgCostStory, v => "$" + v.toFixed(3), true)}
    </tbody>
  </table>`;
        }

        html += `\n</div>`;
        return html;
    } catch (e) {
        log("Error generando sección HTML de tendencias: " + e.message);
        return `<div style="padding:16px;color:#f87171;"><p>Error generando sección de tendencias: ${e.message}</p></div>`;
    }
}

// --- Verificar alertas y enviar Telegram ---
function checkAndSendAlerts(sprintId) {
    try {
        const history = loadHistory(6); // últimos 6 para tener 5 de referencia + el actual
        if (history.length < 2) {
            log("Historial insuficiente para evaluar alertas (necesita al menos 2 sprints)");
            return;
        }

        const current = toMetrics(history[history.length - 1]);
        // Si el sprintId se pasó, verificar que sea el sprint actual
        if (sprintId && current.sprint !== sprintId) {
            log(`checkAlerts: sprint actual en historial (${current.sprint}) != sprintId pasado (${sprintId})`);
        }

        const ref = history.slice(0, -1).slice(-5).map(toMetrics);
        function avg(arr) {
            const v = arr.filter(x => x !== null && x !== undefined);
            if (v.length === 0) return null;
            return v.reduce((a, b) => a + b, 0) / v.length;
        }

        const avgSuccess = avg(ref.map(m => m.successRate));
        const avgCostStory = avg(ref.map(m => m.costPerStory));

        const alerts = [];

        // Alerta: tasa de éxito cae más del umbral
        if (
            current.successRate !== null &&
            avgSuccess !== null &&
            avgSuccess > 0 &&
            (avgSuccess - current.successRate) / avgSuccess * 100 > ALERT_SUCCESS_RATE_DROP_PCT
        ) {
            alerts.push(
                `⚠️ <b>Tasa de éxito cayó a ${current.successRate}%</b> (promedio histórico: ${avgSuccess.toFixed(1)}%)\n` +
                `Caída del ${((avgSuccess - current.successRate) / avgSuccess * 100).toFixed(1)}% — sprint: ${current.sprint}`
            );
        }

        // Alerta: costo/historia sube más del umbral
        if (
            current.costPerStory !== null &&
            avgCostStory !== null &&
            avgCostStory > 0 &&
            (current.costPerStory - avgCostStory) / avgCostStory * 100 > ALERT_COST_STORY_RISE_PCT
        ) {
            alerts.push(
                `⚠️ <b>Costo por historia subió a $${current.costPerStory.toFixed(3)}</b> (promedio histórico: $${avgCostStory.toFixed(3)})\n` +
                `Aumento del ${((current.costPerStory - avgCostStory) / avgCostStory * 100).toFixed(1)}% — sprint: ${current.sprint}`
            );
        }

        if (alerts.length > 0) {
            const msg = `📊 <b>Alertas de Métricas — ${current.sprint}</b>\n\n` + alerts.join("\n\n");
            log(`Enviando ${alerts.length} alertas Telegram`);
            sendTelegram(msg);
        } else {
            log(`Sin alertas para ${current.sprint} (tasa éxito: ${current.successRate}%, costo/hist: ${current.costPerStory !== null ? "$" + current.costPerStory.toFixed(3) : "N/D"})`);
        }
    } catch (e) {
        log("Error evaluando alertas: " + e.message);
    }
}

// --- CLI main ---
if (require.main === module) {
    const args = process.argv.slice(2);
    const lastIdx = args.indexOf("--last");
    const nSprints = lastIdx >= 0 && args[lastIdx + 1] ? parseInt(args[lastIdx + 1]) : DEFAULT_LOOKBACK;
    const jsonOutput = args.includes("--json");
    const checkAlerts = args.includes("--check-alerts");
    const doBootstrap = args.includes("--bootstrap");

    if (doBootstrap) {
        console.log("Ejecutando bootstrap desde roadmap.json...");
        const added = bootstrapFromRoadmap();
        console.log(`Bootstrap completado: ${added.length} sprints importados.`);
        process.exit(0);
    }

    if (checkAlerts) {
        checkAndSendAlerts(null);
        process.exit(0);
    }

    if (jsonOutput) {
        const history = loadHistory(nSprints);
        console.log(JSON.stringify(history.map(toMetrics), null, 2));
        process.exit(0);
    }

    console.log(buildTrendsText(nSprints));
}

module.exports = {
    persistSprintRecord,
    buildTrendsText,
    buildTrendsHtmlSection,
    checkAndSendAlerts,
    bootstrapFromRoadmap,
    loadHistory
};
