// scrum-consistency-check.js — Auditoría de consistencia del backlog Intrale
// Detecta duplicaciones parciales, historias contenidas en otras, y
// genera reporte con recomendaciones de consolidación.
//
// Algoritmo:
//   - Fuzzy matching de títulos y objetivos (primeras 300 chars del body)
//   - Detección de historias parcialmente contenidas (70%+ de criterios de AC en otra)
//   - Score ponderado: título (40%) + objetivo (60%)
//   - Umbral de duplicación: similaridad ≥ 0.50
//   - Umbral de contención: 70%+ de criterios de aceptación
//
// Uso CLI:
//   node scrum-consistency-check.js              → auditoría (solo detecta)
//   node scrum-consistency-check.js --report     → genera HTML + envía Telegram
//   node scrum-consistency-check.js --alert      → envía alerta si N>=2 duplicaciones
//   node scrum-consistency-check.js --json       → output JSON a stdout
//
// Output: JSON con { duplicates, contained, recommendations, summary }

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync, spawnSync } = require("child_process");

// ─── Configuración ────────────────────────────────────────────────────────────

const HOOKS_DIR = __dirname;
const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || path.resolve(HOOKS_DIR, "..", "..");
const GH_CLI = "/c/Workspaces/gh-cli/bin/gh.exe";
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");
const REPORT_JSON_FILE = path.join(HOOKS_DIR, "scrum-consistency-report.json");
const GH_REPO = "intrale/platform";
const GH_ORG = "intrale";
const PROJECT_NUMBER = 1;

// Umbrales de detección
const DUPLICATE_THRESHOLD = 0.50;   // Similaridad mínima para considerar duplicación
const CONTAINED_THRESHOLD = 0.70;    // % mínimo de criterios de A que deben estar en B
const ALERT_MIN_DUPLICATES = 2;      // N mínimo de duplicaciones para enviar alerta

// Columnas activas (excluir Done y Backlogs técnicos de prioridad baja)
const ACTIVE_STATUSES = ["Todo", "In Progress", "Blocked", "Ready", "Refined",
    "Backlog Tecnico", "Backlog CLIENTE", "Backlog NEGOCIO", "Backlog DELIVERY"];

// Stopwords en español e inglés para tokenización
const STOPWORDS = new Set([
    "de", "la", "el", "en", "y", "a", "que", "los", "las", "con", "por", "para",
    "un", "una", "es", "se", "del", "al", "o", "su", "como", "más", "pero", "si",
    "no", "le", "lo", "me", "mi", "ya", "hay", "ser", "sin", "sobre", "entre",
    "the", "a", "an", "is", "in", "of", "to", "and", "or", "with", "for",
    "feat", "fix", "refactor", "add", "update", "implement", "new", "from", "by",
    "this", "that", "it", "be", "are", "was", "were", "has", "have", "had",
    "scrum", "intrale", "sprint", "issue", "historia", "user", "story"
]);

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
    try {
        fs.appendFileSync(LOG_FILE,
            "[" + new Date().toISOString() + "] ScrumConsistency: " + msg + "\n");
    } catch (e) {}
}

// ─── GraphQL via gh CLI (spawnSync con ruta Windows nativa) ──────────────────
// Usamos gh api graphql vía spawnSync con la ruta Windows nativa de gh.exe.
// Esto evita el problema de scopes del token extraído por git credential fill,
// ya que gh api graphql usa el token del keyring del SO (que tiene scope project).

// Ruta Windows nativa de gh.exe — construida con path.join para evitar escaping
const GH_CLI_WIN = path.join("C:", "Workspaces", "gh-cli", "bin", "gh.exe");

function graphqlRequest(_token, query, variables) {
    return new Promise((resolve, reject) => {
        let tmpFile = null;
        try {
            const payload = JSON.stringify({ query, variables: variables || {} });

            // Escribir payload a temp file con ruta Windows nativa
            const os = require("os");
            tmpFile = path.join(os.tmpdir(), `gql-${Date.now()}.json`);
            fs.writeFileSync(tmpFile, payload, "utf8");

            const result = spawnSync(
                GH_CLI_WIN,
                ["api", "graphql", "--input", tmpFile],
                {
                    encoding: "utf8",
                    cwd: REPO_ROOT,
                    timeout: 20000,
                    windowsHide: true
                }
            );

            if (result.error) {
                reject(new Error("spawnSync error: " + result.error.message));
                return;
            }
            if (result.status !== 0) {
                reject(new Error("gh api graphql falló (exit " + result.status + "): " + (result.stderr || "").slice(0, 200)));
                return;
            }

            const parsed = JSON.parse(result.stdout);
            if (parsed.errors && parsed.errors.length > 0) {
                reject(new Error(parsed.errors[0].message));
            } else {
                resolve(parsed.data);
            }
        } catch (e) {
            reject(new Error("Error en graphql request: " + e.message));
        } finally {
            if (tmpFile) {
                try { fs.unlinkSync(tmpFile); } catch (e) {}
            }
        }
    });
}

// getGitHubToken ya no extrae el token (gh api graphql lo maneja internamente)
function getGitHubToken() {
    return "gh-cli-managed";
}

// ─── Obtener issues activos del board con body ────────────────────────────────

async function getActiveIssues(token) {
    const issues = [];
    let cursor = null;
    let hasNextPage = true;
    let pageCount = 0;

    while (hasNextPage) {
        pageCount++;
        const query = `query($cursor: String) {
            organization(login: "${GH_ORG}") {
                projectV2(number: ${PROJECT_NUMBER}) {
                    items(first: 100, after: $cursor) {
                        pageInfo { hasNextPage endCursor }
                        nodes {
                            id
                            content {
                                ... on Issue {
                                    number
                                    title
                                    state
                                    body
                                    url
                                    labels(first: 20) { nodes { name } }
                                    updatedAt
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
            // Solo issues abiertos (excluir PRs y cerrados)
            if (node.content.state !== "OPEN") continue;

            // Extraer status actual
            let currentStatus = null;
            for (const fv of (node.fieldValues.nodes || [])) {
                if (fv.field && fv.field.name === "Status") {
                    currentStatus = fv.name;
                    break;
                }
            }

            // Solo columnas activas (no Done)
            if (!currentStatus || !ACTIVE_STATUSES.includes(currentStatus)) continue;

            const labels = (node.content.labels && node.content.labels.nodes || [])
                .map(l => l.name);

            issues.push({
                number: node.content.number,
                title: node.content.title || "",
                state: node.content.state,
                body: node.content.body || "",
                url: node.content.url || `https://github.com/${GH_REPO}/issues/${node.content.number}`,
                labels,
                currentStatus,
                updatedAt: node.content.updatedAt || null
            });
        }

        log(`Página ${pageCount}: ${issues.length} issues activos hasta ahora`);

        if (pageCount > 20) {
            log("Límite de paginación alcanzado (20 páginas)");
            break;
        }
    }

    return issues;
}

// ─── Algoritmo de fuzzy matching ──────────────────────────────────────────────

/**
 * Tokeniza un texto: lowercase, elimina puntuación, elimina stopwords
 * Retorna un Set de tokens únicos.
 */
function tokenize(text) {
    if (!text) return new Set();
    const tokens = text
        .toLowerCase()
        .replace(/[^\w\sáéíóúüñ]/g, " ")
        .split(/\s+/)
        .filter(t => t.length > 2 && !STOPWORDS.has(t));
    return new Set(tokens);
}

/**
 * Índice de Jaccard entre dos sets de tokens.
 * Retorna valor entre 0 (sin similitud) y 1 (idénticos).
 */
function jaccardSimilarity(setA, setB) {
    if (setA.size === 0 && setB.size === 0) return 0;
    const intersection = new Set([...setA].filter(t => setB.has(t)));
    const union = new Set([...setA, ...setB]);
    return intersection.size / union.size;
}

/**
 * Extrae el "objetivo" de un issue: primeras 300 chars del body,
 * o la primera línea no vacía que describe el propósito.
 */
function extractObjective(body) {
    if (!body) return "";
    // Buscar sección ## Objetivo o primer párrafo significativo
    const objectiveMatch = body.match(/##\s*objetivo[^\n]*\n([\s\S]{1,300})/i);
    if (objectiveMatch) {
        return objectiveMatch[1].trim().slice(0, 300);
    }
    // Fallback: primeras 300 chars del body
    return body.trim().slice(0, 300);
}

/**
 * Calcula similaridad compuesta entre dos issues:
 * - 40% del score es similaridad de título
 * - 60% del score es similaridad de objetivo (primeras 300 chars del body)
 */
function computeSimilarity(issueA, issueB) {
    const titleA = tokenize(issueA.title);
    const titleB = tokenize(issueB.title);
    const titleScore = jaccardSimilarity(titleA, titleB);

    const objA = tokenize(extractObjective(issueA.body));
    const objB = tokenize(extractObjective(issueB.body));
    const objScore = jaccardSimilarity(objA, objB);

    const composite = (titleScore * 0.40) + (objScore * 0.60);

    return {
        titleScore: Math.round(titleScore * 100) / 100,
        objectiveScore: Math.round(objScore * 100) / 100,
        composite: Math.round(composite * 100) / 100
    };
}

// ─── Detección de duplicaciones ───────────────────────────────────────────────

/**
 * Compara todos los pares de issues y detecta duplicaciones potenciales.
 * Retorna array de pares con score >= DUPLICATE_THRESHOLD.
 */
function detectDuplicates(issues) {
    const duplicates = [];

    for (let i = 0; i < issues.length; i++) {
        for (let j = i + 1; j < issues.length; j++) {
            const a = issues[i];
            const b = issues[j];

            const scores = computeSimilarity(a, b);

            if (scores.composite >= DUPLICATE_THRESHOLD) {
                duplicates.push({
                    issueA: { number: a.number, title: a.title, url: a.url, status: a.currentStatus },
                    issueB: { number: b.number, title: b.title, url: b.url, status: b.currentStatus },
                    scores,
                    severity: scores.composite >= 0.75 ? "high" : scores.composite >= 0.60 ? "medium" : "low",
                    recommendation: scores.composite >= 0.75
                        ? "Duplicación probable — considerar consolidar en un solo issue"
                        : scores.composite >= 0.60
                            ? "Historias muy similares — revisar si se pueden agrupar"
                            : "Similitud moderada — verificar si abordan el mismo tema"
                });
            }
        }
    }

    return duplicates.sort((a, b) => b.scores.composite - a.scores.composite);
}

// ─── Extracción de criterios de aceptación ────────────────────────────────────

/**
 * Extrae los criterios de aceptación de un issue.
 * Busca checkboxes en formato GitHub Markdown: `- [ ] criterio` o `- [x] criterio`
 */
function extractAcceptanceCriteria(body) {
    if (!body) return [];
    const criteria = [];
    const lines = body.split("\n");

    let inCriteriaSection = false;

    for (const line of lines) {
        const trimmed = line.trim();

        // Detectar sección de criterios
        if (/##\s*(criterios?\s+de\s+aceptaci[oó]n|acceptance\s+criteria)/i.test(trimmed)) {
            inCriteriaSection = true;
            continue;
        }
        // Salir de la sección al encontrar otro heading
        if (inCriteriaSection && /^##\s+/.test(trimmed)) {
            inCriteriaSection = false;
        }

        // Capturar checkboxes dentro o fuera de la sección de criterios
        const checkboxMatch = trimmed.match(/^-\s+\[[ xX]\]\s+(.+)/);
        if (checkboxMatch) {
            const criterioText = checkboxMatch[1].trim().toLowerCase();
            if (criterioText.length > 5) {
                criteria.push(criterioText);
            }
        }
    }

    return criteria;
}

/**
 * Calcula qué porcentaje de los criterios de A están contenidos en B.
 * Un criterio de A está "contenido" en B si:
 *   - El texto aparece como substring en B, O
 *   - La similaridad Jaccard entre el criterio de A y algún criterio de B es >= 0.6
 */
function computeCriteriaContainment(criteriaA, criteriaB, bodyB) {
    if (criteriaA.length === 0) return 0;

    const bodyBLower = (bodyB || "").toLowerCase();
    let containedCount = 0;

    for (const criterion of criteriaA) {
        // Verificar si aparece literalmente en el body de B
        if (bodyBLower.includes(criterion)) {
            containedCount++;
            continue;
        }

        // Verificar similitud Jaccard contra criterios de B
        const tokensCrit = tokenize(criterion);
        let maxSim = 0;
        for (const critB of criteriaB) {
            const sim = jaccardSimilarity(tokensCrit, tokenize(critB));
            if (sim > maxSim) maxSim = sim;
        }
        if (maxSim >= 0.60) {
            containedCount++;
        }
    }

    return criteriaA.length > 0 ? containedCount / criteriaA.length : 0;
}

// ─── Detección de historias parcialmente contenidas ──────────────────────────

/**
 * Para cada par (A, B) verifica si A está parcialmente contenida en B:
 * si el 70%+ de los criterios de A están en B → alerta de contención.
 */
function detectContainedStories(issues) {
    const contained = [];

    for (let i = 0; i < issues.length; i++) {
        for (let j = 0; j < issues.length; j++) {
            if (i === j) continue;
            const a = issues[i];
            const b = issues[j];

            const criteriaA = extractAcceptanceCriteria(a.body);
            if (criteriaA.length === 0) continue; // Sin criterios no se puede analizar

            const criteriaB = extractAcceptanceCriteria(b.body);
            const containmentRatio = computeCriteriaContainment(criteriaA, criteriaB, b.body);

            if (containmentRatio >= CONTAINED_THRESHOLD) {
                contained.push({
                    contained: { number: a.number, title: a.title, url: a.url, status: a.currentStatus, criteriaCount: criteriaA.length },
                    container: { number: b.number, title: b.title, url: b.url, status: b.currentStatus, criteriaCount: criteriaB.length },
                    containmentRatio: Math.round(containmentRatio * 100),
                    matchedCriteria: Math.round(containmentRatio * criteriaA.length),
                    recommendation: containmentRatio >= 0.90
                        ? "Historia A casi completamente contenida en B — considerar eliminar A y ampliar B"
                        : "Historia A mayormente cubierta por B — evaluar si conviene fusionar o mantener separadas"
                });
            }
        }
    }

    // Ordenar por ratio de contención descendente
    return contained.sort((a, b) => b.containmentRatio - a.containmentRatio);
}

// ─── Recomendaciones de consolidación ────────────────────────────────────────

/**
 * Genera recomendaciones basadas en duplicaciones y contenciones detectadas.
 */
function generateRecommendations(duplicates, contained) {
    const recommendations = [];

    for (const dup of duplicates) {
        if (dup.scores.composite >= 0.75) {
            recommendations.push({
                type: "merge",
                priority: "high",
                issues: [dup.issueA.number, dup.issueB.number],
                action: `Fusionar #${dup.issueA.number} y #${dup.issueB.number} en un solo issue (similaridad: ${Math.round(dup.scores.composite * 100)}%)`,
                detail: `Los issues comparten ${Math.round(dup.scores.titleScore * 100)}% de palabras en el título y ${Math.round(dup.scores.objectiveScore * 100)}% en los objetivos.`
            });
        } else if (dup.scores.composite >= 0.60) {
            recommendations.push({
                type: "review",
                priority: "medium",
                issues: [dup.issueA.number, dup.issueB.number],
                action: `Revisar #${dup.issueA.number} y #${dup.issueB.number} para verificar solapamiento (similaridad: ${Math.round(dup.scores.composite * 100)}%)`,
                detail: "Similaridad significativa — pueden abordar el mismo problema desde ángulos distintos o estar duplicados."
            });
        } else {
            recommendations.push({
                type: "link",
                priority: "low",
                issues: [dup.issueA.number, dup.issueB.number],
                action: `Vincular #${dup.issueA.number} y #${dup.issueB.number} como relacionados (similaridad: ${Math.round(dup.scores.composite * 100)}%)`,
                detail: "Similitud moderada — probablemente relacionados. Considerar agregar referencia cruzada."
            });
        }
    }

    for (const cont of contained) {
        recommendations.push({
            type: "absorb",
            priority: cont.containmentRatio >= 90 ? "high" : "medium",
            issues: [cont.contained.number, cont.container.number],
            action: `Historia #${cont.contained.number} está ${cont.containmentRatio}% cubierta por #${cont.container.number} — evaluar si conviene ampliar #${cont.container.number} y cerrar #${cont.contained.number}`,
            detail: `${cont.matchedCriteria}/${cont.contained.criteriaCount} criterios de aceptación de #${cont.contained.number} ya están en #${cont.container.number}.`
        });
    }

    // Eliminar duplicados (mismo par de issues, diferente tipo)
    const seen = new Set();
    return recommendations.filter(r => {
        const key = r.issues.slice().sort().join("-");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// ─── Notificación Telegram ────────────────────────────────────────────────────

async function sendTelegramAlert(message) {
    try {
        const configPath = path.join(HOOKS_DIR, "telegram-config.json");
        if (!fs.existsSync(configPath)) return;
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        const botToken = config.bot_token;
        const chatId = config.chat_id;
        if (!botToken || !chatId) return;

        const postData = JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: "HTML"
        });

        await new Promise((resolve, reject) => {
            const req = https.request({
                hostname: "api.telegram.org",
                path: `/bot${botToken}/sendMessage`,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(postData)
                },
                timeout: 10000
            }, (res) => {
                let data = "";
                res.on("data", c => data += c);
                res.on("end", () => resolve(data));
            });
            req.on("timeout", () => { req.destroy(); reject(new Error("timeout Telegram")); });
            req.on("error", reject);
            req.write(postData);
            req.end();
        });

        log("Alerta enviada a Telegram");
    } catch (e) {
        log("Error enviando alerta Telegram: " + e.message);
    }
}

async function sendHtmlReportToTelegram(htmlPath, caption) {
    try {
        const notifyScript = path.join(HOOKS_DIR, "notify-telegram.js");
        if (!fs.existsSync(notifyScript)) return;
        const { sendHtmlReportToTelegram: send } = require(notifyScript);
        if (typeof send === "function") {
            await send(htmlPath, caption);
            log("Reporte HTML enviado a Telegram");
        }
    } catch (e) {
        log("No se pudo enviar reporte HTML a Telegram: " + e.message);
    }
}

// ─── Generar reporte HTML ─────────────────────────────────────────────────────

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function generateHtmlReport(result) {
    const { duplicates, contained, recommendations, summary, timestamp } = result;

    const health = duplicates.length === 0 && contained.length === 0 ? "🟢 Consistente" :
                   duplicates.length + contained.length <= 3 ? "🟡 Atención" : "🔴 Inconsistencias detectadas";

    const severityBadge = (s) => s === "high" ? '<span style="background:#f44336;color:white;padding:2px 8px;border-radius:3px">🔴 Alta</span>' :
                                  s === "medium" ? '<span style="background:#ff9800;color:white;padding:2px 8px;border-radius:3px">🟡 Media</span>' :
                                  '<span style="background:#8bc34a;color:white;padding:2px 8px;border-radius:3px">🟢 Baja</span>';

    const duplicateRows = duplicates.map(d => `
        <tr>
            <td><a href="${escapeHtml(d.issueA.url)}" target="_blank">#${d.issueA.number}</a><br><small>${escapeHtml(d.issueA.title.slice(0, 60))}</small></td>
            <td><a href="${escapeHtml(d.issueB.url)}" target="_blank">#${d.issueB.number}</a><br><small>${escapeHtml(d.issueB.title.slice(0, 60))}</small></td>
            <td>${Math.round(d.scores.composite * 100)}%</td>
            <td>${Math.round(d.scores.titleScore * 100)}%</td>
            <td>${Math.round(d.scores.objectiveScore * 100)}%</td>
            <td>${severityBadge(d.severity)}</td>
            <td><small>${escapeHtml(d.recommendation)}</small></td>
        </tr>`).join("");

    const containedRows = contained.map(c => `
        <tr>
            <td><a href="${escapeHtml(c.contained.url)}" target="_blank">#${c.contained.number}</a><br><small>${escapeHtml(c.contained.title.slice(0, 60))}</small></td>
            <td><a href="${escapeHtml(c.container.url)}" target="_blank">#${c.container.number}</a><br><small>${escapeHtml(c.container.title.slice(0, 60))}</small></td>
            <td>${c.containmentRatio}%</td>
            <td>${c.matchedCriteria}/${c.contained.criteriaCount}</td>
            <td><small>${escapeHtml(c.recommendation)}</small></td>
        </tr>`).join("");

    const recRows = recommendations.map((r, i) => `
        <tr>
            <td>${i + 1}</td>
            <td>${r.type === "merge" ? "🔴 Fusionar" : r.type === "absorb" ? "🟡 Absorber" : r.type === "review" ? "🔵 Revisar" : "🟢 Vincular"}</td>
            <td>${r.issues.map(n => `<a href="https://github.com/${GH_REPO}/issues/${n}" target="_blank">#${n}</a>`).join(", ")}</td>
            <td><small>${escapeHtml(r.action)}</small></td>
            <td><small>${escapeHtml(r.detail)}</small></td>
        </tr>`).join("");

    return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <title>Reporte de Consistencia del Backlog — ${timestamp}</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; color: #333; max-width: 1200px; margin: 0 auto; padding: 20px; }
        h1 { color: #1a1a2e; border-bottom: 3px solid #6c5ce7; padding-bottom: 10px; }
        h2 { color: #16213e; margin-top: 30px; border-left: 4px solid #6c5ce7; padding-left: 10px; }
        .summary { background: #f8f9fa; border-left: 4px solid #6c5ce7; padding: 15px; margin: 20px 0; border-radius: 4px; }
        .summary p { margin: 5px 0; }
        .health { font-size: 1.3em; font-weight: bold; margin-top: 10px; }
        table { border-collapse: collapse; width: 100%; margin: 15px 0; font-size: 0.9em; }
        th { background: #1a1a2e; color: white; padding: 10px; text-align: left; }
        td { padding: 8px 10px; border-bottom: 1px solid #ddd; vertical-align: top; }
        tr:hover { background: #f5f5f5; }
        a { color: #6c5ce7; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .matrix { background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; padding: 20px; margin: 20px 0; }
        .matrix h3 { color: #856404; margin-top: 0; }
        .matrix table th { background: #856404; }
        .decision-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px; margin: 15px 0; }
        .decision-card { background: white; border: 1px solid #ddd; border-radius: 8px; padding: 15px; }
        .decision-card h4 { margin: 0 0 10px 0; }
        .decision-card.new { border-top: 4px solid #4CAF50; }
        .decision-card.expand { border-top: 4px solid #2196F3; }
        .decision-card.group { border-top: 4px solid #FF9800; }
        .no-data { color: #999; font-style: italic; padding: 20px; text-align: center; }
        footer { margin-top: 40px; color: #888; font-size: 0.85em; border-top: 1px solid #ddd; padding-top: 10px; }
    </style>
</head>
<body>
    <h1>🔍 Reporte de Consistencia del Backlog — Scrum Master</h1>

    <div class="summary">
        <p><strong>Fecha de ejecución:</strong> ${timestamp}</p>
        <p><strong>Issues activos analizados:</strong> ${summary.totalIssues}</p>
        <p><strong>Pares comparados:</strong> ${summary.totalPairs}</p>
        <p><strong>Duplicaciones potenciales:</strong> ${duplicates.length}</p>
        <p><strong>Historias parcialmente contenidas:</strong> ${contained.length}</p>
        <p><strong>Recomendaciones generadas:</strong> ${recommendations.length}</p>
        <p class="health"><strong>Estado del backlog:</strong> ${health}</p>
    </div>

    <h2>📋 Duplicaciones potenciales (${duplicates.length})</h2>
    <p><em>Issues con similaridad compuesta ≥ ${Math.round(DUPLICATE_THRESHOLD * 100)}% en título y objetivo. Score = 40% título + 60% objetivo.</em></p>
    ${duplicates.length === 0
        ? '<p class="no-data">✅ No se detectaron duplicaciones. Backlog consistente.</p>'
        : `<table>
            <tr>
                <th>Issue A</th>
                <th>Issue B</th>
                <th>Score total</th>
                <th>Título</th>
                <th>Objetivo</th>
                <th>Severidad</th>
                <th>Recomendación</th>
            </tr>
            ${duplicateRows}
        </table>`}

    <h2>🔗 Historias parcialmente contenidas (${contained.length})</h2>
    <p><em>Historia A cubierta ≥ ${Math.round(CONTAINED_THRESHOLD * 100)}% por B — el ${Math.round(CONTAINED_THRESHOLD * 100)}%+ de los criterios de A ya existen en B.</em></p>
    ${contained.length === 0
        ? '<p class="no-data">✅ No se detectaron historias parcialmente contenidas.</p>'
        : `<table>
            <tr>
                <th>Historia contenida (A)</th>
                <th>Historia que la contiene (B)</th>
                <th>% cubierto</th>
                <th>Criterios coincidentes</th>
                <th>Recomendación</th>
            </tr>
            ${containedRows}
        </table>`}

    <h2>💡 Recomendaciones de consolidación (${recommendations.length})</h2>
    ${recommendations.length === 0
        ? '<p class="no-data">✅ Sin recomendaciones de consolidación.</p>'
        : `<table>
            <tr>
                <th>#</th>
                <th>Tipo</th>
                <th>Issues</th>
                <th>Acción</th>
                <th>Detalle</th>
            </tr>
            ${recRows}
        </table>`}

    <div class="matrix">
        <h2 style="border:none;padding:0;margin-bottom:15px">📐 Matriz de decisión — cuándo crear nueva historia vs. ampliar vs. agrupar</h2>
        <div class="decision-grid">
            <div class="decision-card new">
                <h4>✅ Crear nueva historia</h4>
                <ul>
                    <li>El scope es claramente diferente al de las historias existentes</li>
                    <li>Afecta a un actor/rol distinto (ej: nuevo para Delivery pero ya existe para Client)</li>
                    <li>La implementación requiere trabajo independiente en módulos distintos</li>
                    <li>La estimación supera L y merece su propio ciclo de vida</li>
                    <li>El equipo puede trabajarla en paralelo con otras</li>
                </ul>
            </div>
            <div class="decision-card expand">
                <h4>🔵 Ampliar historia existente</h4>
                <ul>
                    <li>La nueva funcionalidad extiende lógica ya definida en el mismo módulo</li>
                    <li>Comparte más del 60% de criterios de aceptación con una historia existente</li>
                    <li>El cambio es un "edge case" o validación adicional del flujo ya definido</li>
                    <li>Se puede implementar en el mismo sprint sin ampliar el scope del issue</li>
                    <li>La historia base aún no está en Done</li>
                </ul>
            </div>
            <div class="decision-card group">
                <h4>🟡 Agrupar en épica</h4>
                <ul>
                    <li>Hay 3+ historias similares que comparten un tema transversal</li>
                    <li>Las historias son pequeñas y juntas forman un feature coherente</li>
                    <li>Tienen la misma prioridad y se pueden planificar en el mismo sprint</li>
                    <li>La narrativa de negocio es más clara si se presenta como un solo item</li>
                    <li>Reducen el overhead de PM si se gestionan juntas</li>
                </ul>
            </div>
        </div>

        <h3>Tabla de decisión rápida</h3>
        <table>
            <tr>
                <th>Situación</th>
                <th>Decisión recomendada</th>
                <th>Acción concreta</th>
            </tr>
            <tr><td>Similaridad título+objetivo ≥ 75%</td><td>🔴 Fusionar</td><td>Cerrar uno, agregar sus criterios al otro</td></tr>
            <tr><td>Similaridad título+objetivo 60-74%</td><td>🔵 Revisar + posible ampliación</td><td>Comparar scope; si es sub-tarea, agregar como task del issue padre</td></tr>
            <tr><td>70%+ criterios de A en B</td><td>🟡 Absorber</td><td>Agregar criterios únicos de A a B, cerrar A con referencia a B</td></tr>
            <tr><td>Mismo área + estimaciones S cada una</td><td>🟡 Agrupar</td><td>Crear épica o issue padre, referenciar ambas</td></tr>
            <tr><td>Mismos actores + distinto módulo</td><td>✅ Mantener separadas</td><td>Agregar referencia cruzada (Relacionado con: #N)</td></tr>
            <tr><td>Similaridad < 50% en todos los ejes</td><td>✅ Crear nueva</td><td>Verificar que no exista issue similar antes de abrir</td></tr>
        </table>
    </div>

    <footer>
        <p>Generado por <strong>scrum-consistency-check.js</strong> — Intrale Platform Scrum Master</p>
        <p>Repositorio: ${GH_REPO} | Proyecto V2: #${PROJECT_NUMBER} | Umbral duplicación: ${Math.round(DUPLICATE_THRESHOLD * 100)}% | Umbral contención: ${Math.round(CONTAINED_THRESHOLD * 100)}%</p>
    </footer>
</body>
</html>`;
}

// ─── Función principal ────────────────────────────────────────────────────────

async function runConsistencyCheck(options = {}) {
    const generateReport = options.generateReport || false;
    const sendAlert = options.sendAlert || false;
    const timestamp = new Date().toISOString();

    log("Iniciando scrum-consistency-check");

    let token;
    try {
        token = getGitHubToken();
    } catch (e) {
        return { ok: false, error: "No se pudo obtener token GitHub: " + e.message, duplicates: [], contained: [], recommendations: [] };
    }

    // 1. Obtener issues activos con body
    let issues;
    try {
        issues = await getActiveIssues(token);
        log(`Issues activos obtenidos: ${issues.length}`);
    } catch (e) {
        return { ok: false, error: "No se pudo obtener issues: " + e.message, duplicates: [], contained: [], recommendations: [] };
    }

    // 2. Detectar duplicaciones
    const duplicates = detectDuplicates(issues);
    log(`Duplicaciones detectadas: ${duplicates.length}`);

    // 3. Detectar historias parcialmente contenidas
    const contained = detectContainedStories(issues);
    log(`Contenciones detectadas: ${contained.length}`);

    // 4. Generar recomendaciones
    const recommendations = generateRecommendations(duplicates, contained);

    // 5. Summary
    const totalPairs = Math.floor(issues.length * (issues.length - 1) / 2);
    const summary = {
        totalIssues: issues.length,
        totalPairs,
        duplicatesDetected: duplicates.length,
        containedDetected: contained.length,
        recommendationsGenerated: recommendations.length,
        health: duplicates.length === 0 && contained.length === 0 ? "consistent" :
                duplicates.length + contained.length <= 3 ? "attention" : "critical"
    };

    const result = { ok: true, timestamp, issues: issues.length, duplicates, contained, recommendations, summary };

    // 6. Guardar JSON
    try {
        fs.writeFileSync(REPORT_JSON_FILE, JSON.stringify(result, null, 2), "utf8");
        log(`Reporte JSON guardado: ${REPORT_JSON_FILE}`);
    } catch (e) {
        log("Error guardando JSON: " + e.message);
    }

    // 7. Generar HTML + enviar a Telegram
    if (generateReport) {
        const htmlFileName = `reporte-scrum-consistencia-${timestamp.replace(/[:.]/g, "-").slice(0, 19)}.html`;
        const htmlPath = path.join(REPO_ROOT, "docs", "qa", htmlFileName);
        try {
            const docsDir = path.join(REPO_ROOT, "docs", "qa");
            if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
            fs.writeFileSync(htmlPath, generateHtmlReport(result), "utf8");
            result.htmlReport = htmlPath;
            log(`Reporte HTML generado: ${htmlPath}`);
            await sendHtmlReportToTelegram(htmlPath, "Consistencia del Backlog — Scrum Master");
        } catch (e) {
            log("Error generando reporte HTML: " + e.message);
        }
    }

    // 8. Alerta Telegram si hay N>=2 duplicaciones
    if (sendAlert && duplicates.length >= ALERT_MIN_DUPLICATES) {
        const highCount = duplicates.filter(d => d.severity === "high").length;
        const alertMsg = [
            `⚠️ <b>Alerta de Consistencia — Backlog Intrale</b>`,
            ``,
            `Se detectaron <b>${duplicates.length} duplicaciones potenciales</b> en el backlog:`,
            `• ${highCount} de alta severidad`,
            `• ${duplicates.length - highCount} de media/baja severidad`,
            ``,
            contained.length > 0 ? `También se detectaron <b>${contained.length} historias parcialmente contenidas</b>.` : "",
            ``,
            `📋 Ejecutar <code>/scrum consistencia</code> para ver el reporte completo.`
        ].filter(l => l !== undefined).join("\n");
        await sendTelegramAlert(alertMsg);
    }

    return result;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
    const args = process.argv.slice(2);
    const reportMode = args.includes("--report");
    const alertMode = args.includes("--alert");
    const jsonMode = args.includes("--json");

    runConsistencyCheck({ generateReport: reportMode, sendAlert: alertMode })
        .then(result => {
            if (jsonMode) {
                console.log(JSON.stringify(result, null, 2));
            } else {
                const { summary, duplicates, contained, recommendations } = result;
                console.log(`\nScrum Consistency Check — ${result.timestamp}`);
                console.log(`Issues activos analizados: ${summary ? summary.totalIssues : 0}`);
                console.log(`Pares comparados: ${summary ? summary.totalPairs : 0}`);
                console.log(`Duplicaciones detectadas: ${duplicates ? duplicates.length : 0}`);
                console.log(`Historias contenidas: ${contained ? contained.length : 0}`);
                console.log(`Recomendaciones: ${recommendations ? recommendations.length : 0}`);
                console.log(`Estado: ${summary ? summary.health : "unknown"}`);
                if (result.htmlReport) console.log(`Reporte HTML: ${result.htmlReport}`);
                if (result.error) console.error("Error:", result.error);
            }
        })
        .catch(e => {
            console.error("Error fatal:", e.message);
            process.exit(1);
        });
}

module.exports = { runConsistencyCheck, detectDuplicates, detectContainedStories,
    computeSimilarity, extractAcceptanceCriteria, jaccardSimilarity, tokenize,
    generateRecommendations, DUPLICATE_THRESHOLD, CONTAINED_THRESHOLD };
