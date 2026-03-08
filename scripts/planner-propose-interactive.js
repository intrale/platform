#!/usr/bin/env node
// planner-propose-interactive.js — Propone nuevas historias al cierre del sprint
// Se ejecuta automáticamente desde Watch-Agentes.ps1 tras el cierre del sprint.
//
// Flujo:
//   1. Lee sprint-plan.json (contexto del sprint cerrado)
//   2. Analiza git log, PR bodies y deuda técnica (via detect-tech-debt.js)
//   3. Genera propuestas de nuevas historias (3-5 mínimo)
//   4. Escribe propuestas en .claude/hooks/planner-proposals.json
//   5. Envía mensaje con inline buttons a Telegram (Crear / Descartar)
//   6. Guarda historial en scripts/.proposal-history.json
//
// Uso: node planner-propose-interactive.js [--dry-run]
// --dry-run: no envía a Telegram, imprime propuestas en consola

const fs = require("fs");
const path = require("path");
const { execSync, spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "planner-propose.log");
const SPRINT_PLAN_FILE = path.join(__dirname, "sprint-plan.json");
const PROPOSALS_FILE = path.join(HOOKS_DIR, "planner-proposals.json");
const HISTORY_FILE = path.join(__dirname, ".proposal-history.json");
const DETECT_DEBT_SCRIPT = path.join(__dirname, "detect-tech-debt.js");
const GH_PATH = "C:\\Workspaces\\gh-cli\\bin\\gh.exe";

const DRY_RUN = process.argv.includes("--dry-run");

// ─── Logging ─────────────────────────────────────────────────────────────────

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(msg) {
    ensureDir(LOG_DIR);
    const ts = new Date().toISOString();
    const line = `[${ts}] Planner-Propose: ${msg}`;
    try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (e) { /* ignore */ }
    console.log(line);
}

function execSafe(cmd, opts = {}) {
    try {
        return execSync(cmd, { encoding: "utf8", timeout: 30000, ...opts }).trim();
    } catch (e) {
        log(`execSafe failed: ${cmd.substring(0, 80)} → ${e.message}`);
        return null;
    }
}

// ─── Cargar Telegram client ───────────────────────────────────────────────────

let tgClient = null;
try {
    tgClient = require(path.join(HOOKS_DIR, "telegram-client"));
} catch (e) {
    log("telegram-client.js no disponible: " + e.message);
}

// ─── Contexto del sprint cerrado ─────────────────────────────────────────────

function loadSprintContext() {
    const context = {
        fecha: "?",
        agentes: [],
        issues: [],
        prBodies: [],
        recentCommits: []
    };

    // Leer sprint-plan.json
    if (fs.existsSync(SPRINT_PLAN_FILE)) {
        try {
            const plan = JSON.parse(fs.readFileSync(SPRINT_PLAN_FILE, "utf8"));
            context.fecha = plan.fecha || "?";
            context.agentes = plan.agentes || [];
            context.issues = (plan.agentes || []).map(a => a.issue).filter(Boolean);
            log(`Sprint cargado: fecha=${context.fecha}, issues=[${context.issues.join(",")}]`);
        } catch (e) {
            log("Error leyendo sprint-plan.json: " + e.message);
        }
    }

    // Obtener commits recientes del sprint
    const gitLog = execSafe(
        `git -C "${REPO_ROOT}" log --oneline -15 origin/main.. 2>/dev/null || git -C "${REPO_ROOT}" log --oneline -15 2>/dev/null`
    );
    if (gitLog) {
        context.recentCommits = gitLog.split("\n").filter(Boolean);
        log(`Commits recientes: ${context.recentCommits.length}`);
    }

    // Obtener PRs del sprint (mergeados recientemente)
    if (fs.existsSync(GH_PATH)) {
        const prListRaw = execSafe(
            `"${GH_PATH}" pr list --repo intrale/platform --state merged --limit 10 --json number,title,body,labels 2>/dev/null`
        );
        if (prListRaw) {
            try {
                const prs = JSON.parse(prListRaw);
                context.prBodies = prs.map(pr => ({
                    number: pr.number,
                    title: pr.title,
                    labels: (pr.labels || []).map(l => l.name)
                }));
                log(`PRs mergeados recientes: ${context.prBodies.length}`);
            } catch (e) {
                log("Error parseando PRs: " + e.message);
            }
        }
    }

    return context;
}

// ─── Análisis de deuda técnica ────────────────────────────────────────────────

function runDebtDetection() {
    if (!fs.existsSync(DETECT_DEBT_SCRIPT)) {
        log("detect-tech-debt.js no encontrado");
        return { items: [] };
    }

    try {
        const result = spawnSync("node", [DETECT_DEBT_SCRIPT, "--json", "--limit", "15"], {
            encoding: "utf8",
            timeout: 30000
        });

        if (result.stdout) {
            const data = JSON.parse(result.stdout);
            log(`Deuda técnica detectada: ${data.total || 0} items, mostrando ${(data.items || []).length}`);
            return data;
        }
    } catch (e) {
        log("Error ejecutando detect-tech-debt.js: " + e.message);
    }

    return { items: [] };
}

// ─── Cargar historial de propuestas anteriores ────────────────────────────────

function loadHistory() {
    if (!fs.existsSync(HISTORY_FILE)) return { history: [] };
    try {
        return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    } catch (e) {
        return { history: [] };
    }
}

function getDiscardedTitles(history) {
    const discarded = new Set();
    for (const sprint of (history.history || [])) {
        for (const p of (sprint.proposals || [])) {
            if (p.status === "discarded") {
                discarded.add(p.title.toLowerCase().substring(0, 30));
            }
        }
    }
    return discarded;
}

// ─── Generación de propuestas ─────────────────────────────────────────────────

function generateProposals(context, debtData, history) {
    const proposals = [];
    const discardedTitles = getDiscardedTitles(history);

    // ── Fuente 1: Deuda técnica detectada → propuestas tipo infra/backlog-tecnico
    const highDebt = (debtData.items || []).filter(item => item.severity === "high").slice(0, 3);
    const mediumDebt = (debtData.items || []).filter(item => item.severity === "medium").slice(0, 2);

    for (const item of [...highDebt, ...mediumDebt]) {
        const title = item.title;
        if (discardedTitles.has(title.toLowerCase().substring(0, 30))) continue;

        proposals.push({
            title,
            justification: item.description,
            body: buildIssueBody(item),
            labels: item.labels || ["backlog-tecnico", "enhancement"],
            effort: item.effort || "S",
            stream: item.stream || "Stream E — Cross-cutting",
            dependencies: [],
            source: "tech_debt",
            sourceDetail: `${item.type} en ${item.file || "codebase"}`
        });
    }

    // ── Fuente 2: Extensiones naturales de features implementadas
    for (const commit of context.recentCommits) {
        const [hash, ...msgParts] = commit.split(" ");
        const msg = msgParts.join(" ");

        // Detectar patrones: "feat(X):" → proponer mejora/test de X
        const featMatch = msg.match(/^feat(?:\(([^)]+)\))?:\s*(.+)/i);
        if (featMatch) {
            const module = featMatch[1] || "general";
            const description = featMatch[2];

            // Proponer tests si no hay commits de test asociados
            const testCommitExists = context.recentCommits.some(c =>
                c.includes("test") && c.toLowerCase().includes(module.toLowerCase())
            );

            if (!testCommitExists && module !== "general") {
                const title = `Agregar tests para ${module} (${description.substring(0, 30)})`;
                if (!discardedTitles.has(title.toLowerCase().substring(0, 30))) {
                    proposals.push({
                        title,
                        justification: `Feature implementada en sprint ${context.fecha} sin tests de cobertura`,
                        body: buildTestProposalBody(module, description),
                        labels: ["backlog-tecnico", "testing"],
                        effort: "S",
                        stream: detectStream(module),
                        dependencies: [],
                        source: "feature_extension",
                        sourceDetail: `commit: ${hash} — ${msg.substring(0, 50)}`
                    });
                }
            }
        }
    }

    // ── Fuente 3: Issues del sprint → oportunidades de mejora observadas
    if (context.issues.length > 0 && fs.existsSync(GH_PATH)) {
        for (const rawIssueNum of context.issues.slice(0, 3)) {
            // Sanitizar: asegurar que issueNumber es un entero positivo antes de interpolarlo en shell
            const issueNumber = parseInt(rawIssueNum, 10);
            if (!issueNumber || issueNumber <= 0) {
                log(`issueNumber inválido descartado: ${rawIssueNum}`);
                continue;
            }
            const issueRaw = execSafe(
                `"${GH_PATH}" issue view ${issueNumber} --repo intrale/platform --json title,body,labels 2>/dev/null`
            );
            if (!issueRaw) continue;

            try {
                const issue = JSON.parse(issueRaw);
                const labels = (issue.labels || []).map(l => l.name);
                const bodyLower = (issue.body || "").toLowerCase();

                // Si el issue mencionó "pendiente", "futuro", "después" → proponer follow-up
                if (bodyLower.includes("pendiente") || bodyLower.includes("futuro") ||
                    bodyLower.includes("después") || bodyLower.includes("próximo sprint")) {

                    const title = `Follow-up de #${issueNumber}: ${issue.title.substring(0, 40)}`;
                    if (!discardedTitles.has(title.toLowerCase().substring(0, 30))) {
                        proposals.push({
                            title,
                            justification: `El issue #${issueNumber} mencionó trabajo pendiente para sprints futuros`,
                            body: buildFollowUpBody(issueNumber, issue.title),
                            labels: labels.includes("backlog-tecnico") ? ["backlog-tecnico", "enhancement"] : ["enhancement"],
                            effort: "M",
                            stream: detectStreamFromLabels(labels),
                            dependencies: [issueNumber],
                            source: "issue_followup",
                            sourceDetail: `issue #${issueNumber}: ${issue.title}`
                        });
                    }
                }
            } catch (e) {
                log(`Error procesando issue #${issueNumber}: ${e.message}`);
            }
        }
    }

    // ── Fuente 4: Propuestas de mejora estándar por áreas no cubiertas
    const standardProposals = buildStandardProposals(context, discardedTitles);
    proposals.push(...standardProposals);

    // Deduplicar por título similar
    const seen = new Set();
    const deduped = proposals.filter(p => {
        const key = p.title.toLowerCase().substring(0, 40);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    // Limitar a 7 propuestas máximo para no abrumar
    return deduped.slice(0, 7);
}

function buildIssueBody(debtItem) {
    return `## Objetivo

Resolver deuda técnica detectada automáticamente en el codebase.

**Tipo:** ${debtItem.type}
**Severidad:** ${debtItem.severity}
**Archivo:** ${debtItem.file || "N/A"}${debtItem.line ? `:${debtItem.line}` : ""}

## Descripción

${debtItem.description}

## Cambios requeridos

- Identificar el problema exacto en el código
- Implementar la corrección siguiendo las convenciones del proyecto
- Agregar o actualizar tests si corresponde
- Verificar que no hay regresiones

## Criterios de aceptación

- [ ] El problema detectado está resuelto
- [ ] Los tests pasan
- [ ] El linter/build pasa sin errores
`;
}

function buildTestProposalBody(module, featureDescription) {
    return `## Objetivo

Agregar cobertura de tests para el módulo \`${module}\` implementado en el sprint anterior.

## Contexto

La feature "${featureDescription}" fue implementada pero no tiene tests de cobertura suficientes.

## Cambios requeridos

- Revisar la implementación existente de ${module}
- Agregar tests unitarios para los casos principales (happy path)
- Agregar tests para casos de error
- Verificar que el coverage mínimo se alcanza

## Criterios de aceptación

- [ ] Tests unitarios agregados con nombres descriptivos en español
- [ ] Happy path cubierto
- [ ] Casos de error cubiertos
- [ ] Build + tests pasan en CI
`;
}

function buildFollowUpBody(issueNumber, issueTitle) {
    return `## Objetivo

Completar trabajo pendiente identificado durante la implementación de #${issueNumber}.

## Contexto

El issue #${issueNumber} ("${issueTitle}") mencionó trabajo que se dejó pendiente para sprints futuros.

## Cambios requeridos

- Revisar el issue original #${issueNumber} para identificar el trabajo pendiente
- Implementar las mejoras o funcionalidad pospuesta
- Verificar que se integra correctamente con lo implementado en #${issueNumber}

## Criterios de aceptación

- [ ] El trabajo mencionado como pendiente en #${issueNumber} está completo
- [ ] Tests pasan
- [ ] Se cierra la brecha funcional identificada
`;
}

function buildStandardProposals(context, discardedTitles) {
    const proposals = [];

    const standards = [
        {
            title: "Mejorar cobertura de tests en módulo backend",
            justification: "El backend tiene endpoints sin tests de integración completos",
            labels: ["backlog-tecnico", "testing"],
            effort: "M",
            stream: "Stream A — Backend",
            body: `## Objetivo\n\nMejorar la cobertura de tests del backend para reducir el riesgo de regresiones.\n\n## Cambios requeridos\n\n- Auditar cobertura actual con Kover\n- Agregar tests de integración para endpoints sin cobertura\n- Configurar umbral mínimo de cobertura en CI\n\n## Criterios de aceptación\n\n- [ ] Cobertura de tests > 70% en módulo backend\n- [ ] Tests de integración para endpoints principales\n- [ ] CI falla si la cobertura baja del umbral`
        },
        {
            title: "Auditoría de seguridad — revisar tokens y secrets en logs",
            justification: "Verificar que no hay tokens, keys o datos sensibles en logs de producción",
            labels: ["backlog-tecnico", "security"],
            effort: "S",
            stream: "Stream A — Backend",
            body: `## Objetivo\n\nAuditar los logs del sistema para asegurar que no se filtran datos sensibles.\n\n## Cambios requeridos\n\n- Revisar todos los logger.info/debug/error del backend\n- Verificar que no se loguean tokens JWT, passwords, ni secrets\n- Implementar masking de datos sensibles si es necesario\n\n## Criterios de aceptación\n\n- [ ] Ningún log contiene tokens o contraseñas\n- [ ] Tests verifican el comportamiento del logger`
        },
        {
            title: "Refactorizar manejo de errores en app — consolidar patrones",
            justification: "Múltiples formas de manejar errores en la app generan inconsistencias en UX",
            labels: ["backlog-tecnico", "enhancement"],
            effort: "M",
            stream: "Stream E — Cross-cutting",
            body: `## Objetivo\n\nConsolidar el manejo de errores en la app siguiendo el patrón estándar del proyecto.\n\n## Cambios requeridos\n\n- Auditar todos los catch blocks en ViewModels\n- Verificar que usan el patrón Do[Action]Exception correctamente\n- Agregar mensajes de error claros y accionables en todos los casos\n- Documentar el patrón para futuros desarrollos\n\n## Criterios de aceptación\n\n- [ ] Todos los ViewModels usan el patrón de error estándar\n- [ ] No hay mensajes de error genéricos sin descripción\n- [ ] Tests cubren los casos de error principales`
        }
    ];

    for (const std of standards) {
        if (discardedTitles.has(std.title.toLowerCase().substring(0, 30))) continue;

        // Verificar que no existe ya como issue en GitHub (básico por título)
        proposals.push({
            ...std,
            dependencies: [],
            source: "standard",
            sourceDetail: "propuesta estándar de mejora continua"
        });
    }

    return proposals;
}

function detectStream(module) {
    const m = (module || "").toLowerCase();
    if (m.includes("backend") || m.includes("users") || m.includes("api")) return "Stream A — Backend";
    if (m.includes("client")) return "Stream B — Cliente";
    if (m.includes("business") || m.includes("negocio")) return "Stream C — Negocio";
    if (m.includes("delivery") || m.includes("repartidor")) return "Stream D — Delivery";
    return "Stream E — Cross-cutting";
}

function detectStreamFromLabels(labels) {
    if (labels.includes("app:client")) return "Stream B — Cliente";
    if (labels.includes("app:business")) return "Stream C — Negocio";
    if (labels.includes("app:delivery")) return "Stream D — Delivery";
    if (labels.includes("backlog-tecnico")) return "Stream A — Backend";
    return "Stream E — Cross-cutting";
}

// ─── Guardar propuestas para el Commander ─────────────────────────────────────

function saveProposals(proposals) {
    const data = {
        generated_at: new Date().toISOString(),
        telegram_message_id: null,  // Se actualizará cuando se envíe el mensaje
        proposals: proposals.map((p, i) => ({
            index: i,
            title: p.title,
            justification: p.justification,
            body: p.body || "",
            labels: p.labels || [],
            effort: p.effort || "M",
            stream: p.stream || "",
            dependencies: p.dependencies || [],
            source: p.source || "unknown",
            sourceDetail: p.sourceDetail || "",
            status: "pending"
        }))
    };

    fs.writeFileSync(PROPOSALS_FILE, JSON.stringify(data, null, 2), "utf8");
    log(`Propuestas guardadas: ${proposals.length} en ${PROPOSALS_FILE}`);
    return data;
}

// ─── Actualizar historial ─────────────────────────────────────────────────────

function updateHistory(sprintFecha, proposals) {
    const history = loadHistory();

    // Buscar entrada del sprint actual
    let sprintEntry = history.history.find(h => h.sprint === sprintFecha);
    if (!sprintEntry) {
        sprintEntry = { sprint: sprintFecha, date: new Date().toISOString(), proposals: [] };
        history.history.push(sprintEntry);
    }

    // Agregar propuestas (sin duplicar)
    for (const p of proposals) {
        const exists = sprintEntry.proposals.some(ep => ep.title === p.title);
        if (!exists) {
            sprintEntry.proposals.push({
                title: p.title,
                labels: p.labels,
                effort: p.effort,
                source: p.source,
                status: "pending",  // Se actualiza cuando el usuario decide
                generated_at: new Date().toISOString()
            });
        }
    }

    // Mantener solo los últimos 10 sprints
    if (history.history.length > 10) {
        history.history = history.history.slice(-10);
    }

    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), "utf8");
        log(`Historial actualizado: sprint ${sprintFecha}`);
    } catch (e) {
        log(`Error guardando historial: ${e.message}`);
    }
}

// ─── Enviar propuestas a Telegram ─────────────────────────────────────────────

async function sendToTelegram(proposalsData, sprintFecha) {
    if (!tgClient) {
        log("Telegram no disponible — saltando envío");
        return false;
    }

    const EFFORT_LABELS = { S: "S (1d)", M: "M (2-3d)", L: "L (1sem)", XL: "XL (2+sem)" };

    // Construir texto del mensaje
    let text = `💡 <b>Propuestas para el siguiente sprint</b>\n`;
    text += `<i>Generadas al cierre del sprint ${sprintFecha}</i>\n\n`;
    text += `Analizé el sprint cerrado y detecté ${proposalsData.proposals.length} oportunidades de mejora:\n\n`;

    for (const p of proposalsData.proposals) {
        const effort = EFFORT_LABELS[p.effort] || p.effort;
        const labelsStr = (p.labels || []).join(", ");
        text += `⏳ <b>${p.index + 1}. ${escHtml(p.title)}</b>\n`;
        text += `   📏 ${effort} · 🏷 ${escHtml(labelsStr)}\n`;
        text += `   <i>${escHtml(p.justification.substring(0, 80))}</i>\n\n`;
    }

    text += `Seleccioná qué historias crear en GitHub:`;

    // Construir teclado inline
    const keyboard = [];
    for (const p of proposalsData.proposals) {
        keyboard.push([
            { text: `✅ ${p.index + 1}. Crear`, callback_data: `create_proposal:${p.index}` },
            { text: `❌ ${p.index + 1}. Descartar`, callback_data: `discard_proposal:${p.index}` }
        ]);
    }
    if (proposalsData.proposals.length > 1) {
        keyboard.push([
            { text: "✅ Crear todas las propuestas", callback_data: "create_all_proposals" }
        ]);
    }

    try {
        const sentMsg = await tgClient.telegramPost("sendMessage", {
            chat_id: tgClient.getChatId(),
            text,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: keyboard }
        }, 10000);

        // Actualizar el telegram_message_id en el archivo de propuestas
        proposalsData.telegram_message_id = sentMsg.message_id;
        fs.writeFileSync(PROPOSALS_FILE, JSON.stringify(proposalsData, null, 2), "utf8");

        log(`Mensaje de propuestas enviado: msg_id=${sentMsg.message_id}`);
        return true;
    } catch (e) {
        log(`Error enviando a Telegram: ${e.message}`);
        return false;
    }
}

function escHtml(str) {
    return (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    log("=== Iniciando planner-propose-interactive ===");

    // 1. Cargar contexto del sprint
    log("Paso 1/5: Cargando contexto del sprint...");
    const context = loadSprintContext();

    // 2. Detectar deuda técnica
    log("Paso 2/5: Analizando deuda técnica...");
    const debtData = runDebtDetection();

    // 3. Cargar historial
    log("Paso 3/5: Cargando historial de propuestas...");
    const history = loadHistory();
    log(`Historial: ${history.history.length} sprints anteriores`);

    // 4. Generar propuestas
    log("Paso 4/5: Generando propuestas...");
    const proposals = generateProposals(context, debtData, history);
    log(`Propuestas generadas: ${proposals.length}`);

    if (proposals.length === 0) {
        log("No se generaron propuestas. Finalizando.");
        console.log("\n⚠️  No se encontraron propuestas para generar en este sprint.\n");
        return;
    }

    // Guardar propuestas para el Commander
    const proposalsData = saveProposals(proposals);

    // Actualizar historial
    updateHistory(context.fecha, proposals);

    // 5. Enviar / mostrar
    if (DRY_RUN) {
        log("DRY RUN — mostrando propuestas en consola");
        console.log("\n=== PROPUESTAS GENERADAS (DRY RUN) ===\n");
        for (const p of proposalsData.proposals) {
            const effort = { S: "S (1d)", M: "M (2-3d)", L: "L (1sem)", XL: "XL (2+sem)" }[p.effort] || p.effort;
            console.log(`${p.index + 1}. ${p.title}`);
            console.log(`   Esfuerzo: ${effort} | Labels: ${p.labels.join(", ")}`);
            console.log(`   Justificación: ${p.justification.substring(0, 100)}`);
            console.log(`   Fuente: ${p.source} (${p.sourceDetail})`);
            console.log();
        }
        console.log(`Propuestas guardadas en: ${PROPOSALS_FILE}`);
    } else {
        log("Paso 5/5: Enviando propuestas a Telegram...");
        const sent = await sendToTelegram(proposalsData, context.fecha);
        if (sent) {
            console.log(`\n✅ ${proposals.length} propuesta(s) enviadas a Telegram para aprobación interactiva.\n`);
        } else {
            console.log(`\n⚠️  Propuestas generadas pero no enviadas a Telegram. Revisar ${PROPOSALS_FILE}\n`);
        }
    }

    log("=== planner-propose-interactive finalizado ===");
}

main().catch(e => {
    log(`Error fatal: ${e.message}\n${e.stack}`);
    console.error("Error en planner-propose-interactive:", e.message);
    process.exit(1);
});
