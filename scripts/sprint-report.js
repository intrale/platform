#!/usr/bin/env node
// sprint-report.js — Genera HTML+PDF del sprint y lo envía a Telegram
// Uso: node sprint-report.js [path-to-sprint-plan.json]
// Fail-open: cualquier error queda en scripts/logs/sprint-report.log sin interrumpir el flujo

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { buildExecutionSummary, escapeHtml, durationMinutes } = require("./execution-report");

// --- Config ---
const REPO_ROOT = path.resolve(__dirname, "..");
const GH_PATH = "C:\\Workspaces\\gh-cli\\bin\\gh.exe";
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "sprint-report.log");
const QA_DIR = path.join(REPO_ROOT, "docs", "qa");
const REPORT_TO_PDF_TELEGRAM = path.join(__dirname, "report-to-pdf-telegram.js");

// --- Logging ---
function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(msg) {
    ensureDir(LOG_DIR);
    const ts = new Date().toISOString();
    try { fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`); } catch (e) { /* ignore */ }
}

function execSafe(cmd, opts = {}) {
    try {
        return execSync(cmd, { encoding: "utf8", timeout: 30000, ...opts }).trim();
    } catch (e) {
        log(`execSafe failed: ${cmd.substring(0, 100)} → ${e.message}`);
        return null;
    }
}

// Reutilizar sanitizador centralizado (#1637/#1639)
const { sanitize: sanitizeUtf8 } = require(path.join(__dirname, '..', '.claude', 'hooks', 'telegram-sanitizer'));

// --- PDF + Telegram via script unificado ---
function sendReportViaTelegram(htmlPath, caption) {
    if (!fs.existsSync(REPORT_TO_PDF_TELEGRAM)) {
        log("report-to-pdf-telegram.js no encontrado en: " + REPORT_TO_PDF_TELEGRAM);
        return false;
    }
    const result = execSafe(
        `node "${REPORT_TO_PDF_TELEGRAM}" "${htmlPath}" "${caption.replace(/"/g, '\\"')}"`,
        { timeout: 120000 }
    );
    if (result !== null) {
        log("report-to-pdf-telegram.js ejecutado OK:\n" + result);
        return true;
    }
    log("report-to-pdf-telegram.js falló");
    return false;
}

// --- Snapshot de sesiones ---
function snapshotSessions() {
    const sessionsDir = path.join(REPO_ROOT, ".claude", "sessions");
    const snapshot = {};
    try {
        if (!fs.existsSync(sessionsDir)) return snapshot;
        const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".json"));
        for (const file of files) {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), "utf8"));
                snapshot[file.replace(".json", "")] = data;
            } catch (e) { /* skip */ }
        }
    } catch (e) { log("Error snapshot sesiones: " + e.message); }
    return snapshot;
}

// --- GitHub queries ---
function getIssueInfo(issueNumber) {
    const raw = execSafe(
        `"${GH_PATH}" issue view ${issueNumber} --json title,state,closedAt --repo intrale/platform`
    );
    if (!raw) return { title: `Issue #${issueNumber}`, state: "UNKNOWN", closedAt: null };
    try { return JSON.parse(raw); } catch (e) { return { title: `Issue #${issueNumber}`, state: "UNKNOWN", closedAt: null }; }
}

function getPRsForSprint() {
    const raw = execSafe(
        `"${GH_PATH}" pr list --search "head:agent/" --state all --json number,url,title,state,mergedAt,headRefName --limit 20 --repo intrale/platform`
    );
    if (!raw) return [];
    try { return JSON.parse(raw); } catch (e) { return []; }
}

function getCIRuns() {
    const raw = execSafe(
        `"${GH_PATH}" run list --limit 10 --json status,conclusion,headBranch,updatedAt --repo intrale/platform`
    );
    if (!raw) return [];
    try { return JSON.parse(raw); } catch (e) { return []; }
}

function getWorktreeList() {
    const raw = execSafe("git worktree list --porcelain", { cwd: REPO_ROOT });
    if (!raw) return [];
    const worktrees = [];
    let current = {};
    for (const line of raw.split("\n")) {
        if (line.startsWith("worktree ")) {
            if (current.path) worktrees.push(current);
            current = { path: line.replace("worktree ", "").trim() };
        } else if (line.startsWith("HEAD ")) {
            current.head = line.replace("HEAD ", "").trim();
        } else if (line.startsWith("branch ")) {
            current.branch = line.replace("branch refs/heads/", "").trim();
        } else if (line === "detached") {
            current.detached = true;
        }
    }
    if (current.path) worktrees.push(current);
    return worktrees;
}

// --- Formato de fecha Argentina ---
function formatDateAR(isoStr) {
    if (!isoStr) return "N/A";
    try {
        return new Date(isoStr).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
    } catch (e) { return isoStr; }
}

// --- Data extraction for enriched sections ---

/**
 * Busca problemas/errores en activity-log.jsonl filtrando por sesiones del sprint.
 * Retorna array de { time, description, resolution }
 */
function extractProblemsFromActivityLog(activityLogPath, sessionIds) {
    const problems = [];
    const ERROR_KEYWORDS = /\b(error|fail|failed|bloqueado|blocked|retry|retrying|fallo|crash|timeout|exception)\b/i;
    const FIX_KEYWORDS = /\b(fix|fixed|resuelto|resolved|solucion|workaround|correg)\b/i;
    try {
        if (!fs.existsSync(activityLogPath)) return problems;
        const lines = fs.readFileSync(activityLogPath, "utf8").split("\n").filter(Boolean);
        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                if (!sessionIds.has(entry.session)) continue;
                const target = (entry.target || "").toLowerCase();
                const detail = (entry.detail || "").toLowerCase();
                const combined = target + " " + detail;
                if (ERROR_KEYWORDS.test(combined)) {
                    problems.push({
                        time: formatDateAR(entry.ts),
                        session: entry.session,
                        tool: entry.tool || "N/A",
                        description: entry.target || entry.detail || "Error detectado",
                        isResolution: FIX_KEYWORDS.test(combined)
                    });
                }
            } catch (e) { /* skip */ }
        }
    } catch (e) { log("Error extrayendo problemas del activity log: " + e.message); }
    return problems;
}

/**
 * Busca problemas/fixes en las descripciones de PRs del sprint.
 * Retorna array de { pr, description }
 */
function extractProblemsFromPRs(sprintPRs) {
    const problems = [];
    const KEYWORDS = /\b(error|fix|bug|bloqueado|blocked|fallo|workaround|hotfix|retry|correg|resuelto|problema)\b/i;
    for (const pr of sprintPRs) {
        // Obtener body del PR via gh
        const raw = execSafe(
            `"${GH_PATH}" pr view ${pr.number} --json body --jq .body --repo intrale/platform`
        );
        if (raw && KEYWORDS.test(raw)) {
            // Extraer líneas relevantes (máx 3)
            const relevantLines = raw.split("\n")
                .filter(l => KEYWORDS.test(l))
                .slice(0, 3)
                .map(l => l.trim())
                .filter(Boolean);
            if (relevantLines.length > 0) {
                problems.push({
                    prNumber: pr.number,
                    prTitle: pr.title,
                    lines: relevantLines
                });
            }
        }
    }
    return problems;
}

/**
 * Identifica issues del sprint que quedaron abiertos (deuda técnica).
 * Retorna array de { issue, title, state, url }
 */
function extractTechnicalDebt(agentes, issueInfos) {
    const debt = [];
    for (const ag of agentes) {
        const info = issueInfos[ag.issue] || {};
        if (info.state !== "CLOSED") {
            debt.push({
                issue: ag.issue,
                title: ag.titulo || info.title || `Issue #${ag.issue}`,
                state: info.state || "UNKNOWN",
                url: `https://github.com/intrale/platform/issues/${ag.issue}`
            });
        }
    }
    return debt;
}

// --- HTML Template ---
const CSS = `
  @page { size: A4; margin: 20mm; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1a1a2e; background: #fff; margin: 0; padding: 30px; line-height: 1.6; }
  h1 { color: #16213e; border-bottom: 3px solid #0f3460; padding-bottom: 10px; font-size: 28px; }
  h2 { color: #0f3460; border-bottom: 2px solid #e2e8f0; padding-bottom: 6px; margin-top: 30px; font-size: 20px; }
  h3 { color: #533483; margin-top: 20px; font-size: 16px; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: bold; margin-right: 4px; }
  .badge-open { background: #dcfce7; color: #166534; }
  .badge-closed { background: #f3e8ff; color: #6b21a8; }
  .badge-merged { background: #dbeafe; color: #1e40af; }
  .badge-stream { background: #fef3c7; color: #92400e; }
  .badge-size { background: #e0e7ff; color: #3730a3; }
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
  .timeline { border-left: 3px solid #0f3460; padding-left: 20px; margin: 20px 0; }
  .timeline-item { position: relative; margin-bottom: 15px; padding: 10px 15px; background: #f8fafc; border-radius: 8px; border-left: 4px solid #667eea; }
  .timeline-item.success { border-left-color: #22c55e; }
  .timeline-item.warning { border-left-color: #f59e0b; }
  .timeline-item.info { border-left-color: #3b82f6; }
  .timeline-time { font-size: 12px; color: #64748b; font-weight: bold; }
  .timeline-title { font-weight: 600; margin: 4px 0; }
  .timeline-detail { font-size: 13px; color: #475569; }
  .section-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 20px; margin: 15px 0; }
  code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 13px; color: #334155; }
  .footer { margin-top: 40px; padding-top: 15px; border-top: 2px solid #e2e8f0; font-size: 12px; color: #94a3b8; text-align: center; }
`;

function buildHtml(plan, issueInfos, agentSummaries, prs, ciRuns, worktrees, sprintDurationMin, problemsData, debtData) {
    const fecha = (plan.started_at || "").split("T")[0] || new Date().toISOString().split("T")[0];
    const tema = plan.tema || "";
    const agentes = plan.agentes || [];
    const sprintId = plan.sprint_id || null;

    // Fallback descriptivo para el objetivo del sprint
    const objetivo = tema
        ? escapeHtml(tema)
        : `Sprint del ${fecha} &mdash; ${agentes.length} issues planificados`;

    // Filtrar PRs relevantes al sprint
    const sprintBranches = new Set(agentes.map(a => `agent/${a.issue}-${a.slug}`));
    const sprintPRs = prs.filter(pr => sprintBranches.has(pr.headRefName));
    const mergedPRs = sprintPRs.filter(pr => pr.state === "MERGED");
    const closedIssues = Object.values(issueInfos).filter(i => i.state === "CLOSED").length;

    // Filtrar CI runs relevantes
    const sprintCIRuns = ciRuns.filter(r => sprintBranches.has(r.headBranch));

    let html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>${sprintId ? escapeHtml(sprintId) + " — " : ""}Reporte Sprint — ${escapeHtml(fecha)} — Intrale Platform</title>
<style>${CSS}</style>
</head>
<body>

<h1>${sprintId ? escapeHtml(sprintId) + " — " : ""}Reporte de Sprint — ${escapeHtml(fecha)}</h1>
<p><strong>Proyecto:</strong> Intrale Platform (<code>intrale/platform</code>)<br>
${sprintId ? `<strong>Sprint ID:</strong> ${escapeHtml(sprintId)}<br>\n` : ""}<strong>Fecha:</strong> ${fecha}<br>
<strong>Objetivo:</strong> ${objetivo}<br>
<strong>Duración total:</strong> ${sprintDurationMin} min</p>

<!-- MÉTRICAS -->
<h2>1. Métricas del Sprint</h2>
<div class="metric-grid">
  <div class="metric-card">
    <div class="metric-number">${agentes.length}</div>
    <div class="metric-label">Issues del sprint</div>
  </div>
  <div class="metric-card green">
    <div class="metric-number">${closedIssues}</div>
    <div class="metric-label">Issues cerrados</div>
  </div>
  <div class="metric-card blue">
    <div class="metric-number">${mergedPRs.length}</div>
    <div class="metric-label">PRs merged</div>
  </div>
  <div class="metric-card orange">
    <div class="metric-number">${sprintDurationMin}</div>
    <div class="metric-label">Minutos totales</div>
  </div>
</div>

<!-- LOGROS DESTACADOS -->
<h2>2. Logros destacados</h2>`;

    // Issues cerrados con PR mergeado
    const logros = agentes.filter(ag => {
        const info = issueInfos[ag.issue] || {};
        const pr = sprintPRs.find(p => p.headRefName === `agent/${ag.issue}-${ag.slug}`);
        return info.state === "CLOSED" && pr && pr.state === "MERGED";
    });

    if (logros.length > 0) {
        html += `<ul>`;
        for (const ag of logros) {
            const pr = sprintPRs.find(p => p.headRefName === `agent/${ag.issue}-${ag.slug}`);
            html += `
  <li><strong>#${ag.issue}</strong> — ${escapeHtml(ag.titulo || "")}
    &rarr; PR <a href="${pr.url || ""}">#${pr.number}</a> mergeado</li>`;
        }
        html += `</ul>`;
    } else {
        html += `<p><em>No se completaron issues con PR mergeado en este sprint.</em></p>`;
    }

    // --- Problemas encontrados ---
    html += `
<!-- PROBLEMAS ENCONTRADOS -->
<h2>3. Problemas encontrados y resoluciones</h2>`;

    const activityProblems = problemsData.activityProblems || [];
    const prProblems = problemsData.prProblems || [];
    const hasProblems = activityProblems.length > 0 || prProblems.length > 0;

    if (hasProblems) {
        if (activityProblems.length > 0) {
            html += `<h3>Desde actividad de agentes</h3><ul>`;
            // Agrupar y limitar a 10
            const shown = activityProblems.slice(0, 10);
            for (const p of shown) {
                const icon = p.isResolution ? "&#x2705;" : "&#x26A0;&#xFE0F;";
                html += `<li>${icon} <code>${escapeHtml(p.tool)}</code> — ${escapeHtml(p.description.substring(0, 120))} <small>(${p.time})</small></li>`;
            }
            if (activityProblems.length > 10) {
                html += `<li><em>... y ${activityProblems.length - 10} más</em></li>`;
            }
            html += `</ul>`;
        }
        if (prProblems.length > 0) {
            html += `<h3>Desde Pull Requests</h3><ul>`;
            for (const p of prProblems) {
                html += `<li>PR <strong>#${p.prNumber}</strong> — ${escapeHtml(p.prTitle)}<ul>`;
                for (const line of p.lines) {
                    html += `<li><small>${escapeHtml(line.substring(0, 150))}</small></li>`;
                }
                html += `</ul></li>`;
            }
            html += `</ul>`;
        }
    } else {
        html += `<p><em>No se detectaron problemas significativos durante este sprint.</em></p>`;
    }

    // --- Deuda técnica ---
    html += `
<!-- DEUDA TÉCNICA -->
<h2>4. Deuda técnica y próximos pasos</h2>`;

    const debt = debtData || [];
    if (debt.length > 0) {
        html += `<p>Los siguientes issues del sprint quedaron abiertos y deberían considerarse para el próximo sprint:</p>
<table>
  <thead>
    <tr><th>#</th><th>Título</th><th>Estado</th></tr>
  </thead>
  <tbody>`;
        for (const d of debt) {
            html += `
    <tr>
      <td><a href="${d.url}">#${d.issue}</a></td>
      <td>${escapeHtml(d.title)}</td>
      <td><span class="badge badge-open">${d.state}</span></td>
    </tr>`;
        }
        html += `
  </tbody>
</table>`;
    } else {
        html += `<p><em>Todos los issues del sprint fueron completados. No hay deuda técnica pendiente.</em></p>`;
    }

    html += `

<!-- ISSUES -->
<h2>5. Issues del Sprint</h2>
<table>
  <thead>
    <tr><th>#</th><th>Issue</th><th>Título</th><th>Stream</th><th>Size</th><th>Estado</th><th>Duración</th></tr>
  </thead>
  <tbody>`;

    for (const ag of agentes) {
        const info = issueInfos[ag.issue] || {};
        const summary = agentSummaries[ag.issue] || {};
        const pr = sprintPRs.find(p => p.headRefName === `agent/${ag.issue}-${ag.slug}`);
        const stateBadge = info.state === "CLOSED"
            ? `<span class="badge badge-closed">CLOSED</span>`
            : `<span class="badge badge-open">OPEN</span>`;
        const prInfo = pr
            ? ` — PR <a href="${pr.url || ""}">#${pr.number}</a> <span class="badge badge-${pr.state === "MERGED" ? "merged" : "open"}">${pr.state}</span>`
            : "";
        const dur = summary.durationMin != null ? `${summary.durationMin} min` : "N/A";

        html += `
    <tr>
      <td>${ag.numero}</td>
      <td><a href="https://github.com/intrale/platform/issues/${ag.issue}">#${ag.issue}</a></td>
      <td>${escapeHtml(ag.titulo || info.title || "")}</td>
      <td><span class="badge badge-stream">${ag.stream || "E"}</span></td>
      <td><span class="badge badge-size">${ag.size || "M"}</span></td>
      <td>${stateBadge}${prInfo}</td>
      <td>${dur}</td>
    </tr>`;
    }

    html += `
  </tbody>
</table>

<!-- DETALLE POR AGENTE -->
<h2>6. Detalle por Agente</h2>`;

    for (const ag of agentes) {
        const summary = agentSummaries[ag.issue] || {};
        if (!summary.found) {
            html += `
<div class="section-box">
  <h3>Agente ${ag.numero} — #${ag.issue} ${escapeHtml(ag.slug)}</h3>
  <p><em>Sin datos de sesión disponibles</em></p>
</div>`;
            continue;
        }

        const taskBar = summary.tasksTotal > 0
            ? `${summary.tasksCompleted}/${summary.tasksTotal} completadas`
            : "Sin tareas registradas";

        html += `
<div class="section-box">
  <h3>Agente ${ag.numero} — #${ag.issue} ${escapeHtml(ag.slug)}</h3>
  <table>
    <tr><td><strong>Nombre</strong></td><td>${escapeHtml(summary.agentName)}</td></tr>
    <tr><td><strong>Rama</strong></td><td><code>${escapeHtml(summary.branch || "N/A")}</code></td></tr>
    <tr><td><strong>Tareas</strong></td><td>${taskBar}</td></tr>
    <tr><td><strong>Acciones</strong></td><td>${summary.actionCount} (${escapeHtml(summary.topTools || "N/A")})</td></tr>
    <tr><td><strong>Skills</strong></td><td>${summary.skillsInvoked.length > 0 ? escapeHtml(summary.skillsInvoked.join(", ")) : "Ninguno"}</td></tr>
    <tr><td><strong>Duración</strong></td><td>${summary.durationMin} min</td></tr>
    <tr><td><strong>Inicio</strong></td><td>${formatDateAR(summary.startedTs)}</td></tr>
    <tr><td><strong>Fin</strong></td><td>${formatDateAR(summary.endedTs)}</td></tr>
  </table>
</div>`;
    }

    // --- Timeline desde activity-log ---
    html += `
<!-- TIMELINE -->
<h2>7. Línea de Tiempo</h2>
<div class="timeline">`;

    // Reconstruir timeline desde activity-log
    const activityLog = path.join(REPO_ROOT, ".claude", "activity-log.jsonl");
    const timelineEvents = buildTimelineEvents(activityLog, agentes, plan);
    for (const evt of timelineEvents) {
        html += `
  <div class="timeline-item ${evt.type}">
    <div class="timeline-time">${evt.time}</div>
    <div class="timeline-title">${escapeHtml(evt.title)}</div>
    <div class="timeline-detail">${escapeHtml(evt.detail)}</div>
  </div>`;
    }

    html += `
</div>

<!-- WORKTREES -->
<h2>8. Estado de Worktrees</h2>
<table>
  <thead>
    <tr><th>Ruta</th><th>Rama</th></tr>
  </thead>
  <tbody>`;

    for (const wt of worktrees) {
        const dirName = path.basename(wt.path);
        html += `
    <tr>
      <td><code>${escapeHtml(dirName)}</code></td>
      <td><code>${escapeHtml(wt.branch || (wt.detached ? "detached" : "N/A"))}</code></td>
    </tr>`;
    }

    html += `
  </tbody>
</table>

<!-- PRs -->
<h2>9. Pull Requests del Sprint</h2>`;

    if (sprintPRs.length > 0) {
        html += `
<table>
  <thead>
    <tr><th>PR</th><th>Título</th><th>Rama</th><th>Estado</th></tr>
  </thead>
  <tbody>`;

        for (const pr of sprintPRs) {
            const badge = pr.state === "MERGED" ? "merged" : pr.state === "OPEN" ? "open" : "closed";
            html += `
    <tr>
      <td><a href="${pr.url || ""}">#${pr.number}</a></td>
      <td>${escapeHtml(pr.title)}</td>
      <td><code>${escapeHtml(pr.headRefName || "")}</code></td>
      <td><span class="badge badge-${badge}">${pr.state}</span></td>
    </tr>`;
        }

        html += `
  </tbody>
</table>`;
    } else {
        html += `<p><em>No se encontraron PRs asociados al sprint.</em></p>`;
    }

    // --- CI ---
    if (sprintCIRuns.length > 0) {
        html += `
<!-- CI -->
<h2>10. Estado de CI</h2>
<table>
  <thead>
    <tr><th>Rama</th><th>Estado</th><th>Conclusión</th><th>Actualizado</th></tr>
  </thead>
  <tbody>`;

        for (const run of sprintCIRuns) {
            html += `
    <tr>
      <td><code>${escapeHtml(run.headBranch)}</code></td>
      <td>${escapeHtml(run.status)}</td>
      <td>${escapeHtml(run.conclusion || "en progreso")}</td>
      <td>${formatDateAR(run.updatedAt)}</td>
    </tr>`;
        }

        html += `
  </tbody>
</table>`;
    }

    // --- Footer ---
    html += `
<div class="footer">
  <p>Generado automáticamente el ${fecha} | Intrale Platform | Sprint Report</p>
  <p>Modelo: Claude Opus 4.6 | Tema: <code>${escapeHtml(tema)}</code></p>
</div>

</body>
</html>`;

    return html;
}

/**
 * Construye eventos de timeline desde activity-log.
 */
function buildTimelineEvents(activityLogPath, agentes, plan) {
    const events = [];

    // Evento de inicio del sprint
    events.push({
        time: (plan.started_at || "").split("T")[0] || "Sprint",
        title: `Sprint iniciado — ${agentes.length} agentes`,
        detail: `Tema: ${plan.tema || "N/A"}`,
        type: "info"
    });

    // Agregar skills invocados como eventos
    try {
        if (!fs.existsSync(activityLogPath)) return events;
        const lines = fs.readFileSync(activityLogPath, "utf8").split("\n").filter(Boolean);
        const sessionIds = new Set();

        // Recopilar session IDs de agentes del sprint (sesiones que matchean ramas del sprint)
        const sessionsDir = path.join(REPO_ROOT, ".claude", "sessions");
        if (fs.existsSync(sessionsDir)) {
            const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".json"));
            for (const file of files) {
                try {
                    const sess = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), "utf8"));
                    for (const ag of agentes) {
                        if (sess.branch && sess.branch.includes(String(ag.issue))) {
                            sessionIds.add(file.replace(".json", ""));
                        }
                    }
                } catch (e) { /* skip */ }
            }
        }

        // Filtrar y resumir entradas de activity log
        const skillEvents = {};
        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                if (!sessionIds.has(entry.session)) continue;
                if (entry.tool === "Skill") {
                    const key = `${entry.session}-${entry.target}`;
                    if (!skillEvents[key]) {
                        skillEvents[key] = {
                            time: formatDateAR(entry.ts),
                            title: `Skill invocado: ${entry.target}`,
                            detail: `Sesión: ${entry.session}`,
                            type: "success"
                        };
                    }
                }
            } catch (e) { /* skip */ }
        }
        events.push(...Object.values(skillEvents));
    } catch (e) {
        log("Error construyendo timeline: " + e.message);
    }

    // Evento de fin
    events.push({
        time: formatDateAR(new Date().toISOString()),
        title: "Sprint finalizado — Reporte generado",
        detail: `${agentes.length} agentes procesados`,
        type: "success"
    });

    return events;
}

// --- Main ---
async function main() {
    const startTime = Date.now();
    log("=== sprint-report.js iniciado ===");

    // Leer sprint plan
    const planPath = process.argv[2] || path.join(__dirname, "sprint-plan.json");
    const plan = (() => {
        try {
            return JSON.parse(fs.readFileSync(planPath, "utf8"));
        } catch (e) {
            log("Error leyendo sprint plan: " + e.message);
            return null;
        }
    })();

    if (!plan || !plan.agentes || plan.agentes.length === 0) {
        log("Plan vacío o inválido. Abortando.");
        process.exit(0);
    }

    log(`Plan: ${plan.sprint_id || (plan.started_at || "").split("T")[0]}, ${plan.agentes.length} agentes`);

    // Snapshot de sesiones (antes de que se limpien)
    const sessions = snapshotSessions();
    log(`Sesiones snapshot: ${Object.keys(sessions).length}`);

    // Recopilar datos de cada agente
    const issueInfos = {};
    const agentSummaries = {};

    for (const ag of plan.agentes) {
        // Issue info desde GitHub
        issueInfos[ag.issue] = getIssueInfo(ag.issue);

        // Buscar sesión correspondiente al agente
        let sessionId = null;
        for (const [sid, sess] of Object.entries(sessions)) {
            if (sess.branch && sess.branch.includes(String(ag.issue))) {
                sessionId = sid;
                break;
            }
        }

        if (sessionId) {
            agentSummaries[ag.issue] = buildExecutionSummary(sessionId, REPO_ROOT);
            log(`Agente ${ag.numero} (issue #${ag.issue}): sesión ${sessionId}`);
        } else {
            agentSummaries[ag.issue] = { found: false };
            log(`Agente ${ag.numero} (issue #${ag.issue}): sin sesión encontrada`);
        }
    }

    // PRs y CI
    const prs = getPRsForSprint();
    const ciRuns = getCIRuns();
    const worktrees = getWorktreeList();

    // Duración total
    const sprintDurationMin = Math.round((Date.now() - startTime) / 60000) || (() => {
        // Intentar calcular desde sesiones
        let minStart = Infinity, maxEnd = 0;
        for (const s of Object.values(agentSummaries)) {
            if (s.startedTs) minStart = Math.min(minStart, new Date(s.startedTs).getTime());
            if (s.endedTs) maxEnd = Math.max(maxEnd, new Date(s.endedTs).getTime());
        }
        return minStart < Infinity && maxEnd > 0 ? Math.round((maxEnd - minStart) / 60000) : 0;
    })();

    // Recopilar datos para secciones enriquecidas
    const sprintBranches = new Set(plan.agentes.map(a => `agent/${a.issue}-${a.slug}`));
    const sprintPRs = prs.filter(pr => sprintBranches.has(pr.headRefName));

    // Session IDs del sprint para filtrar activity log
    const sprintSessionIds = new Set();
    const sessionsDir2 = path.join(REPO_ROOT, ".claude", "sessions");
    if (fs.existsSync(sessionsDir2)) {
        const files = fs.readdirSync(sessionsDir2).filter(f => f.endsWith(".json"));
        for (const file of files) {
            try {
                const sess = JSON.parse(fs.readFileSync(path.join(sessionsDir2, file), "utf8"));
                for (const ag of plan.agentes) {
                    if (sess.branch && sess.branch.includes(String(ag.issue))) {
                        sprintSessionIds.add(file.replace(".json", ""));
                    }
                }
            } catch (e) { /* skip */ }
        }
    }

    const activityLogPath = path.join(REPO_ROOT, ".claude", "activity-log.jsonl");
    const activityProblems = extractProblemsFromActivityLog(activityLogPath, sprintSessionIds);
    const prProblems = extractProblemsFromPRs(sprintPRs);
    const problemsData = { activityProblems, prProblems };
    const debtData = extractTechnicalDebt(plan.agentes, issueInfos);

    log(`Datos enriquecidos: ${activityProblems.length} problemas en activity, ${prProblems.length} en PRs, ${debtData.length} deuda técnica`);

    // Generar HTML
    const fecha = (plan.started_at || "").split("T")[0] || new Date().toISOString().split("T")[0];
    const htmlFileName = `reporte-sprint-${plan.sprint_id || fecha}.html`;
    const htmlPath = path.join(QA_DIR, htmlFileName);
    const html = buildHtml(plan, issueInfos, agentSummaries, prs, ciRuns, worktrees, sprintDurationMin, problemsData, debtData);

    ensureDir(QA_DIR);
    fs.writeFileSync(htmlPath, html, "utf8");
    log(`HTML generado: ${htmlPath}`);

    // Generar PDF y enviar a Telegram via script unificado
    const mergedCount = prs.filter(p =>
        plan.agentes.some(a => p.headRefName === `agent/${a.issue}-${a.slug}`) && p.state === "MERGED"
    ).length;
    const sprintIdLabel = plan.sprint_id ? plan.sprint_id + " — " : "";
    const caption = sanitizeUtf8(`📋 ${sprintIdLabel}Sprint ${fecha} — ${plan.agentes.length} issues, ${mergedCount} PRs merged`);
    sendReportViaTelegram(htmlPath, caption);

    // Paso 1: Tag de sprint (siempre, sin condiciones)
    log("--- Iniciando sprint-tagger.js ---");
    execSafe(`node "${path.join(__dirname, "sprint-tagger.js")}" "${planPath}"`, { timeout: 60000 });
    log("--- sprint-tagger.js completado ---");

    // Paso 2: Evaluar y crear release (autónomo)
    log("--- Iniciando evaluate-and-release.js ---");
    execSafe(`node "${path.join(__dirname, "evaluate-and-release.js")}" "${planPath}"`, { timeout: 60000 });
    log("--- evaluate-and-release.js completado ---");

    // Paso 3: Generar reporte de costos del sprint (fail-open)
    const costReportScript = path.join(__dirname, "cost-report.js");
    if (fs.existsSync(costReportScript)) {
        log("--- Iniciando cost-report.js ---");
        const sprintFlag = plan.sprint_id ? `--sprint ${plan.sprint_id}` : "";
        execSafe(`node "${costReportScript}" --telegram ${sprintFlag}`, { timeout: 120000 });
        log("--- cost-report.js completado ---");
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    log(`=== sprint-report.js completado en ${elapsed}s ===`);
}

// Ejecutar y capturar errores (fail-open)
main().catch(e => {
    log("ERROR FATAL: " + e.message + "\n" + e.stack);
    process.exit(0); // exit 0 para no interrumpir el flujo
});
