// roadmap-planner.js — Distribuir issues del backlog en sprints futuros vacíos
// Sub-tarea de #1420. Llena automáticamente sprints vacíos con issues del backlog.
//
// Lógica:
//   1. Leer scripts/roadmap.json → contar sprints futuros con status !== "done"
//   2. Si sprints_futuros < 7:
//      a. Fetch issues abiertos de GitHub (gh issue list --state open --limit 200)
//      b. Excluir issues ya asignados a algún sprint del roadmap
//      c. Clasificar por prioridad y stream (bugs primero, balance de streams)
//      d. Distribuir en sprints vacíos (7-10 issues por sprint)
//      e. Escribir roadmap.json actualizado
//   3. Detectar insuficiencia de backlog:
//      a. Calcular issues_necesarios = sprints_vacios × MIN_ISSUES_PER_SPRINT
//      b. Si backlog_disponible < issues_necesarios → notificar vía Telegram
//
// Reglas de distribución:
//   - Bugs y bloqueantes → sprint más cercano
//   - Balance: no más del 60% de un stream por sprint
//   - Máximo 2 issues L/XL por sprint
//   - Issues con label "Refined" tienen prioridad
//
// Idempotente: ejecutar N veces = mismo resultado
//   - Solo toca sprints vacíos (sin issues), nunca sprints con issues ya asignados
//
// Uso standalone: node roadmap-planner.js [--dry-run]
// Uso como módulo: const { planRoadmap } = require('./roadmap-planner')
//
// Pure Node.js — sin dependencias externas

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

// ─── Paths ────────────────────────────────────────────────────────────────────

function resolveMainRepoRoot() {
    const envRoot = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
    try {
        const out = execSync("git worktree list", {
            encoding: "utf8", cwd: envRoot, timeout: 5000, windowsHide: true
        });
        const firstLine = out.split("\n")[0] || "";
        const match = firstLine.match(/^(.+?)\s+[0-9a-f]{5,}/);
        if (match) return match[1].trim().replace(/\\/g, "/");
    } catch (e) {}
    return envRoot.replace(/\\/g, "/");
}

const REPO_ROOT    = resolveMainRepoRoot();
const HOOKS_DIR    = path.join(REPO_ROOT, ".claude", "hooks");
const SCRIPTS_DIR  = path.join(REPO_ROOT, "scripts");
const ROADMAP_FILE = path.join(SCRIPTS_DIR, "roadmap.json");
const LOG_FILE     = path.join(HOOKS_DIR, "hook-debug.log");
const GH_PATH      = "C:\\Workspaces\\gh-cli\\bin\\gh.exe";
const TG_CONFIG_FILE = path.join(HOOKS_DIR, "telegram-config.json");

// ─── Constantes de distribución ───────────────────────────────────────────────

const MIN_HORIZON    = 7;   // Mínimo de sprints futuros (status !== "done") para no planificar
const MIN_ISSUES_PER_SPRINT = 7;   // Mínimo de issues a colocar por sprint vacío
const MAX_ISSUES_PER_SPRINT = 10;  // Máximo de issues por sprint
const MAX_LARGE_PER_SPRINT  = 2;   // Máximo de issues L/XL por sprint
const MAX_STREAM_RATIO      = 0.6; // Máximo 60% de un stream por sprint

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
    try {
        fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] roadmap-planner: " + msg + "\n");
    } catch (e) {}
    console.log("[roadmap-planner] " + msg);
}

// ─── JSON utils ───────────────────────────────────────────────────────────────

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
        return null;
    }
}

function writeJson(filePath, obj) {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

// ─── Clasificación de issues ──────────────────────────────────────────────────

/**
 * Determina el stream de un issue basado en sus labels.
 * Streams: E=Engineering/Infra, B=Business, C=Client, D=Delivery
 */
function getStream(labels) {
    if (labels.includes("app:business") || labels.includes("backlog-negocio"))  return "B";
    if (labels.includes("app:client")   || labels.includes("backlog-cliente"))  return "C";
    if (labels.includes("app:delivery") || labels.includes("backlog-delivery")) return "D";
    // Default: Engineering (backlog-tecnico, tipo:infra, area:*)
    return "E";
}

/**
 * Determina el tamaño de un issue basado en sus labels.
 */
function getSize(labels) {
    if (labels.includes("tamaño:XS") || labels.includes("size:XS")) return "XS";
    if (labels.includes("tamaño:S")  || labels.includes("size:S"))  return "S";
    if (labels.includes("tamaño:M")  || labels.includes("size:M"))  return "M";
    if (labels.includes("tamaño:L")  || labels.includes("size:L"))  return "L";
    if (labels.includes("tamaño:XL") || labels.includes("size:XL")) return "XL";
    return "M"; // Default M
}

function isLargeSize(size) {
    return size === "L" || size === "XL";
}

function isBugOrBlocker(labels) {
    return labels.includes("bug")         ||
           labels.includes("blocker")     ||
           labels.includes("tipo:bug")    ||
           labels.includes("tipo:blocker");
}

function isRefined(labels) {
    return labels.includes("Refined") || labels.includes("refined");
}

/**
 * Scoring de prioridad. Mayor score = mayor prioridad.
 * - Bloqueantes: 50 pts
 * - Bugs: 40 pts
 * - Backlog técnico: +30 pts (se suma, no reemplaza)
 * - Issues refinados: +20 pts
 * - Tamaño preferido (S/M antes que L/XL): hasta 10 pts
 */
function scoreIssue(issue) {
    const labels = issue.labels || [];
    let score = 0;

    // Tipo de impacto
    if (labels.includes("blocker"))    score += 50;
    else if (isBugOrBlocker(labels))   score += 40;
    else if (isRefined(labels))        score += 20;
    else                               score += 5;

    // Backlog técnico tiene bonus (siempre va primero)
    if (labels.includes("backlog-tecnico") || labels.includes("tipo:infra") ||
        labels.includes("area:infra")      || labels.includes("area:scrum") ||
        labels.includes("area:monitor"))   score += 30;

    // Tamaño preferido (más fácil de colocar = más útil)
    const size = getSize(labels);
    if (size === "XS" || size === "S") score += 10;
    else if (size === "M")             score += 7;
    else if (size === "L")             score += 4;
    else if (size === "XL")            score += 2;

    return score;
}

// ─── Fetch issues de GitHub ───────────────────────────────────────────────────

/**
 * Obtiene issues abiertos del repositorio intrale/platform.
 * Retorna array de { number, title, labels[] }
 */
function fetchOpenIssues(limit) {
    if (!fs.existsSync(GH_PATH)) {
        log("WARN: gh CLI no encontrado en " + GH_PATH);
        return [];
    }

    let raw = null;
    try {
        raw = execSync(
            `"${GH_PATH}" issue list --repo intrale/platform --state open ` +
            `--limit ${limit} --json number,title,labels`,
            { encoding: "utf8", timeout: 30000, windowsHide: true }
        ).trim();
    } catch (e) {
        log("ERROR fetching issues de GitHub: " + e.message);
        return [];
    }

    try {
        const issues = JSON.parse(raw);
        return issues.map(issue => ({
            number: issue.number,
            title:  issue.title,
            labels: (issue.labels || []).map(l => l.name)
        }));
    } catch (e) {
        log("ERROR parseando JSON de issues: " + e.message);
        return [];
    }
}

// ─── Distribución de issues en un sprint ─────────────────────────────────────

/**
 * Distribuye issues del pool de candidatos en un sprint.
 *
 * Reglas aplicadas:
 *   1. Bugs y bloqueantes van primero (sprint más cercano)
 *   2. No más del 60% de un stream por sprint
 *   3. Máximo MAX_LARGE_PER_SPRINT issues L/XL por sprint
 *   4. Entre MIN_ISSUES_PER_SPRINT y MAX_ISSUES_PER_SPRINT issues por sprint
 *
 * @param {object[]} candidates - Issues candidatos, ya ordenados por prioridad
 * @param {number} targetMin - Mínimo de issues a asignar
 * @param {number} targetMax - Máximo de issues a asignar
 * @returns {[object[], object[]]} [asignados, restantes]
 */
function distributeIntoSprint(candidates, targetMin, targetMax) {
    const assigned = [];
    const rejected = []; // rechazados por restricciones

    // Límite de issues de un mismo stream: floor(targetMax * 60%)
    const maxStreamIssues = Math.floor(targetMax * MAX_STREAM_RATIO);

    const streamCounts = {};
    let largeCount = 0;

    // Primer pase: bugs/bloqueantes primero (ya ordenados por score), luego otros
    const bugs    = candidates.filter(i => isBugOrBlocker(i.labels));
    const nonBugs = candidates.filter(i => !isBugOrBlocker(i.labels));
    const ordered = [...bugs, ...nonBugs];

    for (const issue of ordered) {
        if (assigned.length >= targetMax) break;

        const stream      = getStream(issue.labels);
        const size        = getSize(issue.labels);
        const streamCount = streamCounts[stream] || 0;

        // Restricción de stream (max 60%)
        if (streamCount >= maxStreamIssues) {
            rejected.push(issue);
            continue;
        }

        // Restricción de tamaño L/XL (máx 2 por sprint)
        if (isLargeSize(size) && largeCount >= MAX_LARGE_PER_SPRINT) {
            rejected.push(issue);
            continue;
        }

        assigned.push(issue);
        streamCounts[stream] = streamCount + 1;
        if (isLargeSize(size)) largeCount++;
    }

    // Segundo pase: si quedamos por debajo del mínimo, agregar rechazados por stream
    // (es mejor llenar el sprint que dejarlo muy vacío)
    if (assigned.length < targetMin) {
        for (const issue of rejected) {
            if (assigned.length >= targetMin) break;
            const size = getSize(issue.labels);
            if (isLargeSize(size) && largeCount >= MAX_LARGE_PER_SPRINT) continue;
            assigned.push(issue);
            if (isLargeSize(size)) largeCount++;
        }
    }

    // Calcular restantes (los no asignados)
    const assignedNumbers = new Set(assigned.map(i => i.number));
    const remaining = candidates.filter(i => !assignedNumbers.has(i.number));

    return [assigned, remaining];
}

// ─── Notificación Telegram ────────────────────────────────────────────────────

/**
 * Lee la configuración de Telegram desde telegram-config.json.
 * Retorna { bot_token, chat_id } o null si no hay configuración.
 */
function readTelegramConfig() {
    try {
        return JSON.parse(fs.readFileSync(TG_CONFIG_FILE, "utf8"));
    } catch (e) {
        return null;
    }
}

/**
 * Envía un mensaje de texto a Telegram (fire-and-forget, no bloquea).
 * Falla silenciosamente para no interrumpir la distribución normal.
 */
function sendTelegramAlert(text) {
    try {
        const tg = readTelegramConfig();
        if (!tg || !tg.bot_token || !tg.chat_id) {
            log("WARN: Telegram no configurado — alerta omitida");
            return;
        }
        const params = JSON.stringify({
            chat_id: tg.chat_id,
            text,
            parse_mode: "HTML",
            disable_web_page_preview: true
        });
        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + tg.bot_token + "/sendMessage",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(params)
            },
            timeout: 10000
        }, (res) => {
            let body = "";
            res.on("data", (c) => body += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(body);
                    if (r.ok) log("Alerta Telegram enviada OK (msg_id=" + r.result.message_id + ")");
                    else log("WARN: Telegram error: " + body.substring(0, 200));
                } catch (e) { log("WARN: Telegram respuesta no-JSON: " + body.substring(0, 200)); }
            });
        });
        req.on("error", (e) => log("WARN: Telegram req error: " + e.message));
        req.write(params);
        req.end();
    } catch (e) {
        log("WARN: Error enviando alerta Telegram: " + e.message);
    }
}

/**
 * Detecta si el backlog es insuficiente para cubrir los sprints vacíos.
 * Si lo es, envía una alerta a Telegram.
 *
 * @param {number} emptySprints - Cantidad de sprints vacíos detectados
 * @param {number} backlogAvailable - Issues disponibles en el backlog
 * @returns {boolean} true si el backlog es insuficiente
 */
function detectAndNotifyInsufficientBacklog(emptySprints, backlogAvailable) {
    const issuesNeeded = emptySprints * MIN_ISSUES_PER_SPRINT;
    const isInsufficient = backlogAvailable < issuesNeeded;

    log(
        "Verificación de backlog: disponibles=" + backlogAvailable +
        " necesarios=" + issuesNeeded + " (sprints_vacios=" + emptySprints +
        " × " + MIN_ISSUES_PER_SPRINT + ")" +
        (isInsufficient ? " — INSUFICIENTE" : " — OK")
    );

    if (isInsufficient) {
        const deficit = issuesNeeded - backlogAvailable;
        const alertText =
            "⚠️ <b>Backlog insuficiente para 7 sprints</b>\n\n" +
            "📋 Issues disponibles: <b>" + backlogAvailable + "</b>\n" +
            "📋 Issues necesarios: <b>" + issuesNeeded + "</b> (" + emptySprints + " sprints × " + MIN_ISSUES_PER_SPRINT + ")\n" +
            "📉 Déficit: <b>" + deficit + " issues</b>\n\n" +
            "👉 Ejecutar <code>/planner proponer</code> para generar nuevas historias.";
        sendTelegramAlert(alertText);
    }

    return isInsufficient;
}

// ─── Función principal ────────────────────────────────────────────────────────

/**
 * planRoadmap() — Distribuye issues del backlog en sprints futuros vacíos.
 *
 * Idempotente: solo modifica sprints completamente vacíos (sin issues).
 * No altera sprints que ya tienen issues asignados.
 *
 * Condición de activación: sprints futuros (status !== "done") < MIN_HORIZON (7).
 *
 * @param {object} opts
 * @param {boolean} [opts.dryRun=false] - Si true, no escribe roadmap.json
 * @param {number}  [opts.limit=200]    - Límite de issues a pedir a GitHub
 * @returns {{ filled: number, skipped: number, remaining: number, horizon: number, backlogInsufficient: boolean, message: string }}
 */
function planRoadmap(opts) {
    opts = opts || {};
    const dryRun = opts.dryRun === true;
    const limit  = parseInt(opts.limit, 10) || 200;

    log("Iniciando planRoadmap()" + (dryRun ? " [dry-run]" : ""));

    // 1. Leer roadmap.json
    const roadmap = readJson(ROADMAP_FILE);
    if (!roadmap || !Array.isArray(roadmap.sprints)) {
        const msg = "ERROR: No se pudo leer roadmap.json o no tiene sprints";
        log(msg);
        return { filled: 0, skipped: 0, remaining: 0, horizon: 0, backlogInsufficient: false, message: msg };
    }

    // 2. Contar sprints futuros (status !== "done")
    const futureSprints = roadmap.sprints.filter(s => s.status !== "done");
    log("Sprints futuros: " + futureSprints.length + " (horizon mínimo: " + MIN_HORIZON + ")");

    if (futureSprints.length >= MIN_HORIZON) {
        const msg = "OK: " + futureSprints.length + " sprints futuros — no se necesita replanificación (mínimo: " + MIN_HORIZON + ")";
        log(msg);
        return { filled: 0, skipped: futureSprints.length, remaining: 0, horizon: futureSprints.length, backlogInsufficient: false, message: msg };
    }

    // 3. Colectar todos los issue numbers ya asignados en algún sprint
    const assignedNumbers = new Set();
    for (const sprint of roadmap.sprints) {
        for (const issue of (sprint.issues || [])) {
            assignedNumbers.add(issue.number);
        }
    }
    log("Issues ya asignados en roadmap: " + assignedNumbers.size);

    // 4. Fetch backlog de GitHub
    const openIssues = fetchOpenIssues(limit);
    log("Issues abiertos en GitHub: " + openIssues.length);

    // 5. Filtrar candidatos: no asignados
    const candidates = openIssues.filter(i => !assignedNumbers.has(i.number));
    log("Candidatos disponibles: " + candidates.length);

    // 6. Ordenar candidatos por prioridad (mayor score = primero)
    candidates.sort((a, b) => scoreIssue(b) - scoreIssue(a));

    // 7. Identificar sprints vacíos (sin issues) entre los futuros
    const emptySprints = futureSprints.filter(s =>
        !s.issues || s.issues.length === 0
    );
    log("Sprints vacíos a llenar: " + emptySprints.length);

    // Detectar insuficiencia de backlog (antes de distribuir, para alertar aunque no haya candidatos)
    const backlogInsufficient = detectAndNotifyInsufficientBacklog(emptySprints.length, candidates.length);

    if (candidates.length === 0) {
        const msg = "WARN: No hay issues disponibles en el backlog para distribuir";
        log(msg);
        return { filled: 0, skipped: 0, remaining: 0, horizon: futureSprints.length, backlogInsufficient: true, message: msg };
    }

    if (emptySprints.length === 0) {
        const msg = "INFO: No hay sprints vacíos — todos los sprints futuros ya tienen issues";
        log(msg);
        return { filled: 0, skipped: futureSprints.length, remaining: candidates.length, horizon: futureSprints.length, backlogInsufficient, message: msg };
    }

    // 8. Distribuir candidatos en sprints vacíos (más cercano primero)
    let pool = [...candidates];
    let filledCount = 0;

    for (const targetSprint of emptySprints) {
        if (pool.length === 0) {
            log("Sprint " + targetSprint.id + ": sin candidatos restantes en el backlog");
            break;
        }

        const [assigned, leftover] = distributeIntoSprint(
            pool, MIN_ISSUES_PER_SPRINT, MAX_ISSUES_PER_SPRINT
        );
        pool = leftover;

        if (assigned.length === 0) {
            log("Sprint " + targetSprint.id + ": ningún issue pudo asignarse (restricciones)");
            continue;
        }

        // Convertir al formato de roadmap.json
        const roadmapIssues = assigned.map(issue => ({
            number: issue.number,
            title:  issue.title,
            size:   getSize(issue.labels),
            stream: getStream(issue.labels),
            status: "planned"
        }));

        // Actualizar el sprint en el roadmap (buscar por id)
        const sprintIdx = roadmap.sprints.findIndex(s => s.id === targetSprint.id);
        if (sprintIdx !== -1) {
            roadmap.sprints[sprintIdx].issues = roadmapIssues;
        }

        const streamSummary = roadmapIssues.reduce((acc, i) => {
            acc[i.stream] = (acc[i.stream] || 0) + 1;
            return acc;
        }, {});

        log("Sprint " + targetSprint.id + ": " + assigned.length + " issues — " +
            Object.entries(streamSummary).map(([k, v]) => k + ":" + v).join(", "));

        filledCount++;
    }

    // 9. Actualizar metadata del roadmap
    roadmap.updated_ts = new Date().toISOString();
    roadmap.updated_by = "roadmap-planner";

    // 10. Escribir roadmap.json
    if (!dryRun) {
        writeJson(ROADMAP_FILE, roadmap);
        log("roadmap.json actualizado: " + filledCount + " sprint(s) llenados");
    } else {
        log("[dry-run] Se hubieran llenado " + filledCount + " sprint(s)");
    }

    const msg = "Distribución completa: " + filledCount + " sprints llenados, " +
                pool.length + " issues restantes en backlog";
    log(msg);

    return {
        filled:              filledCount,
        skipped:             emptySprints.length - filledCount,
        remaining:           pool.length,
        horizon:             futureSprints.length,
        backlogInsufficient: backlogInsufficient,
        message:             msg
    };
}

// ─── Exportar como módulo ─────────────────────────────────────────────────────

module.exports = { planRoadmap };

// ─── Invocable standalone ─────────────────────────────────────────────────────

if (require.main === module) {
    const dryRun = process.argv.includes("--dry-run");
    const result = planRoadmap({ dryRun });
    console.log("\n[roadmap-planner] " + result.message);
    console.log("[roadmap-planner] 📅 Horizonte: " + result.horizon + " sprints planificados");
    if (result.backlogInsufficient) {
        console.log("[roadmap-planner] ⚠️  Backlog insuficiente — ejecutar /planner proponer");
    }
    process.exit(0);
}
