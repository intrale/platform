// scrum-auto-corrections.js — Auditoría de coherencia estado-columna en Project V2
// Detecta y corrige automáticamente inconsistencias entre el estado real de un issue
// (open/closed, labels) y su columna en el Project V2.
//
// Reglas de coherencia (centralizadas en COHERENCE_RULES):
//   1. Issue CLOSED + Status ≠ Done → mover a Done
//   2. Issue OPEN + label 'in-progress' + Status en columna Backlog → mover a In Progress
//   3. Issue OPEN + label 'ready' + Status en columna Backlog → mover a Ready
//   4. Issue OPEN + sin label 'blocked' + Status = Blocked → mover a Todo
//   5. Issue OPEN + label 'blocked' + Status ≠ Blocked → advertencia (no auto-corrección)
//
// Uso CLI:
//   node scrum-auto-corrections.js            → dry-run (detecta pero no aplica)
//   node scrum-auto-corrections.js --auto     → aplica correcciones automáticamente
//   node scrum-auto-corrections.js --report   → genera reporte HTML
//
// Output: JSON con { corrections, warnings, report }

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

// ─── Configuración ────────────────────────────────────────────────────────────

const HOOKS_DIR = __dirname;
const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || path.resolve(HOOKS_DIR, "..", "..");
const GH_CLI = "/c/Workspaces/gh-cli/bin/gh.exe";
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");
const AUDIT_FILE = path.join(HOOKS_DIR, "sprint-audit.jsonl");
const CORRECTIONS_REPORT_FILE = path.join(HOOKS_DIR, "scrum-corrections-report.json");

// IDs del Project V2 "Intrale"
const PROJECT_ID = "PVT_kwDOBTzBoc4AyMGf";
const FIELD_ID = "PVTSSF_lADOBTzBoc4AyMGfzgoLqjg";
const GH_REPO = "intrale/platform";

// Status options descubiertos en tiempo de ejecución
// (se populan en getStatusOptions(), solo Done está hardcodeado por compatibilidad)
const STATUS_OPTIONS_KNOWN = {
    "Done": "b30e67ed"
};

// ─── Reglas de coherencia centralizadas ──────────────────────────────────────
//
// Cada regla tiene:
//   id          — identificador único para logs y auditoría
//   description — descripción legible para el reporte
//   priority    — orden de evaluación (1 = máxima prioridad, se detiene en la primera que aplica)
//   check(item) — función que evalúa si el issue tiene la inconsistencia
//   targetStatus — nombre de la columna correcta
//   reason(item) — función que genera el texto de la razón para el comentario
//   severity    — 'high' | 'medium' | 'low'
//   autoFix     — true: se corrige automáticamente | false: solo se advierte

const COHERENCE_RULES = [
    {
        id: "closed_not_done",
        description: "Issue cerrado que no está en Done",
        priority: 1,
        severity: "high",
        autoFix: true,
        check: (item) => {
            return item.state === "CLOSED" && item.currentStatus !== "Done";
        },
        targetStatus: "Done",
        reason: (item) => `Issue cerrado (state: CLOSED) detectado en columna "${item.currentStatus}".`
    },
    {
        id: "in_progress_label_in_backlog",
        description: "Issue con label 'in-progress' en columna Backlog",
        priority: 2,
        severity: "high",
        autoFix: true,
        check: (item) => {
            return item.state === "OPEN" &&
                   item.labels.includes("in-progress") &&
                   isBacklogColumn(item.currentStatus);
        },
        targetStatus: "In Progress",
        reason: (item) => `Issue con label "in-progress" detectado en columna Backlog ("${item.currentStatus}").`
    },
    {
        id: "ready_label_in_backlog",
        description: "Issue con label 'ready' en columna Backlog genérico",
        priority: 3,
        severity: "medium",
        autoFix: true,
        check: (item) => {
            return item.state === "OPEN" &&
                   item.labels.includes("ready") &&
                   isBacklogColumn(item.currentStatus);
        },
        targetStatus: "Ready",
        reason: (item) => `Issue con label "ready" detectado en columna Backlog ("${item.currentStatus}").`
    },
    {
        id: "blocked_status_no_label",
        description: "Issue en columna Blocked sin label 'blocked'",
        priority: 4,
        severity: "medium",
        autoFix: true,
        check: (item) => {
            return item.state === "OPEN" &&
                   item.currentStatus === "Blocked" &&
                   !item.labels.includes("blocked");
        },
        targetStatus: "Todo",
        reason: (item) => `Issue en columna "Blocked" sin label "blocked". Sin evidencia de bloqueo activo.`
    },
    {
        id: "blocked_label_not_in_blocked",
        description: "Issue con label 'blocked' que no está en columna Blocked",
        priority: 5,
        severity: "low",
        autoFix: false, // Solo advertencia — no se mueve automáticamente
        check: (item) => {
            return item.state === "OPEN" &&
                   item.labels.includes("blocked") &&
                   item.currentStatus !== "Blocked" &&
                   !isBacklogColumn(item.currentStatus) &&
                   item.currentStatus !== "Done";
        },
        targetStatus: "Blocked",
        reason: (item) => `Issue tiene label "blocked" pero está en columna "${item.currentStatus}". Considerar mover a Blocked.`
    }
];

// Columnas que se consideran "Backlog" para las reglas de coherencia
const BACKLOG_COLUMNS = [
    "Backlog Tecnico",
    "Backlog CLIENTE",
    "Backlog NEGOCIO",
    "Backlog DELIVERY",
    "Todo",
    "Refined"
];

function isBacklogColumn(status) {
    return BACKLOG_COLUMNS.includes(status);
}

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
    try {
        fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] ScrumAutoCorrections: " + msg + "\n");
    } catch (e) {}
}

function appendAudit(entry) {
    try {
        fs.appendFileSync(AUDIT_FILE, JSON.stringify({
            timestamp: new Date().toISOString(),
            source: "scrum-auto-corrections",
            ...entry
        }) + "\n");
    } catch (e) {
        log("Error escribiendo audit log: " + e.message);
    }
}

// ─── GitHub Auth ──────────────────────────────────────────────────────────────

function getGitHubToken() {
    try {
        const token = execSync(GH_CLI + " auth token", {
            encoding: "utf8",
            cwd: REPO_ROOT,
            timeout: 5000,
            windowsHide: true
        }).trim();
        if (token) return token;
    } catch (e) {}

    const credInput = "protocol=https\nhost=github.com\n\n";
    const result = execSync("git credential fill", {
        input: credInput,
        encoding: "utf8",
        cwd: REPO_ROOT,
        timeout: 5000,
        windowsHide: true
    });
    const match = result.match(/password=(.+)/);
    if (!match) throw new Error("No se encontró token GitHub");
    return match[1].trim();
}

// ─── GraphQL helpers ──────────────────────────────────────────────────────────

function graphqlRequest(token, query, variables) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({ query, variables: variables || {} });
        const req = https.request({
            hostname: "api.github.com",
            path: "/graphql",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData),
                "Authorization": "bearer " + token,
                "User-Agent": "intrale-scrum-auto-corrections"
            },
            timeout: 15000
        }, (res) => {
            let data = "";
            res.on("data", (c) => data += c);
            res.on("end", () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.errors && parsed.errors.length > 0) {
                        reject(new Error(parsed.errors[0].message));
                    } else {
                        resolve(parsed.data);
                    }
                } catch (e) {
                    reject(new Error("Error parseando respuesta GraphQL: " + e.message));
                }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout en GraphQL")); });
        req.on("error", (e) => reject(e));
        req.write(postData);
        req.end();
    });
}

// ─── Obtener options IDs dinámicamente ───────────────────────────────────────

async function getStatusOptions(token) {
    const query = `query {
        organization(login: "intrale") {
            projectV2(number: 1) {
                field(name: "Status") {
                    ... on ProjectV2SingleSelectField {
                        id
                        options {
                            id
                            name
                        }
                    }
                }
            }
        }
    }`;

    const data = await graphqlRequest(token, query);
    const options = data &&
                    data.organization &&
                    data.organization.projectV2 &&
                    data.organization.projectV2.field &&
                    data.organization.projectV2.field.options;

    if (!options) throw new Error("No se pudieron obtener las opciones de Status del proyecto");

    const result = {};
    for (const opt of options) {
        result[opt.name] = opt.id;
    }

    // Fusionar con known (Done hardcodeado para compatibilidad)
    return { ...result, ...STATUS_OPTIONS_KNOWN };
}

// ─── Snapshot del board (con paginación) ─────────────────────────────────────

async function getBoardSnapshot(token) {
    const items = [];
    let cursor = null;
    let hasNextPage = true;
    let pageCount = 0;

    while (hasNextPage) {
        pageCount++;
        const query = `query($cursor: String) {
            organization(login: "intrale") {
                projectV2(number: 1) {
                    items(first: 100, after: $cursor) {
                        pageInfo { hasNextPage endCursor }
                        nodes {
                            id
                            content {
                                ... on Issue {
                                    number
                                    title
                                    state
                                    labels(first: 20) { nodes { name } }
                                    closedAt
                                    updatedAt
                                }
                                ... on PullRequest {
                                    number
                                    title
                                    state
                                    mergedAt
                                }
                            }
                            fieldValues(first: 10) {
                                nodes {
                                    ... on ProjectV2ItemFieldSingleSelectValue {
                                        name
                                        field { ... on ProjectV2SingleSelectField { name } }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }`;

        const variables = cursor ? { cursor } : {};
        const data = await graphqlRequest(token, query, variables);
        const projectItems = data &&
                             data.organization &&
                             data.organization.projectV2 &&
                             data.organization.projectV2.items;

        if (!projectItems) break;

        hasNextPage = projectItems.pageInfo.hasNextPage;
        cursor = projectItems.pageInfo.endCursor;

        for (const node of projectItems.nodes) {
            if (!node.content || !node.content.number) continue;

            // Solo procesar issues (no PRs)
            if (node.content.mergedAt !== undefined && node.content.state !== "CLOSED" &&
                node.content.mergedAt !== undefined) {
                continue; // Es un PR
            }
            if (node.content.mergedAt !== undefined) continue; // Es un PR

            // Extraer status actual
            let currentStatus = null;
            for (const fv of (node.fieldValues.nodes || [])) {
                if (fv.field && fv.field.name === "Status") {
                    currentStatus = fv.name;
                    break;
                }
            }

            const labels = (node.content.labels && node.content.labels.nodes || [])
                .map(l => l.name);

            items.push({
                itemId: node.id,
                number: node.content.number,
                title: node.content.title,
                state: node.content.state, // OPEN | CLOSED
                labels,
                currentStatus,
                closedAt: node.content.closedAt || null,
                updatedAt: node.content.updatedAt || null
            });
        }

        log(`Página ${pageCount} del board: ${items.length} items hasta ahora`);

        if (pageCount > 20) {
            log("Límite de paginación alcanzado (20 páginas)");
            break;
        }
    }

    return items;
}

// ─── Evaluar reglas de coherencia ────────────────────────────────────────────

function evaluateCoherenceRules(items) {
    const corrections = []; // autoFix: true — se corrigen
    const warnings = [];    // autoFix: false — solo se advierte
    const ok = [];          // sin inconsistencias

    for (const item of items) {
        // Evaluar reglas en orden de prioridad
        let matched = false;

        const sortedRules = [...COHERENCE_RULES].sort((a, b) => a.priority - b.priority);

        for (const rule of sortedRules) {
            if (rule.check(item)) {
                const entry = {
                    ruleId: rule.id,
                    description: rule.description,
                    severity: rule.severity,
                    issue: item.number,
                    title: item.title,
                    state: item.state,
                    labels: item.labels,
                    currentStatus: item.currentStatus,
                    targetStatus: rule.targetStatus,
                    reason: rule.reason(item),
                    autoFix: rule.autoFix,
                    itemId: item.itemId,
                    detectedAt: new Date().toISOString()
                };

                if (rule.autoFix) {
                    corrections.push(entry);
                } else {
                    warnings.push(entry);
                }

                matched = true;
                break; // Prioridad: solo aplicar la primera regla que aplica
            }
        }

        if (!matched) {
            ok.push({ issue: item.number, currentStatus: item.currentStatus });
        }
    }

    return { corrections, warnings, ok };
}

// ─── Mover issue en Project V2 ────────────────────────────────────────────────

async function moveItemInProject(token, itemId, optionId, statusName, issueNumber) {
    const mutation = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: {
            projectId: $projectId
            itemId: $itemId
            fieldId: $fieldId
            value: { singleSelectOptionId: $optionId }
        }) {
            projectV2Item { id }
        }
    }`;

    await graphqlRequest(token, mutation, {
        projectId: PROJECT_ID,
        itemId: itemId,
        fieldId: FIELD_ID,
        optionId: optionId
    });

    log(`Issue #${issueNumber} movido a ${statusName}`);
    return true;
}

// ─── Comentar en el issue ─────────────────────────────────────────────────────

async function commentOnIssue(issueNumber, fromStatus, toStatus, reason) {
    // Validar que issueNumber es un entero para evitar injection en shell command
    const safeIssueNumber = parseInt(issueNumber, 10);
    if (!safeIssueNumber || safeIssueNumber <= 0) {
        log(`issueNumber inválido: ${issueNumber} — skipping comment`);
        return false;
    }

    const timestamp = new Date().toISOString();
    const comment = `🔄 Scrum Master: movido de **${fromStatus}** → **${toStatus}**. Razón: ${reason}\n\n_Detección automática: ${timestamp}_`;

    const tmpFile = path.join(HOOKS_DIR, `tmp-scrum-comment-${safeIssueNumber}-${Date.now()}.txt`);
    try {
        fs.writeFileSync(tmpFile, comment, "utf8");
        execSync(
            `${GH_CLI} issue comment ${safeIssueNumber} --repo ${GH_REPO} --body-file "${tmpFile.replace(/\\/g, "/")}"`,
            { encoding: "utf8", cwd: REPO_ROOT, timeout: 15000, windowsHide: true }
        );
        log(`Comentario agregado a issue #${safeIssueNumber}`);
        return true;
    } catch (e) {
        log(`Error comentando issue #${safeIssueNumber}: ${e.message}`);
        return false;
    } finally {
        try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (e) {}
    }
}

// ─── Rate limiting ────────────────────────────────────────────────────────────

// Máximo 30 mutations por minuto según criterios de aceptación
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60 * 1000;

async function applyWithRateLimit(corrections, token, statusOptions) {
    const results = [];
    let mutationsThisWindow = 0;
    let windowStart = Date.now();

    for (let i = 0; i < corrections.length; i++) {
        const correction = corrections[i];

        // Verificar rate limit
        const now = Date.now();
        if (now - windowStart >= RATE_WINDOW_MS) {
            // Nueva ventana
            mutationsThisWindow = 0;
            windowStart = now;
        }

        if (mutationsThisWindow >= RATE_LIMIT) {
            // Esperar el resto de la ventana
            const waitMs = RATE_WINDOW_MS - (now - windowStart) + 100;
            log(`Rate limit alcanzado (${RATE_LIMIT}/min). Esperando ${Math.round(waitMs / 1000)}s...`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
            mutationsThisWindow = 0;
            windowStart = Date.now();
        }

        // Reportar progreso en batches
        if (i > 0 && i % RATE_LIMIT === 0) {
            log(`Batch ${Math.floor(i / RATE_LIMIT)}/${Math.ceil(corrections.length / RATE_LIMIT)} completado (${i} correcciones)`);
        }

        const result = await applyCorrection(token, correction, statusOptions);
        results.push(result);
        mutationsThisWindow += result.mutations || 0;
    }

    return results;
}

async function applyCorrection(token, correction, statusOptions) {
    const result = {
        ruleId: correction.ruleId,
        issue: correction.issue,
        title: correction.title,
        from: correction.currentStatus,
        to: correction.targetStatus,
        reason: correction.reason,
        status: "pending",
        mutations: 0,
        timestamp: new Date().toISOString()
    };

    try {
        const optionId = statusOptions[correction.targetStatus];
        if (!optionId) {
            result.status = "error";
            result.error = `No se encontró option ID para "${correction.targetStatus}"`;
            log(`Error: no hay option ID para ${correction.targetStatus}`);
            return result;
        }

        // 1. Mover en el board
        await moveItemInProject(
            token,
            correction.itemId,
            optionId,
            correction.targetStatus,
            correction.issue
        );
        result.mutations++;

        // 2. Comentar en el issue
        const commented = await commentOnIssue(
            correction.issue,
            correction.currentStatus,
            correction.targetStatus,
            correction.reason
        );

        result.status = "ok";
        result.commented = commented;

        // 3. Registrar en audit log
        appendAudit({
            action: correction.ruleId,
            issue: correction.issue,
            from_status: correction.currentStatus,
            to_status: correction.targetStatus,
            reason: correction.reason,
            status: "ok"
        });

        log(`Corrección aplicada: #${correction.issue} ${correction.currentStatus} → ${correction.targetStatus}`);

    } catch (e) {
        result.status = "error";
        result.error = e.message;
        result.mutations = 0;

        appendAudit({
            action: correction.ruleId,
            issue: correction.issue,
            from_status: correction.currentStatus,
            to_status: correction.targetStatus,
            reason: correction.reason,
            status: "error",
            error: e.message
        });

        log(`Error en corrección #${correction.issue}: ${e.message}`);
    }

    return result;
}

// ─── Generar reporte HTML ─────────────────────────────────────────────────────

function generateHtmlReport(runResult) {
    const { corrections, warnings, appliedResults, dryRun, timestamp, boardItemCount } = runResult;

    const correctionRows = (appliedResults || corrections.map(c => ({ ...c, status: "dry_run" })))
        .map(r => `
            <tr class="${r.status === 'ok' ? 'ok' : r.status === 'error' ? 'error' : 'dry'}">
                <td>#${r.issue}</td>
                <td>${escapeHtml(r.title || "")}</td>
                <td>${escapeHtml(r.from || "")}</td>
                <td>${escapeHtml(r.to || "")}</td>
                <td>${r.status === 'ok' ? '✅ Aplicada' : r.status === 'error' ? '❌ Error: ' + escapeHtml(r.error || '') : '🔎 Detectada (dry-run)'}</td>
                <td>${escapeHtml(r.reason || "")}</td>
            </tr>`).join("");

    const warningRows = warnings.map(w => `
            <tr class="warning">
                <td>#${w.issue}</td>
                <td>${escapeHtml(w.title || "")}</td>
                <td>${escapeHtml(w.currentStatus || "")}</td>
                <td>${escapeHtml(w.targetStatus || "")}</td>
                <td>⚠️ Advertencia</td>
                <td>${escapeHtml(w.reason || "")}</td>
            </tr>`).join("");

    const okCount = (appliedResults || []).filter(r => r.status === "ok").length;
    const errorCount = (appliedResults || []).filter(r => r.status === "error").length;
    const health = corrections.length === 0 && warnings.length === 0 ? "🟢 Sano" :
                   corrections.length <= 3 ? "🟡 Atención" : "🔴 Crítico";

    return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <title>Reporte de Correcciones Scrum — ${timestamp}</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; color: #333; }
        h1 { color: #1a1a2e; border-bottom: 2px solid #4CAF50; padding-bottom: 10px; }
        h2 { color: #16213e; margin-top: 30px; }
        .summary { background: #f8f9fa; border-left: 4px solid #4CAF50; padding: 15px; margin: 20px 0; }
        .summary p { margin: 5px 0; }
        table { border-collapse: collapse; width: 100%; margin: 15px 0; }
        th { background: #1a1a2e; color: white; padding: 10px; text-align: left; }
        td { padding: 8px 10px; border-bottom: 1px solid #ddd; }
        tr.ok { background: #e8f5e9; }
        tr.error { background: #ffebee; }
        tr.dry { background: #fff3e0; }
        tr.warning { background: #fff8e1; }
        .badge-ok { background: #4CAF50; color: white; padding: 2px 8px; border-radius: 3px; }
        .badge-error { background: #f44336; color: white; padding: 2px 8px; border-radius: 3px; }
        .badge-warn { background: #ff9800; color: white; padding: 2px 8px; border-radius: 3px; }
        .health { font-size: 1.2em; font-weight: bold; }
        footer { margin-top: 40px; color: #888; font-size: 0.85em; border-top: 1px solid #ddd; padding-top: 10px; }
    </style>
</head>
<body>
    <h1>🔄 Reporte de Correcciones Automáticas — Scrum Master</h1>

    <div class="summary">
        <p><strong>Fecha de ejecución:</strong> ${timestamp}</p>
        <p><strong>Modo:</strong> ${dryRun ? "🔎 Dry-run (sin cambios aplicados)" : "✅ Automático (correcciones aplicadas)"}</p>
        <p><strong>Items en el board analizados:</strong> ${boardItemCount}</p>
        <p><strong>Inconsistencias detectadas:</strong> ${corrections.length}</p>
        <p><strong>Advertencias:</strong> ${warnings.length}</p>
        ${!dryRun ? `<p><strong>Correcciones OK:</strong> <span class="badge-ok">${okCount}</span></p>
        <p><strong>Errores:</strong> <span class="badge-error">${errorCount}</span></p>` : ""}
        <p class="health"><strong>Salud del board:</strong> ${health}</p>
    </div>

    <h2>Reglas de coherencia aplicadas</h2>
    <table>
        <tr><th>Prioridad</th><th>ID</th><th>Descripción</th><th>Auto-corrección</th><th>Severidad</th></tr>
        ${COHERENCE_RULES.map(r => `
        <tr>
            <td>${r.priority}</td>
            <td><code>${r.id}</code></td>
            <td>${r.description}</td>
            <td>${r.autoFix ? "✅ Sí" : "⚠️ Solo advertencia"}</td>
            <td>${r.severity === "high" ? "🔴 Alta" : r.severity === "medium" ? "🟡 Media" : "🟢 Baja"}</td>
        </tr>`).join("")}
    </table>

    <h2>Correcciones ${dryRun ? "detectadas" : "aplicadas"} (${corrections.length})</h2>
    ${corrections.length === 0
        ? "<p>✅ Sin inconsistencias que corregir. Board coherente.</p>"
        : `<table>
            <tr>
                <th>Issue</th>
                <th>Título</th>
                <th>Desde</th>
                <th>Hacia</th>
                <th>Estado</th>
                <th>Razón</th>
            </tr>
            ${correctionRows}
        </table>`}

    <h2>Advertencias (${warnings.length})</h2>
    ${warnings.length === 0
        ? "<p>✅ Sin advertencias.</p>"
        : `<table>
            <tr>
                <th>Issue</th>
                <th>Título</th>
                <th>Columna actual</th>
                <th>Columna sugerida</th>
                <th>Tipo</th>
                <th>Razón</th>
            </tr>
            ${warningRows}
        </table>`}

    <footer>
        <p>Generado por <strong>scrum-auto-corrections.js</strong> — Intrale Platform Scrum Master</p>
        <p>Repositorio: ${GH_REPO} | Proyecto V2: #1</p>
    </footer>
</body>
</html>`;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// ─── Función principal de auditoría y corrección ──────────────────────────────

async function runAutoCorrections(options = {}) {
    const dryRun = options.dryRun !== false; // por defecto: dry-run
    const generateReport = options.generateReport || false;
    const timestamp = new Date().toISOString();

    log(`Iniciando scrum-auto-corrections (dry_run=${dryRun})`);

    let token;
    try {
        token = getGitHubToken();
    } catch (e) {
        return {
            ok: false,
            error: "No se pudo obtener token GitHub: " + e.message,
            corrections: [],
            warnings: []
        };
    }

    // 1. Obtener options IDs dinámicamente
    let statusOptions;
    try {
        statusOptions = await getStatusOptions(token);
        log("Options IDs obtenidos: " + JSON.stringify(statusOptions));
    } catch (e) {
        return {
            ok: false,
            error: "No se pudieron obtener options del proyecto: " + e.message,
            corrections: [],
            warnings: []
        };
    }

    // 2. Obtener snapshot completo del board
    let boardItems;
    try {
        boardItems = await getBoardSnapshot(token);
        log(`Snapshot del board obtenido: ${boardItems.length} issues`);
    } catch (e) {
        return {
            ok: false,
            error: "No se pudo obtener snapshot del board: " + e.message,
            corrections: [],
            warnings: []
        };
    }

    // 3. Evaluar reglas de coherencia
    const { corrections, warnings, ok } = evaluateCoherenceRules(boardItems);
    log(`Evaluación: ${corrections.length} correcciones, ${warnings.length} advertencias, ${ok.length} OK`);

    // 4. Aplicar correcciones (si no es dry-run)
    let appliedResults = null;
    if (!dryRun && corrections.length > 0) {
        log(`Aplicando ${corrections.length} corrección(es)...`);
        appliedResults = await applyWithRateLimit(corrections, token, statusOptions);
        const okCount = appliedResults.filter(r => r.status === "ok").length;
        const errorCount = appliedResults.filter(r => r.status === "error").length;
        log(`Correcciones completadas: ${okCount} OK, ${errorCount} errores`);
    }

    // 5. Construir resultado final
    const runResult = {
        ok: true,
        dryRun,
        timestamp,
        boardItemCount: boardItems.length,
        corrections,
        warnings,
        appliedResults,
        summary: {
            total_items: boardItems.length,
            corrections_detected: corrections.length,
            warnings_detected: warnings.length,
            corrections_applied: appliedResults ? appliedResults.filter(r => r.status === "ok").length : 0,
            corrections_errors: appliedResults ? appliedResults.filter(r => r.status === "error").length : 0
        }
    };

    // 6. Guardar reporte JSON
    try {
        fs.writeFileSync(CORRECTIONS_REPORT_FILE, JSON.stringify(runResult, null, 2), "utf8");
        log(`Reporte JSON guardado en ${CORRECTIONS_REPORT_FILE}`);
    } catch (e) {
        log(`Error guardando reporte: ${e.message}`);
    }

    // 7. Generar reporte HTML (si se solicitó)
    if (generateReport) {
        const htmlReportPath = path.join(
            REPO_ROOT, "docs", "qa",
            `reporte-scrum-corrections-${timestamp.replace(/[:.]/g, "-").slice(0, 19)}.html`
        );
        try {
            const docsDir = path.join(REPO_ROOT, "docs", "qa");
            if (!fs.existsSync(docsDir)) {
                fs.mkdirSync(docsDir, { recursive: true });
            }
            const html = generateHtmlReport(runResult);
            fs.writeFileSync(htmlReportPath, html, "utf8");
            runResult.htmlReport = htmlReportPath;
            log(`Reporte HTML generado: ${htmlReportPath}`);

            // Intentar enviar por Telegram si está configurado
            try {
                const notifyScript = path.join(HOOKS_DIR, "notify-telegram.js");
                if (fs.existsSync(notifyScript)) {
                    const { sendHtmlReportToTelegram } = require(notifyScript);
                    if (typeof sendHtmlReportToTelegram === "function") {
                        await sendHtmlReportToTelegram(htmlReportPath, "Correcciones Scrum Auto");
                        log("Reporte enviado a Telegram");
                    }
                }
            } catch (e) {
                log("No se pudo enviar reporte a Telegram: " + e.message);
            }
        } catch (e) {
            log(`Error generando reporte HTML: ${e.message}`);
        }
    }

    return runResult;
}

// ─── Generar texto de reporte para incluir en audit de /scrum ─────────────────

function formatAuditSection(runResult) {
    const { corrections, warnings, appliedResults, dryRun, timestamp } = runResult;

    if (corrections.length === 0 && warnings.length === 0) {
        return "### Correcciones automáticas aplicadas\n✅ Sin inconsistencias detectadas. Board coherente.\n";
    }

    let lines = [];
    lines.push("### Correcciones automáticas aplicadas");
    lines.push("");
    lines.push(`**Ejecución:** ${timestamp}`);
    lines.push(`**Modo:** ${dryRun ? "Dry-run (detectadas, no aplicadas)" : "Automático"}`);
    lines.push("");

    if (corrections.length > 0) {
        lines.push(`#### Correcciones (${corrections.length})`);
        lines.push("| # | Issue | Desde | Hacia | Estado | Razón |");
        lines.push("|---|-------|-------|-------|--------|-------|");

        corrections.forEach((c, i) => {
            const applied = appliedResults && appliedResults[i];
            const statusStr = applied
                ? (applied.status === "ok" ? "✅ Aplicada" : "❌ Error")
                : "🔎 Detectada";
            lines.push(`| ${i + 1} | #${c.issue} | ${c.currentStatus} | ${c.targetStatus} | ${statusStr} | ${c.reason} |`);
        });
        lines.push("");
    }

    if (warnings.length > 0) {
        lines.push(`#### Advertencias (${warnings.length})`);
        lines.push("| # | Issue | Columna actual | Sugerencia | Razón |");
        lines.push("|---|-------|----------------|------------|-------|");

        warnings.forEach((w, i) => {
            lines.push(`| ${i + 1} | #${w.issue} | ${w.currentStatus} | ${w.targetStatus} | ${w.reason} |`);
        });
        lines.push("");
    }

    return lines.join("\n");
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
    const args = process.argv.slice(2);
    const autoMode = args.includes("--auto");
    const reportMode = args.includes("--report");

    runAutoCorrections({
        dryRun: !autoMode,
        generateReport: reportMode
    }).then(result => {
        if (result.ok) {
            // Mostrar resumen en texto
            console.log(formatAuditSection(result));
            console.log("\n--- JSON Result ---");
            console.log(JSON.stringify({
                ok: result.ok,
                dryRun: result.dryRun,
                summary: result.summary,
                timestamp: result.timestamp
            }, null, 2));
        } else {
            console.error("Error:", result.error);
            process.exit(1);
        }
    }).catch(e => {
        console.error("Error fatal:", e.message);
        process.exit(1);
    });
}

module.exports = {
    runAutoCorrections,
    formatAuditSection,
    evaluateCoherenceRules,
    COHERENCE_RULES,
    BACKLOG_COLUMNS,
    isBacklogColumn
};
