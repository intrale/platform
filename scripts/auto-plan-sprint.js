#!/usr/bin/env node
// auto-plan-sprint.js — Planificación automática del siguiente sprint con priorización
// Se ejecuta automáticamente después de planner-propose-interactive.js.
//
// Priorización:
//   Fase 1 — Backlog Técnico (infra, hooks, pipeline, CI/CD, deuda técnica)
//   Fase 2 — QA/E2E pendiente (issues Ready sin validación QA)
//   Fase 3 — Backlog Negocio (features de producto para usuarios finales)
//
// Restricciones:
//   - Máx 5 historias por sprint
//   - Máx 2 agentes simultáneos en el array agentes
//   - Detecta y respeta dependencias
//   - Excluye issues bloqueados
//
// Uso: node auto-plan-sprint.js [--dry-run] [--max N]
// --dry-run: no escribe sprint-plan.json, imprime el plan en consola
// --max N: máximo de issues por sprint (default: 5)

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "auto-plan-sprint.log");
const SPRINT_PLAN_FILE = path.join(__dirname, "sprint-plan.json");
const GH_PATH = "C:\\Workspaces\\gh-cli\\bin\\gh.exe";

const DRY_RUN = process.argv.includes("--dry-run");
const MAX_IDX = process.argv.indexOf("--max");
const MAX_ISSUES = MAX_IDX !== -1 ? parseInt(process.argv[MAX_IDX + 1], 10) || 5 : 5;
const MAX_AGENTS = 3; // Máx agentes simultáneos (#1277: subido de 2 a 3)

// ─── Logging ─────────────────────────────────────────────────────────────────

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(msg) {
    ensureDir(LOG_DIR);
    const ts = new Date().toISOString();
    const line = `[${ts}] AutoPlan: ${msg}`;
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

// ─── Obtener issues de GitHub por backlog ─────────────────────────────────────

function fetchIssuesByLabel(label, limit = 20) {
    if (!fs.existsSync(GH_PATH)) return [];

    const raw = execSafe(
        `"${GH_PATH}" issue list --repo intrale/platform --state open --label "${label}" ` +
        `--limit ${limit} --json number,title,body,labels,assignees,milestone 2>/dev/null`
    );

    if (!raw) return [];

    try {
        const issues = JSON.parse(raw);
        return issues.map(issue => ({
            number: issue.number,
            title: issue.title,
            body: issue.body || "",
            labels: (issue.labels || []).map(l => l.name),
            assignees: (issue.assignees || []).map(a => a.login),
            milestone: issue.milestone ? issue.milestone.title : null
        }));
    } catch (e) {
        log(`Error parseando issues con label ${label}: ${e.message}`);
        return [];
    }
}

function fetchIssuesByState(state = "open", limit = 50) {
    if (!fs.existsSync(GH_PATH)) return [];

    const raw = execSafe(
        `"${GH_PATH}" issue list --repo intrale/platform --state ${state} ` +
        `--limit ${limit} --json number,title,body,labels,assignees,milestone 2>/dev/null`
    );

    if (!raw) return [];

    try {
        const issues = JSON.parse(raw);
        return issues.map(issue => ({
            number: issue.number,
            title: issue.title,
            body: issue.body || "",
            labels: (issue.labels || []).map(l => l.name),
            assignees: (issue.assignees || []).map(a => a.login),
            milestone: issue.milestone ? issue.milestone.title : null
        }));
    } catch (e) {
        log(`Error obteniendo issues: ${e.message}`);
        return [];
    }
}

// ─── Scoring de prioridad (planning-criteria.md) ─────────────────────────────

function scoreIssue(issue) {
    let score = 0;
    const labels = issue.labels || [];
    const bodyLower = (issue.body || "").toLowerCase();

    // Factor 1: Tipo de impacto (0-40 pts)
    if (bodyLower.includes("bloquea compilación") || bodyLower.includes("ci") || labels.includes("blocker")) {
        score += 40;
    } else if (bodyLower.includes("test failure") || bodyLower.includes("fallo en test")) {
        score += 35;
    } else if (labels.includes("bug")) {
        score += 30;
    } else if (bodyLower.includes("depende de") || bodyLower.includes("bloqueado por")) {
        score += 25;
    } else if (labels.includes("Refined") || labels.includes("refined")) {
        score += 15;
    } else {
        score += 5;
    }

    // Factor 2: Backlog técnico tiene bonus extra (Fase 1 siempre primero)
    if (labels.includes("backlog-tecnico") || labels.includes("tipo:infra") || labels.includes("area:infra")) {
        score += 30; // Bonus de backlog técnico
    }

    // Factor 3: Etiqueta de delegación (0-10 pts)
    if (labels.includes("codex")) {
        score += 10;
    }
    if (issue.assignees.length === 0) {
        score += 5;
    } else if (issue.assignees.includes("leitolarreta")) {
        score += 3;
    }

    // Factor 4: Tamaño estimado (preferir S/M)
    if (labels.includes("size:S") || labels.includes("tamaño:S")) {
        score += 10;
    } else if (labels.includes("size:M") || labels.includes("tamaño:M")) {
        score += 7;
    } else if (labels.includes("size:L") || labels.includes("tamaño:L")) {
        score += 4;
    } else {
        score += 5; // Default M
    }

    return score;
}

// ─── Detección de dependencias ────────────────────────────────────────────────

function extractDependencies(issue) {
    const body = issue.body || "";
    const deps = [];

    // Patrones explícitos
    const patterns = [
        /depende de #(\d+)/gi,
        /requiere #(\d+)/gi,
        /bloqueado por #(\d+)/gi,
        /necesita (?:que esté implementado )?#(\d+)/gi,
        /after #(\d+)/gi,
        /depends on #(\d+)/gi
    ];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(body)) !== null) {
            const depNum = parseInt(match[1], 10);
            if (!deps.includes(depNum)) deps.push(depNum);
        }
    }

    return deps;
}

function isBlocked(issue, selectedNumbers) {
    const deps = extractDependencies(issue);
    // Un issue está bloqueado si alguna de sus dependencias no está en el plan actual
    // Y esa dependencia todavía está abierta
    return deps.some(dep => !selectedNumbers.includes(dep));
}

// ─── Determinar stream del issue ──────────────────────────────────────────────

function detectStream(issue) {
    const labels = issue.labels || [];
    if (labels.some(l => l.startsWith("app:client"))) return "Stream B — Cliente";
    if (labels.some(l => l.startsWith("app:business"))) return "Stream C — Negocio";
    if (labels.some(l => l.startsWith("app:delivery"))) return "Stream D — Delivery";
    if (labels.includes("backlog-tecnico") || labels.includes("tipo:infra") || labels.includes("area:infra")) {
        return "Stream A — Backend/Infra";
    }
    return "Stream E — Cross-cutting";
}

function generateSlug(title) {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .substring(0, 40)
        .replace(/-+$/, "");
}

// ─── Selección de issues con priorización Técnico → QA → Negocio ─────────────

function selectIssues(allIssues) {
    const selected = [];
    const selectedNumbers = new Set();

    // ── Fase 1: Backlog Técnico ──────────────────────────────────────────────
    log("Fase 1: Seleccionando backlog técnico...");
    const techIssues = allIssues
        .filter(i =>
            i.labels.includes("backlog-tecnico") ||
            i.labels.includes("tipo:infra") ||
            i.labels.includes("area:infra") ||
            i.labels.some(l => l.includes("infra") || l.includes("pipeline") || l.includes("ci"))
        )
        .map(i => ({ ...i, score: scoreIssue(i) }))
        .sort((a, b) => b.score - a.score);

    for (const issue of techIssues) {
        if (selected.length >= MAX_ISSUES) break;
        if (selectedNumbers.has(issue.number)) continue;

        // Verificar que no está bloqueado por algo fuera del plan
        const deps = extractDependencies(issue);
        const externalDeps = deps.filter(d => !selectedNumbers.has(d));
        if (externalDeps.length > 0) {
            log(`Issue #${issue.number} bloqueado por dependencias externas: ${externalDeps.join(",")}`);
            continue;
        }

        selected.push(issue);
        selectedNumbers.add(issue.number);
    }

    log(`Fase 1 completada: ${selected.length} issues técnicos seleccionados`);

    // ── Fase 2: QA/E2E Pendiente ─────────────────────────────────────────────
    if (selected.length < MAX_ISSUES) {
        log("Fase 2: Seleccionando issues QA pendientes...");
        const qaIssues = allIssues
            .filter(i =>
                !selectedNumbers.has(i.number) &&
                (i.labels.includes("qa-pending") ||
                 i.labels.includes("needs-qa") ||
                 i.labels.includes("testing") ||
                 (i.body || "").toLowerCase().includes("qa e2e") ||
                 (i.body || "").toLowerCase().includes("validación qa"))
            )
            .map(i => ({ ...i, score: scoreIssue(i) }))
            .sort((a, b) => b.score - a.score);

        for (const issue of qaIssues) {
            if (selected.length >= MAX_ISSUES) break;
            if (selectedNumbers.has(issue.number)) continue;

            const deps = extractDependencies(issue);
            const externalDeps = deps.filter(d => !selectedNumbers.has(d));
            if (externalDeps.length > 0) continue;

            selected.push(issue);
            selectedNumbers.add(issue.number);
        }

        log(`Fase 2 completada: total ${selected.length} issues (incluyendo QA)`);
    }

    // ── Fase 3: Backlog Negocio ───────────────────────────────────────────────
    if (selected.length < MAX_ISSUES) {
        log("Fase 3: Seleccionando backlog de negocio...");
        const businessIssues = allIssues
            .filter(i =>
                !selectedNumbers.has(i.number) &&
                !i.labels.includes("backlog-tecnico") &&
                !i.labels.includes("tipo:infra") &&
                (i.labels.some(l => l.startsWith("app:")) ||
                 i.labels.includes("enhancement") ||
                 i.labels.includes("feature"))
            )
            .map(i => ({ ...i, score: scoreIssue(i) }))
            .sort((a, b) => b.score - a.score);

        for (const issue of businessIssues) {
            if (selected.length >= MAX_ISSUES) break;
            if (selectedNumbers.has(issue.number)) continue;

            const deps = extractDependencies(issue);
            const externalDeps = deps.filter(d => !selectedNumbers.has(d));
            if (externalDeps.length > 0) continue;

            selected.push(issue);
            selectedNumbers.add(issue.number);
        }

        log(`Fase 3 completada: total ${selected.length} issues (incluyendo negocio)`);
    }

    return selected;
}

// ─── Generar prompt adaptado según labels del issue (#1277, #1735) ───────────
//
// Reglas de adaptación:
//   app:*       → /ux (revisión visual) + /qa (E2E con video) obligatorios
//   area:backend → /security explícito y obligatorio
//   bug          → /tester con énfasis en regresiones
//   area:infra   → pipeline simplificado (sin /ux ni /qa)
//   default      → pipeline base con /tester, /builder, /security, /review

function generateDefaultPrompt(issue, slug, labels) {
    labels = Array.isArray(labels) ? labels : [];

    const hasApp = labels.some(l => l.startsWith("app:"));
    const isBug = labels.includes("bug");
    const isInfra = labels.includes("area:infra") || labels.includes("tipo:infra");

    const parts = [
        `Implementar issue #${issue}. Leer el issue completo con: gh issue view ${issue} --repo intrale/platform.`,
        `Al iniciar: invocar /ops para verificar estado del entorno.`,
        `Al iniciar: invocar /po para revisar criterios de aceptación del issue #${issue}.`
    ];

    if (!isInfra) {
        parts.push(`Si el issue menciona libs, patrones o frameworks nuevos: invocar /guru para investigación técnica.`);
    }

    parts.push(`Completar los cambios descritos en el body del issue.`);

    if (hasApp) {
        parts.push(`Antes de /delivery: invocar /ux para revisión visual de los cambios en la interfaz (obligatorio por labels app:*).`);
    }

    if (isBug) {
        parts.push(`Antes de /delivery: invocar /tester con énfasis en verificar que no hay regresiones relacionadas al bug.`);
    } else {
        parts.push(`Antes de /delivery: invocar /tester para verificar que los tests pasan.`);
    }

    parts.push(`Antes de /delivery: invocar /builder para validar que el build no está roto.`);
    parts.push(`Antes de /delivery: invocar /security para validar seguridad del diff.`);
    parts.push(`Antes de /delivery: invocar /review para validar el diff.`);

    if (hasApp) {
        parts.push(`Antes de /delivery: invocar /qa para E2E con video (obligatorio por labels app:*).`);
    }

    parts.push(`Usar /delivery para commit+PR al terminar. Closes #${issue}`);

    return parts.join(" ");
}

// ─── Generar sprint-plan.json ─────────────────────────────────────────────────

function generateSprintPlan(selectedIssues) {
    const today = new Date();

    // Construir agentes (máx MAX_AGENTS simultáneos)
    const agentes = selectedIssues.slice(0, MAX_AGENTS).map((issue, i) => ({
        numero: i + 1,
        issue: issue.number,
        slug: generateSlug(issue.title),
        stream: detectStream(issue),
        score: issue.score || 0,
        labels: issue.labels,
        dependencies: extractDependencies(issue),
        prompt: generateDefaultPrompt(issue.number, generateSlug(issue.title), issue.labels)
    }));

    const plan = {
        generado_por: "auto-plan-sprint.js",
        generado_at: new Date().toISOString(),
        priorization: "Técnico → QA → Negocio",
        max_issues: MAX_ISSUES,
        max_agents: MAX_AGENTS,
        concurrency_limit: MAX_AGENTS, // límite de agentes simultáneos (#1277)
        total_selected: selectedIssues.length,
        agentes,
        // Issues en cola (se lanzan automáticamente por agent-concurrency-check.js al liberar slots)
        cola: selectedIssues.slice(MAX_AGENTS).map((issue, i) => ({
            numero: MAX_AGENTS + i + 1,
            issue: issue.number,
            slug: generateSlug(issue.title),
            stream: detectStream(issue),
            score: issue.score || 0,
            labels: issue.labels,
            prompt: generateDefaultPrompt(issue.number, generateSlug(issue.title), issue.labels)
        }))
    };

    return plan;
}

// ─── Notificar por Telegram ───────────────────────────────────────────────────

async function notifyTelegram(plan) {
    if (!tgClient) {
        log("Telegram no disponible — saltando notificación");
        return;
    }

    function escHtml(str) {
        return (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    let text = `📅 <b>Plan del siguiente sprint generado</b>\n`;
    text += `<i>Priorización: Técnico → QA → Negocio</i>\n\n`;
    text += `<b>Sprint:</b> ${plan.sprint_id || "nuevo"} (${plan.size || "?"})\n`;
    text += `<b>Issues seleccionados:</b> ${plan.total_selected}/${plan.max_issues}\n\n`;

    text += `🚀 <b>Agentes (primeros 2, simultáneos):</b>\n`;
    for (const a of plan.agentes) {
        text += `  ${a.numero}. #${a.issue} — ${escHtml(a.slug)} [${a.stream}]\n`;
    }

    if (plan.cola && plan.cola.length > 0) {
        text += `\n⏳ <b>Cola (tandas sucesivas):</b>\n`;
        for (const a of plan.cola) {
            text += `  ${a.numero}. #${a.issue} — ${escHtml(a.slug)}\n`;
        }
    }

    text += `\n<i>Sprint-plan.json generado. Lanzar con Start-Agente.ps1 all</i>`;

    // Botones: Lanzar sprint / Ver plan completo
    const keyboard = [
        [
            { text: "🚀 Lanzar sprint", callback_data: "launch_sprint" },
            { text: "📋 Ver plan completo", callback_data: "view_sprint_plan" }
        ]
    ];

    try {
        await tgClient.telegramPost("sendMessage", {
            chat_id: tgClient.getChatId(),
            text,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: keyboard }
        }, 10000);
        log("Notificación de plan enviada a Telegram");
    } catch (e) {
        log(`Error enviando notificación a Telegram: ${e.message}`);
    }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    log("=== Iniciando auto-plan-sprint ===");

    if (!fs.existsSync(GH_PATH)) {
        log("ERROR: gh CLI no encontrado en " + GH_PATH);
        console.error("ERROR: gh CLI requerido para auto-plan-sprint");
        process.exit(1);
    }

    // 1. Obtener todos los issues abiertos
    log("Paso 1/4: Obteniendo issues abiertos de GitHub...");
    const allIssues = fetchIssuesByState("open", 60);
    log(`Issues obtenidos: ${allIssues.length}`);

    if (allIssues.length === 0) {
        log("No hay issues abiertos. Finalizando.");
        console.log("\n⚠️  No hay issues abiertos para planificar.\n");
        return;
    }

    // 2. Seleccionar issues con priorización
    log("Paso 2/4: Seleccionando issues con priorización Técnico → QA → Negocio...");
    const selectedIssues = selectIssues(allIssues);
    log(`Issues seleccionados: ${selectedIssues.length}`);

    if (selectedIssues.length === 0) {
        log("No se pudieron seleccionar issues elegibles. Finalizando.");
        console.log("\n⚠️  No hay issues elegibles para el sprint (quizás todos están bloqueados).\n");
        return;
    }

    // 3. Generar plan
    log("Paso 3/4: Generando sprint-plan.json...");
    const plan = generateSprintPlan(selectedIssues);

    if (DRY_RUN) {
        log("DRY RUN — mostrando plan en consola");
        console.log("\n=== PLAN GENERADO (DRY RUN) ===\n");
        console.log(JSON.stringify(plan, null, 2));
        console.log(`\nIssues seleccionados: ${selectedIssues.length}/${allIssues.length} disponibles\n`);

        console.log("Resumen de priorización:");
        const techCount = selectedIssues.filter(i =>
            i.labels.includes("backlog-tecnico") || i.labels.includes("tipo:infra")
        ).length;
        console.log(`  Fase 1 (Técnico): ${techCount} issues`);
        console.log(`  Fase 2 (QA): ${selectedIssues.filter(i => i.labels.includes("testing")).length} issues`);
        console.log(`  Fase 3 (Negocio): ${selectedIssues.length - techCount} issues`);
    } else {
        // Escribir sprint-plan.json
        fs.writeFileSync(SPRINT_PLAN_FILE, JSON.stringify(plan, null, 2), "utf8");
        log(`Sprint plan escrito: ${SPRINT_PLAN_FILE}`);
        console.log(`\n✅ Sprint plan generado: ${selectedIssues.length} issues seleccionados\n`);

        // 4. Notificar
        log("Paso 4/4: Notificando a Telegram...");
        await notifyTelegram(plan);
    }

    // Imprimir resumen siempre
    console.log("=== RESUMEN DEL PLAN ===");
    console.log(`Sprint: ${plan.sprint_id || "nuevo"} (${plan.size || "?"})`);
    console.log(`Total issues: ${plan.total_selected}`);
    console.log(`\nAgentes simultáneos (${plan.agentes.length}):`);
    for (const a of plan.agentes) {
        console.log(`  ${a.numero}. #${a.issue} — ${a.slug} [score: ${a.score}]`);
    }
    if (plan.cola && plan.cola.length > 0) {
        console.log(`\nCola (${plan.cola.length} issues en tandas):`);
        for (const a of plan.cola) {
            console.log(`  ${a.numero}. #${a.issue} — ${a.slug}`);
        }
    }

    log("=== auto-plan-sprint finalizado ===");
}

main().catch(e => {
    log(`Error fatal: ${e.message}\n${e.stack}`);
    console.error("Error en auto-plan-sprint:", e.message);
    process.exit(1);
});
