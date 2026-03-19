#!/usr/bin/env node
// cost-report.js — Genera HTML+PDF de costos estimados y lo envía a Telegram
// Uso: node cost-report.js [--telegram] [--sprint <ID>]
// Fail-open: cualquier error queda en scripts/logs/cost-report.log sin interrumpir el flujo

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// --- Config ---
const REPO_ROOT = path.resolve(__dirname, "..");
const METRICS_PATH = path.join(REPO_ROOT, ".claude", "hooks", "agent-metrics.json");
const CONFIG_PATH = path.join(REPO_ROOT, ".claude", "hooks", "telegram-config.json");
const SPRINT_PLAN_PATH = path.join(__dirname, "sprint-plan.json");
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "cost-report.log");
const QA_DIR = path.join(REPO_ROOT, "docs", "qa");
const REPORT_TO_PDF_TELEGRAM = path.join(__dirname, "report-to-pdf-telegram.js");

// --- Args ---
const args = process.argv.slice(2);
const sendTelegram = args.includes("--telegram");
const sprintIdx = args.indexOf("--sprint");
const sprintFilter = sprintIdx >= 0 && args[sprintIdx + 1] ? args[sprintIdx + 1] : null;

// --- Logging ---
function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(msg) {
    ensureDir(LOG_DIR);
    const ts = new Date().toISOString();
    try { fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`); } catch (e) { /* ignore */ }
}

function readJsonSafe(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
        log(`Error leyendo ${filePath}: ${e.message}`);
        return null;
    }
}

// --- Token estimation ---
function estimateTokens(session) {
    if (session.tokens_estimated) return session.tokens_estimated;
    const durationSec = (session.duration_min || 0) * 60;
    const toolCalls = session.total_tool_calls || 0;
    return (durationSec * 15) + (toolCalls * 500);
}

function estimateCost(session, costPerAction) {
    const toolCalls = session.total_tool_calls || 0;
    return toolCalls * costPerAction;
}

function formatNumber(n) {
    return n.toLocaleString("es-AR");
}

function formatUSD(n) {
    return "$" + n.toFixed(2);
}

// --- HTML ---
const CSS = `
  @page { size: A4; margin: 20mm; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1a1a2e; background: #fff; margin: 0; padding: 30px; line-height: 1.6; }
  h1 { color: #16213e; border-bottom: 3px solid #0f3460; padding-bottom: 10px; font-size: 28px; }
  h2 { color: #0f3460; border-bottom: 2px solid #e2e8f0; padding-bottom: 6px; margin-top: 30px; font-size: 20px; }
  h3 { color: #533483; margin-top: 20px; font-size: 16px; }
  table { width: 100%; border-collapse: collapse; margin: 15px 0; font-size: 14px; }
  th { background: #0f3460; color: #fff; padding: 10px 12px; text-align: left; font-weight: 600; }
  td { padding: 8px 12px; border-bottom: 1px solid #e2e8f0; }
  tr:nth-child(even) { background: #f8fafc; }
  tr:hover { background: #eef2ff; }
  .metric-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin: 20px 0; }
  .metric-card { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; padding: 20px; border-radius: 12px; text-align: center; }
  .metric-card.green { background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%); }
  .metric-card.blue { background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); }
  .metric-card.orange { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); }
  .metric-number { font-size: 36px; font-weight: bold; }
  .metric-label { font-size: 13px; opacity: 0.9; margin-top: 4px; }
  .bar-container { background: #e2e8f0; border-radius: 8px; height: 24px; margin: 8px 0; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 8px; display: flex; align-items: center; padding-left: 8px; color: #fff; font-size: 12px; font-weight: bold; }
  .bar-bash { background: #3b82f6; }
  .bar-edit { background: #8b5cf6; }
  .bar-write { background: #06b6d4; }
  .bar-skill { background: #f59e0b; }
  .bar-other { background: #94a3b8; }
  .section-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 20px; margin: 15px 0; }
  .budget-gauge { background: #e2e8f0; border-radius: 12px; height: 32px; margin: 10px 0; position: relative; overflow: hidden; }
  .budget-fill { height: 100%; border-radius: 12px; display: flex; align-items: center; justify-content: center; color: #fff; font-weight: bold; font-size: 14px; }
  .budget-green { background: linear-gradient(90deg, #22c55e, #16a34a); }
  .budget-yellow { background: linear-gradient(90deg, #f59e0b, #d97706); }
  .budget-red { background: linear-gradient(90deg, #ef4444, #dc2626); }
  code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 13px; color: #334155; }
  .footer { margin-top: 40px; padding-top: 15px; border-top: 2px solid #e2e8f0; font-size: 12px; color: #94a3b8; text-align: center; }
  .formula { background: #f1f5f9; border-left: 4px solid #667eea; padding: 12px 16px; margin: 10px 0; border-radius: 0 8px 8px 0; font-family: monospace; font-size: 13px; }
`;

function escapeHtml(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildHtml(sessions, costPerAction, weeklyBudget, sprintPlan, filterSprintId) {
    const fecha = new Date().toISOString().split("T")[0];

    // Filtrar por sprint si se especificó
    let filteredSessions = sessions;
    if (filterSprintId) {
        filteredSessions = sessions.filter(s => s.sprint_id === filterSprintId);
    }

    // Enriquecer sesiones
    const enriched = filteredSessions.map(s => ({
        ...s,
        tokens_estimated: estimateTokens(s),
        cost_estimated_usd: estimateCost(s, costPerAction),
    }));

    // Totales
    const totalSessions = enriched.length;
    const totalToolCalls = enriched.reduce((sum, s) => sum + (s.total_tool_calls || 0), 0);
    const totalTokens = enriched.reduce((sum, s) => sum + s.tokens_estimated, 0);
    const totalCost = enriched.reduce((sum, s) => sum + s.cost_estimated_usd, 0);
    const totalDurationMin = enriched.reduce((sum, s) => sum + (s.duration_min || 0), 0);

    // Sesiones de últimos 7 días para costo semanal
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const weeklySessions = sessions.map(s => ({
        ...s,
        tokens_estimated: estimateTokens(s),
        cost_estimated_usd: estimateCost(s, costPerAction),
    })).filter(s => (s.started_ts || "") >= weekAgo);
    const weeklyCost = weeklySessions.reduce((sum, s) => sum + s.cost_estimated_usd, 0);
    const weeklyPct = weeklyBudget > 0 ? Math.min(Math.round(weeklyCost / weeklyBudget * 100), 100) : 0;
    const budgetClass = weeklyPct >= 90 ? "budget-red" : weeklyPct >= 70 ? "budget-yellow" : "budget-green";

    // Distribución por herramienta
    const toolTotals = {};
    for (const s of enriched) {
        if (!s.tool_counts) continue;
        for (const [tool, count] of Object.entries(s.tool_counts)) {
            toolTotals[tool] = (toolTotals[tool] || 0) + count;
        }
    }
    const toolEntries = Object.entries(toolTotals).sort((a, b) => b[1] - a[1]);
    const toolTotal = toolEntries.reduce((sum, [, n]) => sum + n, 0);

    // Agrupar por sprint
    const sprintGroups = {};
    for (const s of enriched) {
        const sid = s.sprint_id || "Sin sprint";
        if (!sprintGroups[sid]) sprintGroups[sid] = [];
        sprintGroups[sid].push(s);
    }

    // Skills más invocados
    const skillCounts = {};
    for (const s of enriched) {
        if (!s.skills_invoked) continue;
        for (const skill of s.skills_invoked) {
            skillCounts[skill] = (skillCounts[skill] || 0) + 1;
        }
    }
    const topSkills = Object.entries(skillCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);

    // Top sesiones por costo
    const topSessions = [...enriched].sort((a, b) => b.cost_estimated_usd - a.cost_estimated_usd).slice(0, 10);

    const title = filterSprintId
        ? `Reporte de Costos — ${escapeHtml(filterSprintId)}`
        : `Reporte de Costos — ${escapeHtml(fecha)}`;

    let html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>${title} — Intrale Platform</title>
<style>${CSS}</style>
</head>
<body>

<h1>${title}</h1>
<p><strong>Proyecto:</strong> Intrale Platform (<code>intrale/platform</code>)<br>
<strong>Fecha:</strong> ${fecha}<br>
<strong>Sesiones analizadas:</strong> ${totalSessions}<br>
<strong>Costo por acción:</strong> ${formatUSD(costPerAction)}</p>

<div class="formula">
<strong>Fórmula de estimación:</strong> tokens ≈ (duración_seg × 15) + (tool_calls × 500) | costo ≈ tool_calls × ${formatUSD(costPerAction)}
</div>

<!-- MÉTRICAS GLOBALES -->
<h2>1. Métricas Globales</h2>
<div class="metric-grid">
  <div class="metric-card">
    <div class="metric-number">${totalSessions}</div>
    <div class="metric-label">Sesiones</div>
  </div>
  <div class="metric-card green">
    <div class="metric-number">${formatNumber(totalToolCalls)}</div>
    <div class="metric-label">Tool Calls</div>
  </div>
  <div class="metric-card blue">
    <div class="metric-number">${formatNumber(totalTokens)}</div>
    <div class="metric-label">Tokens Estimados</div>
  </div>
  <div class="metric-card orange">
    <div class="metric-number">${formatUSD(totalCost)}</div>
    <div class="metric-label">Costo Estimado</div>
  </div>
</div>

<!-- PRESUPUESTO SEMANAL -->
<h2>2. Presupuesto Semanal</h2>
<div class="section-box">
  <p><strong>Costo últimos 7 días:</strong> ${formatUSD(weeklyCost)} / ${formatUSD(weeklyBudget)}</p>
  <div class="budget-gauge">
    <div class="budget-fill ${budgetClass}" style="width: ${Math.max(weeklyPct, 5)}%">
      ${weeklyPct}%
    </div>
  </div>
  <p><strong>Sesiones esta semana:</strong> ${weeklySessions.length} | <strong>Duración total:</strong> ${totalDurationMin} min</p>
</div>

<!-- DISTRIBUCIÓN POR HERRAMIENTA -->
<h2>3. Distribución por Herramienta</h2>
<div class="section-box">`;

    const toolColors = { Bash: "bar-bash", Edit: "bar-edit", Write: "bar-write", Skill: "bar-skill" };
    for (const [tool, count] of toolEntries.slice(0, 8)) {
        const pct = toolTotal > 0 ? Math.round(count / toolTotal * 100) : 0;
        const barClass = toolColors[tool] || "bar-other";
        html += `
  <p style="margin: 4px 0; font-size: 13px;"><strong>${escapeHtml(tool)}</strong> — ${formatNumber(count)} (${pct}%)</p>
  <div class="bar-container">
    <div class="bar-fill ${barClass}" style="width: ${Math.max(pct, 2)}%">${pct}%</div>
  </div>`;
    }

    html += `
</div>

<!-- TOP SESIONES -->
<h2>4. Top Sesiones por Costo</h2>
<table>
  <thead>
    <tr><th>Sesión</th><th>Sprint</th><th>Agente</th><th>Dur.</th><th>Calls</th><th>Tokens Est.</th><th>Costo</th></tr>
  </thead>
  <tbody>`;

    for (const s of topSessions) {
        const agentLabel = s.agent_name || (s.branch ? s.branch.replace("agent/", "").substring(0, 20) : "N/A");
        html += `
    <tr>
      <td><code>${escapeHtml(s.id)}</code></td>
      <td>${escapeHtml(s.sprint_id || "—")}</td>
      <td>${escapeHtml(agentLabel)}</td>
      <td>${s.duration_min || 0} min</td>
      <td>${s.total_tool_calls || 0}</td>
      <td>${formatNumber(s.tokens_estimated)}</td>
      <td><strong>${formatUSD(s.cost_estimated_usd)}</strong></td>
    </tr>`;
    }

    html += `
  </tbody>
</table>

<!-- DESGLOSE POR SPRINT -->
<h2>5. Desglose por Sprint</h2>`;

    for (const [sprintId, sprintSessions] of Object.entries(sprintGroups)) {
        const sprintCalls = sprintSessions.reduce((sum, s) => sum + (s.total_tool_calls || 0), 0);
        const sprintTokens = sprintSessions.reduce((sum, s) => sum + s.tokens_estimated, 0);
        const sprintCost = sprintSessions.reduce((sum, s) => sum + s.cost_estimated_usd, 0);
        const sprintDur = sprintSessions.reduce((sum, s) => sum + (s.duration_min || 0), 0);

        html += `
<div class="section-box">
  <h3>${escapeHtml(sprintId)}</h3>
  <p><strong>Sesiones:</strong> ${sprintSessions.length} | <strong>Duración:</strong> ${sprintDur} min | <strong>Calls:</strong> ${formatNumber(sprintCalls)} | <strong>Tokens:</strong> ${formatNumber(sprintTokens)} | <strong>Costo:</strong> ${formatUSD(sprintCost)}</p>
  <table>
    <thead>
      <tr><th>Sesión</th><th>Agente</th><th>Dur.</th><th>Calls</th><th>Tokens</th><th>Costo</th></tr>
    </thead>
    <tbody>`;

        for (const s of sprintSessions.sort((a, b) => b.cost_estimated_usd - a.cost_estimated_usd)) {
            const agentLabel = s.agent_name || (s.branch ? s.branch.replace("agent/", "").substring(0, 25) : "N/A");
            html += `
      <tr>
        <td><code>${escapeHtml(s.id)}</code></td>
        <td>${escapeHtml(agentLabel)}</td>
        <td>${s.duration_min || 0}m</td>
        <td>${s.total_tool_calls || 0}</td>
        <td>${formatNumber(s.tokens_estimated)}</td>
        <td>${formatUSD(s.cost_estimated_usd)}</td>
      </tr>`;
        }

        html += `
    </tbody>
  </table>
</div>`;
    }

    // Skills más invocados
    if (topSkills.length > 0) {
        html += `
<!-- TOP SKILLS -->
<h2>6. Skills más Invocados</h2>
<table>
  <thead>
    <tr><th>Skill</th><th>Invocaciones</th></tr>
  </thead>
  <tbody>`;

        for (const [skill, count] of topSkills) {
            html += `
    <tr>
      <td><code>${escapeHtml(skill)}</code></td>
      <td>${count}</td>
    </tr>`;
        }

        html += `
  </tbody>
</table>`;
    }

    // Footer
    html += `
<div class="footer">
  <p>Generado automáticamente el ${fecha} | Intrale Platform | Cost Report</p>
  <p>Modelo: Claude Haiku 4.5 | Estimación por proxy (duración + tool calls)</p>
</div>

</body>
</html>`;

    return html;
}

// --- PDF + Telegram ---
function sendReportViaTelegram(htmlPath, caption) {
    if (!fs.existsSync(REPORT_TO_PDF_TELEGRAM)) {
        log("report-to-pdf-telegram.js no encontrado: " + REPORT_TO_PDF_TELEGRAM);
        return false;
    }
    try {
        const result = execSync(
            `node "${REPORT_TO_PDF_TELEGRAM}" "${htmlPath}" "${caption.replace(/"/g, '\\"')}"`,
            { encoding: "utf8", timeout: 120000 }
        ).trim();
        log("report-to-pdf-telegram.js OK: " + result);
        return true;
    } catch (e) {
        log("report-to-pdf-telegram.js falló: " + e.message);
        return false;
    }
}

// --- Main ---
function main() {
    log("=== cost-report.js iniciado ===");

    // Leer métricas
    const metrics = readJsonSafe(METRICS_PATH);
    if (!metrics || !metrics.sessions || metrics.sessions.length === 0) {
        log("Sin sesiones en agent-metrics.json. Abortando.");
        console.log("Sin métricas registradas.");
        return;
    }

    // Leer config
    const config = readJsonSafe(CONFIG_PATH) || {};
    const costPerAction = (config.claude_metrics && config.claude_metrics.cost_per_action_usd) || 0.003;
    const weeklyBudget = (config.claude_metrics && config.claude_metrics.weekly_budget_usd) || 50;

    // Leer sprint plan
    const sprintPlan = readJsonSafe(SPRINT_PLAN_PATH);

    log(`Métricas: ${metrics.sessions.length} sesiones, costPerAction=${costPerAction}, weeklyBudget=${weeklyBudget}`);

    // Generar HTML
    const fecha = new Date().toISOString().split("T")[0];
    const suffix = sprintFilter ? `-${sprintFilter.toLowerCase()}` : "";
    const htmlFileName = `reporte-costos${suffix}-${fecha}.html`;
    const htmlPath = path.join(QA_DIR, htmlFileName);
    const html = buildHtml(metrics.sessions, costPerAction, weeklyBudget, sprintPlan, sprintFilter);

    ensureDir(QA_DIR);
    fs.writeFileSync(htmlPath, html, "utf8");
    log(`HTML generado: ${htmlPath}`);
    console.log(`Reporte generado: ${htmlPath}`);

    // Enviar a Telegram si se solicitó
    if (sendTelegram) {
        const sprintLabel = sprintFilter ? ` ${sprintFilter}` : "";
        const caption = `💰 Reporte de Costos${sprintLabel} — ${fecha} — ${metrics.sessions.length} sesiones`;
        const sent = sendReportViaTelegram(htmlPath, caption);
        if (sent) {
            console.log("Reporte enviado a Telegram.");
        } else {
            console.log("No se pudo enviar a Telegram (ver log).");
        }
    }

    log("=== cost-report.js completado ===");
}

// --- Exportable: generar solo la sección HTML del body (sin <html>/<head> wrapper) ---
// Para uso desde sprint-report.js como sección embebida del reporte unificado
function buildCostSection(sprintId) {
    try {
        const metrics = collectMetrics();
        const sprintPlan = fs.existsSync(PLAN_FILE) ? JSON.parse(fs.readFileSync(PLAN_FILE, "utf8")) : null;
        const html = buildHtml(metrics.sessions, costPerAction, weeklyBudget, sprintPlan, sprintId);
        // Extract only the <body> content (between <body> and </body>)
        const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
        return bodyMatch ? bodyMatch[1] : "";
    } catch (e) {
        return `<div style="color:#f87171;padding:20px;"><h3>Error generando sección de costos</h3><p>${e.message}</p></div>`;
    }
}

if (require.main === module) {
    main();
}

module.exports = { buildCostSection };
