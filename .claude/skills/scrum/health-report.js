// health-report.js — Reporte HTML/PDF de salud del sprint
// Genera un reporte completo con métricas, inconsistencias y acciones ejecutadas
// Envía a Telegram via el script unificado report-to-pdf-telegram.js

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || "/c/Workspaces/Intrale/platform";
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");
const AUDIT_FILE = path.join(HOOKS_DIR, "sprint-audit.jsonl");
const DOCS_DIR = path.join(REPO_ROOT, "docs", "qa");
const REPORT_SCRIPT = path.join(REPO_ROOT, "scripts", "report-to-pdf-telegram.js");
const GH_CLI = "/c/Workspaces/gh-cli/bin/gh.exe";

function readAuditHistory(limit = 100) {
    try {
        if (!fs.existsSync(AUDIT_FILE)) return [];
        const lines = fs.readFileSync(AUDIT_FILE, "utf8").split("\n").filter(Boolean);
        return lines.slice(-limit).map(l => {
            try { return JSON.parse(l); } catch (e) { return null; }
        }).filter(Boolean);
    } catch (e) {
        return [];
    }
}

function formatDate(isoString) {
    if (!isoString) return "N/A";
    try {
        return new Date(isoString).toLocaleString("es-AR", {
            timeZone: "America/Argentina/Buenos_Aires",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit"
        });
    } catch (e) {
        return isoString;
    }
}

function getSeverityBadge(severity) {
    switch (severity) {
        case "critical": return '<span style="background:#dc2626;color:white;padding:2px 8px;border-radius:4px;font-size:12px">CRÍTICO</span>';
        case "high": return '<span style="background:#ea580c;color:white;padding:2px 8px;border-radius:4px;font-size:12px">ALTO</span>';
        case "medium": return '<span style="background:#ca8a04;color:white;padding:2px 8px;border-radius:4px;font-size:12px">MEDIO</span>';
        default: return '<span style="background:#16a34a;color:white;padding:2px 8px;border-radius:4px;font-size:12px">BAJO</span>';
    }
}

function getStatusBadge(status) {
    switch (status) {
        case "ok": return '<span style="background:#16a34a;color:white;padding:2px 8px;border-radius:4px;font-size:12px">✓ OK</span>';
        case "dry_run": return '<span style="background:#2563eb;color:white;padding:2px 8px;border-radius:4px;font-size:12px">⊙ DRY RUN</span>';
        case "error": return '<span style="background:#dc2626;color:white;padding:2px 8px;border-radius:4px;font-size:12px">✗ ERROR</span>';
        case "partial": return '<span style="background:#ca8a04;color:white;padding:2px 8px;border-radius:4px;font-size:12px">⚠ PARCIAL</span>';
        default: return '<span style="background:#6b7280;color:white;padding:2px 8px;border-radius:4px;font-size:12px">' + status + '</span>';
    }
}

function buildHealthBar(completed, total) {
    if (!total) return '<span style="color:#6b7280">N/A</span>';
    const pct = Math.round((completed / total) * 100);
    const filled = Math.round(pct / 10);
    const bar = "█".repeat(filled) + "░".repeat(10 - filled);
    const color = pct >= 80 ? "#16a34a" : pct >= 50 ? "#ca8a04" : "#dc2626";
    return `<span style="font-family:monospace;color:${color}">${bar}</span> ${pct}% (${completed}/${total})`;
}

function generateHTML(diagnosis, repairResult, auditHistory) {
    const sprint = diagnosis.sprint_id || "N/A";
    const metrics = diagnosis.metrics || {};
    const inconsistencias = diagnosis.inconsistencias || [];
    const reportDate = formatDate(diagnosis.timestamp || new Date().toISOString());

    const healthColor = {
        healthy: "#16a34a",
        warning: "#ca8a04",
        critical: "#dc2626"
    }[diagnosis.health_level] || "#6b7280";

    const healthLabel = {
        healthy: "🟢 SALUDABLE",
        warning: "🟡 ATENCIÓN",
        critical: "🔴 CRÍTICO"
    }[diagnosis.health_level] || diagnosis.health_level;

    // Historial de auditoría reciente (últimas 24h)
    const recentAudit = auditHistory.filter(a => {
        if (!a.timestamp) return false;
        return (Date.now() - new Date(a.timestamp).getTime()) < 24 * 60 * 60 * 1000;
    });

    // Inconsistencias por tipo
    const incByType = {};
    for (const inc of inconsistencias) {
        incByType[inc.type] = (incByType[inc.type] || 0) + 1;
    }

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Reporte de Salud del Sprint — ${sprint}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #1e293b; }
  .container { max-width: 900px; margin: 0 auto; padding: 20px; }
  .header { background: linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%); color: white; padding: 30px; border-radius: 12px; margin-bottom: 20px; }
  .header h1 { font-size: 24px; margin-bottom: 4px; }
  .header p { opacity: 0.85; font-size: 14px; }
  .health-badge { display: inline-block; background: ${healthColor}; color: white; padding: 6px 16px; border-radius: 20px; font-weight: bold; font-size: 16px; margin-top: 10px; }
  .card { background: white; border-radius: 10px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .card h2 { font-size: 16px; color: #475569; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 16px; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; }
  .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .metric { background: #f1f5f9; border-radius: 8px; padding: 14px; text-align: center; }
  .metric .value { font-size: 28px; font-weight: bold; color: #1e3a5f; }
  .metric .label { font-size: 12px; color: #64748b; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { background: #f1f5f9; padding: 10px 12px; text-align: left; font-size: 12px; color: #475569; text-transform: uppercase; }
  td { padding: 10px 12px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  tr:hover td { background: #f8fafc; }
  .no-data { text-align: center; color: #94a3b8; padding: 24px; font-style: italic; }
  .issue-link { color: #2563eb; text-decoration: none; }
  .progress-bar { font-family: monospace; }
  .footer { text-align: center; color: #94a3b8; font-size: 12px; margin-top: 20px; }
</style>
</head>
<body>
<div class="container">

  <div class="header">
    <h1>📊 Reporte de Salud del Sprint</h1>
    <p>${sprint} — ${reportDate}</p>
    <div class="health-badge">${healthLabel}</div>
  </div>

  <!-- Métricas de progreso -->
  <div class="card">
    <h2>📈 Progreso del Sprint</h2>
    <div class="metrics-grid">
      <div class="metric">
        <div class="value">${metrics.total_issues || 0}</div>
        <div class="label">Total historias</div>
      </div>
      <div class="metric">
        <div class="value" style="color:#16a34a">${metrics.completed || 0}</div>
        <div class="label">Completadas</div>
      </div>
      <div class="metric">
        <div class="value" style="color:#2563eb">${metrics.in_progress || 0}</div>
        <div class="label">En progreso</div>
      </div>
      <div class="metric">
        <div class="value" style="color:#dc2626">${metrics.blocked || 0}</div>
        <div class="label">Bloqueadas</div>
      </div>
      <div class="metric">
        <div class="value" style="color:${metrics.inconsistencias_critical > 0 ? '#dc2626' : '#16a34a'}">${metrics.inconsistencias_total || 0}</div>
        <div class="label">Inconsistencias</div>
      </div>
    </div>
    <div style="margin-top: 16px; padding: 12px; background: #f8fafc; border-radius: 8px;">
      <strong>Progreso:</strong> ${buildHealthBar(metrics.completed || 0, metrics.total_issues || 0)}
    </div>
  </div>

  <!-- Estado del sprint -->
  <div class="card">
    <h2>📅 Estado del Sprint</h2>
    <table>
      <tr>
        <th>Campo</th>
        <th>Valor</th>
      </tr>
      <tr><td><strong>ID</strong></td><td>${diagnosis.sprint_id || "N/A"}</td></tr>
      <tr><td><strong>Estado</strong></td><td>${diagnosis.sprint_status || "active"}</td></tr>
      ${diagnosis.sprint_overdue ? `<tr><td><strong>⚠️ Vencimiento</strong></td><td>${diagnosis.sprint_overdue.message}</td></tr>` : ""}
      <tr><td><strong>Salud</strong></td><td>${healthLabel}</td></tr>
      <tr><td><strong>Timestamp</strong></td><td>${reportDate}</td></tr>
    </table>
  </div>

  <!-- Inconsistencias detectadas -->
  <div class="card">
    <h2>🔴 Inconsistencias Detectadas (${inconsistencias.length})</h2>
    ${inconsistencias.length === 0
        ? '<p class="no-data">✅ No se encontraron inconsistencias</p>'
        : `<table>
          <thead>
            <tr>
              <th>Issue</th>
              <th>Tipo</th>
              <th>Severidad</th>
              <th>Descripción</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            ${inconsistencias.map(inc => `
            <tr>
              <td><a class="issue-link" href="https://github.com/intrale/platform/issues/${inc.issue || ''}" target="_blank">#${inc.issue || "N/A"}</a></td>
              <td><code style="font-size:11px">${inc.type}</code></td>
              <td>${getSeverityBadge(inc.severity)}</td>
              <td>${inc.message}</td>
              <td><code style="font-size:11px;color:#6b7280">${inc.action || "N/A"}</code></td>
            </tr>`).join("")}
          </tbody>
        </table>`}
  </div>

  <!-- Historias por estado -->
  <div class="card">
    <h2>📋 Estado de Historias del Sprint</h2>
    ${(diagnosis.issues || []).length === 0
        ? '<p class="no-data">Sin datos de historias</p>'
        : `<table>
          <thead>
            <tr>
              <th>Issue</th>
              <th>Título</th>
              <th>GitHub</th>
              <th>Project V2</th>
              <th>Inconsistencias</th>
            </tr>
          </thead>
          <tbody>
            ${(diagnosis.issues || []).map(issue => `
            <tr>
              <td><a class="issue-link" href="https://github.com/intrale/platform/issues/${issue.issue}" target="_blank">#${issue.issue}</a></td>
              <td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${issue.title || ''}">${issue.title || "N/A"}</td>
              <td>${issue.github_state === "CLOSED"
                ? '<span style="color:#16a34a">✓ Cerrado</span>'
                : '<span style="color:#2563eb">⊙ Abierto</span>'}</td>
              <td><code style="font-size:12px">${issue.project_status || "Sin estado"}</code></td>
              <td>${issue.inconsistencias && issue.inconsistencias.length > 0
                ? `<span style="color:#dc2626">⚠ ${issue.inconsistencias.length}</span>`
                : '<span style="color:#16a34a">✓</span>'}</td>
            </tr>`).join("")}
          </tbody>
        </table>`}
  </div>

  <!-- Acciones de reparación ejecutadas -->
  ${repairResult && repairResult.repairs && repairResult.repairs.length > 0 ? `
  <div class="card">
    <h2>🔧 Acciones de Reparación (${repairResult.repairs.length})</h2>
    <table>
      <thead>
        <tr><th>Issue</th><th>Acción</th><th>Estado</th><th>Detalles</th></tr>
      </thead>
      <tbody>
        ${repairResult.repairs.map(r => `
        <tr>
          <td>${r.issue ? `<a class="issue-link" href="https://github.com/intrale/platform/issues/${r.issue}" target="_blank">#${r.issue}</a>` : "N/A"}</td>
          <td><code style="font-size:11px">${r.inconsistencia || r.action || "N/A"}</code></td>
          <td>${getStatusBadge(r.status)}</td>
          <td style="font-size:12px;color:#64748b">${r.details ? JSON.stringify(r.details) : ""}</td>
        </tr>`).join("")}
      </tbody>
    </table>
  </div>` : ""}

  <!-- Historial de auditoría reciente -->
  <div class="card">
    <h2>📜 Historial de Auditoría (últimas 24h)</h2>
    ${recentAudit.length === 0
        ? '<p class="no-data">Sin acciones registradas en las últimas 24h</p>'
        : `<table>
          <thead>
            <tr><th>Timestamp</th><th>Acción</th><th>Issue</th><th>Estado</th><th>Razón</th></tr>
          </thead>
          <tbody>
            ${recentAudit.slice(-20).reverse().map(entry => `
            <tr>
              <td style="white-space:nowrap;font-size:12px">${formatDate(entry.timestamp)}</td>
              <td><code style="font-size:11px">${entry.action || "N/A"}</code></td>
              <td>${entry.issue ? `<a class="issue-link" href="https://github.com/intrale/platform/issues/${entry.issue}" target="_blank">#${entry.issue}</a>` : "N/A"}</td>
              <td>${getStatusBadge(entry.status)}</td>
              <td style="font-size:12px;color:#64748b;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${entry.reason || ''}">${entry.reason || ""}</td>
            </tr>`).join("")}
          </tbody>
        </table>`}
  </div>

  <div class="footer">
    Generado por <strong>health-report.js</strong> · Intrale Platform · ${reportDate}
  </div>
</div>
</body>
</html>`;
}

async function generateReport(diagnosis, repairResult) {
    const auditHistory = readAuditHistory();

    // Asegurar directorio docs/qa
    try {
        fs.mkdirSync(DOCS_DIR, { recursive: true });
    } catch (e) {}

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
    const sprint = (diagnosis.sprint_id || "sprint").toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const htmlFile = path.join(DOCS_DIR, `reporte-sprint-health-${sprint}-${timestamp}.html`);

    const html = generateHTML(diagnosis, repairResult, auditHistory);
    fs.writeFileSync(htmlFile, html, "utf8");

    console.log("Reporte HTML generado: " + htmlFile);

    // Enviar a Telegram via script unificado
    const caption = `📊 Reporte Salud Sprint ${diagnosis.sprint_id || ""} — ${diagnosis.health_level || "N/A"}`;
    if (fs.existsSync(REPORT_SCRIPT)) {
        try {
            execSync(
                `node "${REPORT_SCRIPT}" "${htmlFile}" "${caption}"`,
                { encoding: "utf8", cwd: REPO_ROOT, timeout: 60000 }
            );
            console.log("Reporte enviado a Telegram");
        } catch (e) {
            console.error("⚠️ No se pudo enviar el reporte a Telegram: " + e.message);
        }
    } else {
        console.log("⚠️ scripts/report-to-pdf-telegram.js no encontrado — reporte guardado en: " + htmlFile);
    }

    return htmlFile;
}

// CLI
if (require.main === module) {
    const { runHealthCheck } = require(path.join(REPO_ROOT, ".claude", "hooks", "health-check-sprint"));
    const { runAutoRepair } = require(path.join(REPO_ROOT, ".claude", "hooks", "auto-repair-sprint"));

    runHealthCheck().then(async diagnosis => {
        let repairResult = null;
        if (diagnosis.inconsistencias && diagnosis.inconsistencias.length > 0) {
            repairResult = await runAutoRepair(diagnosis, { dryRun: true });
        }
        return generateReport(diagnosis, repairResult);
    }).then(htmlFile => {
        console.log("Reporte generado: " + htmlFile);
        process.exit(0);
    }).catch(e => {
        console.error("Error generando reporte: " + e.message);
        process.exit(1);
    });
}

module.exports = { generateReport, generateHTML };
