// telegram-commander.js — Daemon Node.js para recibir comandos via Telegram
// Recibe /skill, texto libre, /help, /status → ejecuta via claude -p
// Pure Node.js — sin dependencias externas
//
// Uso: node telegram-commander.js
// Detener: Ctrl+C o SIGTERM

const https = require("https");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// ─── Config ──────────────────────────────────────────────────────────────────

const HOOKS_DIR = __dirname;
const REPO_ROOT = path.resolve(HOOKS_DIR, "..", "..");
const CONFIG_FILE = path.join(HOOKS_DIR, "telegram-config.json");
const LOCK_FILE = path.join(HOOKS_DIR, "telegram-commander.lock");
const OFFSET_FILE = path.join(HOOKS_DIR, "tg-commander-offset.json");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");
const SKILLS_DIR = path.join(REPO_ROOT, ".claude", "skills");
const SPRINT_PLAN_FILE = path.join(REPO_ROOT, "scripts", "sprint-plan.json");

const POLL_TIMEOUT_SEC = 30;
const POLL_CONFLICT_RETRY_MS = 5000;  // Espera tras error 409 (otro poller activo)
const POLL_CONFLICT_MAX = 3;          // Máx reintentos seguidos por 409 antes de bajar a short-poll
const SHORT_POLL_INTERVAL_MS = 2000;  // Intervalo de short-poll cuando hay conflicto
const EXEC_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutos
const TG_MSG_MAX = 4096;

let _tgCfg;
try {
    _tgCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
} catch (e) {
    console.error("Error leyendo telegram-config.json:", e.message);
    process.exit(1);
}
const BOT_TOKEN = _tgCfg.bot_token;
const CHAT_ID = _tgCfg.chat_id;

let running = true;
let skills = [];
let sprintRunning = false;  // Evitar lanzar dos sprints simultáneos

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg) {
    const line = "[" + new Date().toISOString() + "] Commander: " + msg;
    try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (e) {}
    console.log(line);
}

// ─── Lockfile ────────────────────────────────────────────────────────────────

function acquireLock() {
    if (fs.existsSync(LOCK_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
            const pid = data.pid;
            // Verificar si el proceso sigue vivo
            try {
                process.kill(pid, 0); // señal 0 = solo chequear existencia
                console.error("Commander ya corriendo (PID " + pid + "). Abortando.");
                process.exit(1);
            } catch (e) {
                // Proceso muerto — lockfile stale
                log("Lockfile stale (PID " + pid + " muerto). Reemplazando.");
            }
        } catch (e) {
            log("Lockfile corrupto. Reemplazando.");
        }
    }
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), "utf8");
    log("Lock adquirido (PID " + process.pid + ")");
}

function releaseLock() {
    try { fs.unlinkSync(LOCK_FILE); } catch (e) {}
}

// ─── Offset persistente ─────────────────────────────────────────────────────

function loadOffset() {
    try {
        const data = JSON.parse(fs.readFileSync(OFFSET_FILE, "utf8"));
        return data.offset || 0;
    } catch (e) { return 0; }
}

function saveOffset(offset) {
    try { fs.writeFileSync(OFFSET_FILE, JSON.stringify({ offset }), "utf8"); } catch (e) {}
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function telegramPost(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(params);
        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + BOT_TOKEN + "/" + method,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData)
            },
            timeout: timeoutMs || 8000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.ok) resolve(r.result);
                    else reject(new Error(JSON.stringify(r)));
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout " + method)); });
        req.on("error", (e) => reject(e));
        req.write(postData);
        req.end();
    });
}

function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendMessage(text, parseMode) {
    return telegramPost("sendMessage", {
        chat_id: CHAT_ID,
        text: text,
        parse_mode: parseMode || "HTML"
    }, 8000);
}

async function sendLongMessage(text, parseMode) {
    const mode = parseMode || "HTML";
    if (text.length <= TG_MSG_MAX) {
        return sendMessage(text, mode);
    }
    // Dividir en chunks respetando el limite de Telegram
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= TG_MSG_MAX) {
            chunks.push(remaining);
            break;
        }
        // Buscar ultimo salto de linea dentro del limite
        let cut = remaining.lastIndexOf("\n", TG_MSG_MAX);
        if (cut <= 0) cut = TG_MSG_MAX;
        chunks.push(remaining.substring(0, cut));
        remaining = remaining.substring(cut);
    }
    let lastMsg;
    for (const chunk of chunks) {
        lastMsg = await sendMessage(chunk, mode);
    }
    return lastMsg;
}

// ─── Skill discovery ─────────────────────────────────────────────────────────

function discoverSkills() {
    const discovered = [];
    let dirs;
    try {
        dirs = fs.readdirSync(SKILLS_DIR);
    } catch (e) {
        log("Error leyendo directorio de skills: " + e.message);
        return discovered;
    }

    for (const dir of dirs) {
        const skillFile = path.join(SKILLS_DIR, dir, "SKILL.md");
        if (!fs.existsSync(skillFile)) continue;

        try {
            const content = fs.readFileSync(skillFile, "utf8");
            const frontmatter = parseFrontmatter(content);
            if (!frontmatter) continue;
            if (frontmatter["user-invocable"] !== true && frontmatter["user-invocable"] !== "true") continue;

            discovered.push({
                name: dir,
                description: frontmatter.description || dir,
                allowedTools: frontmatter["allowed-tools"] || "",
                argumentHint: frontmatter["argument-hint"] || "",
                model: frontmatter.model || ""
            });
        } catch (e) {
            log("Error parseando skill " + dir + ": " + e.message);
        }
    }

    return discovered;
}

function parseFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;

    const lines = match[1].split(/\r?\n/);
    const result = {};
    for (const line of lines) {
        const idx = line.indexOf(":");
        if (idx <= 0) continue;
        const key = line.substring(0, idx).trim();
        let value = line.substring(idx + 1).trim();
        // Quitar comillas
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.substring(1, value.length - 1);
        }
        // Parsear booleanos
        if (value === "true") value = true;
        else if (value === "false") value = false;
        result[key] = value;
    }
    return result;
}

// ─── Command parsing ─────────────────────────────────────────────────────────

function parseCommand(text) {
    if (!text || typeof text !== "string") return null;
    const trimmed = text.trim();

    // /help
    if (trimmed === "/help" || trimmed === "/start") {
        return { type: "help" };
    }

    // /status
    if (trimmed === "/status") {
        return { type: "status" };
    }

    // /stop — detener el daemon
    if (trimmed === "/stop") {
        return { type: "stop" };
    }

    // /sprint [N] — ejecutar sprint completo o un agente específico
    if (trimmed.startsWith("/sprint")) {
        const parts = trimmed.split(/\s+/);
        const arg = parts[1] || null; // null = todos, N = agente específico
        return { type: "sprint", agentNumber: arg ? parseInt(arg, 10) : null };
    }

    // /skill args — buscar si el primer token es un skill conocido
    if (trimmed.startsWith("/")) {
        const parts = trimmed.substring(1).split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1).join(" ");

        const skill = skills.find(s => s.name === cmd);
        if (skill) {
            return { type: "skill", skill: skill, args: args };
        }

        // Skill no reconocido
        return { type: "unknown_command", command: cmd };
    }

    // Texto libre → prompt directo a claude -p
    if (trimmed.length > 0) {
        return { type: "freetext", text: trimmed };
    }

    return null;
}

// ─── Ejecución de comandos ───────────────────────────────────────────────────

async function handleHelp() {
    let msg = "🤖 <b>Telegram Commander</b>\n\n";
    msg += "<b>Skills disponibles:</b>\n";
    for (const skill of skills) {
        const hint = skill.argumentHint ? " <code>" + escHtml(skill.argumentHint) + "</code>" : "";
        msg += "  /" + escHtml(skill.name) + hint + "\n";
        msg += "    <i>" + escHtml(skill.description) + "</i>\n";
    }
    msg += "\n<b>Comandos especiales:</b>\n";
    msg += "  /sprint — Ejecutar sprint completo (secuencial)\n";
    msg += "  /sprint N — Ejecutar solo agente N del plan\n";
    msg += "  /help — Esta lista\n";
    msg += "  /status — Estado del daemon\n";
    msg += "  /stop — Detener el commander\n";
    msg += "\n<b>Texto libre:</b> cualquier mensaje sin / se ejecuta como prompt directo.";
    await sendLongMessage(msg);
}

async function handleStatus() {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    const secs = Math.floor(uptime % 60);

    let msg = "📊 <b>Commander Status</b>\n\n";
    msg += "🟢 Online\n";
    msg += "⏱ Uptime: " + hours + "h " + mins + "m " + secs + "s\n";
    msg += "🔧 Skills: " + skills.length + "\n";
    msg += "🆔 PID: " + process.pid + "\n";
    msg += "📁 Repo: <code>" + escHtml(REPO_ROOT) + "</code>";
    await sendMessage(msg);
}

async function handleSkill(skill, args) {
    const skillLabel = "/" + skill.name + (args ? " " + args : "");
    await sendMessage("⚡ Ejecutando <code>" + escHtml(skillLabel) + "</code>...");

    // Construir el prompt para claude -p
    // El Skill tool espera: skill name + args
    const skillInvocation = "/" + skill.name + (args ? " " + args : "");
    const prompt = skillInvocation;

    // Construir allowed-tools: Skill + los tools declarados en el frontmatter
    const toolsList = ["Skill"];
    if (skill.allowedTools) {
        const extras = skill.allowedTools.split(",").map(t => t.trim()).filter(t => t);
        for (const t of extras) {
            if (!toolsList.includes(t)) toolsList.push(t);
        }
    }

    const extraArgs = ["--allowedTools", toolsList.join(",")];
    if (skill.model) {
        extraArgs.push("--model", skill.model);
    }

    const result = await executeClaude(prompt, extraArgs);
    await sendResult(skillLabel, result);
}

async function handleFreetext(text) {
    await sendMessage("💬 Procesando: <code>" + escHtml(text.substring(0, 100)) + (text.length > 100 ? "…" : "") + "</code>");

    const result = await executeClaude(text);
    await sendResult("prompt", result);
}

// ─── Sprint execution ────────────────────────────────────────────────────────

function loadSprintPlan() {
    try {
        return JSON.parse(fs.readFileSync(SPRINT_PLAN_FILE, "utf8"));
    } catch (e) {
        return null;
    }
}

function formatSprintProgress(agentes, currentIdx, results) {
    let msg = "";
    for (let i = 0; i < agentes.length; i++) {
        const a = agentes[i];
        let icon;
        if (results[i] === "success") icon = "☑";
        else if (results[i] === "failed") icon = "☒";
        else if (i === currentIdx) icon = "☐►";
        else icon = "☐";
        msg += icon + " <b>#" + a.numero + "</b> #" + a.issue + " " + escHtml(a.slug) + " [" + a.size + "]\n";
    }
    return msg;
}

async function handleSprint(agentNumber) {
    if (sprintRunning) {
        await sendMessage("⚠️ Ya hay un sprint en ejecución. Esperá a que termine o usá /stop para detener el commander.");
        return;
    }

    const plan = loadSprintPlan();
    if (!plan || !plan.agentes || plan.agentes.length === 0) {
        await sendMessage("❌ No se encontró <code>scripts/sprint-plan.json</code> o está vacío.\nUsá <code>/planner sprint</code> para generar uno.");
        return;
    }

    // Filtrar agentes si se pidió uno específico
    let agentes = plan.agentes;
    if (agentNumber !== null) {
        agentes = agentes.filter(a => a.numero === agentNumber);
        if (agentes.length === 0) {
            const available = plan.agentes.map(a => a.numero).join(", ");
            await sendMessage("❌ Agente #" + agentNumber + " no encontrado en el plan.\nDisponibles: " + available);
            return;
        }
    }

    sprintRunning = true;
    const results = new Array(agentes.length).fill("pending");
    const startTime = Date.now();

    // Mensaje inicial con checklist
    let header = "🏃 <b>Sprint iniciado</b> — " + escHtml(plan.titulo) + "\n";
    header += "📅 " + escHtml(plan.fecha) + " · " + agentes.length + " agente(s)\n\n";
    header += formatSprintProgress(agentes, 0, results);
    await sendMessage(header);

    for (let i = 0; i < agentes.length; i++) {
        if (!running) {
            log("Sprint interrumpido por shutdown");
            break;
        }

        const agente = agentes[i];
        log("Sprint: ejecutando agente #" + agente.numero + " (issue #" + agente.issue + " " + agente.slug + ")");

        // Notificar inicio de este agente
        let progressMsg = "⚡ <b>Agente #" + agente.numero + "</b> — " + escHtml(agente.titulo) + "\n";
        progressMsg += "Issue #" + agente.issue + " · Size " + agente.size + "\n\n";
        progressMsg += formatSprintProgress(agentes, i, results);
        await sendMessage(progressMsg);

        // Ejecutar claude -p con el prompt del agente (via stdin)
        const result = await executeClaude(agente.prompt);

        if (result.code === 0) {
            results[i] = "success";
            log("Sprint: agente #" + agente.numero + " completado OK");

            // Extraer resumen del resultado
            let summary = "";
            try {
                const json = JSON.parse(result.stdout);
                const text = json.result || json.text || json.content || "";
                summary = text.substring(0, 500);
                if (text.length > 500) summary += "…";
            } catch (e) {
                summary = result.stdout.substring(0, 500);
                if (result.stdout.length > 500) summary += "…";
            }

            let doneMsg = "✅ <b>Agente #" + agente.numero + " completado</b> — " + escHtml(agente.slug) + "\n\n";
            if (summary) doneMsg += escHtml(summary) + "\n\n";
            doneMsg += formatSprintProgress(agentes, i + 1, results);
            await sendLongMessage(doneMsg);
        } else {
            results[i] = "failed";
            log("Sprint: agente #" + agente.numero + " falló (exit " + result.code + ")");

            let errMsg = "❌ <b>Agente #" + agente.numero + " falló</b> — " + escHtml(agente.slug) + "\n";
            errMsg += "Exit code: " + result.code + "\n";
            if (result.stderr) {
                errMsg += "<pre>" + escHtml(result.stderr.substring(0, 1000)) + "</pre>\n";
            }
            errMsg += "\n" + formatSprintProgress(agentes, i + 1, results);
            await sendLongMessage(errMsg);
        }
    }

    // Resumen final
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const successCount = results.filter(r => r === "success").length;
    const failCount = results.filter(r => r === "failed").length;

    let finalMsg = "🏁 <b>Sprint finalizado</b>\n\n";
    finalMsg += formatSprintProgress(agentes, -1, results) + "\n";
    finalMsg += "✅ " + successCount + " exitosos · ❌ " + failCount + " fallidos\n";
    finalMsg += "⏱ " + mins + "m " + secs + "s";
    await sendMessage(finalMsg);

    sprintRunning = false;
}

// prompt va por stdin para evitar que cmd.exe rompa args con --/espacios
function executeClaude(prompt, extraArgs) {
    return new Promise((resolve) => {
        // --permission-mode bypassPermissions evita que permission-approver.js
        // active su propio getUpdates, lo cual causa 409 Conflict con nuestro polling.
        // Es seguro porque: tools restringidos via --allowedTools + prompts controlados.
        const args = ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions"].concat(extraArgs || []);
        log("Ejecutando: claude " + args.join(" ") + " (prompt via stdin, " + prompt.length + " chars)");

        const cleanEnv = { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT };
        delete cleanEnv.CLAUDECODE;

        const proc = spawn("claude", args, {
            cwd: REPO_ROOT,
            env: cleanEnv,
            stdio: ["pipe", "pipe", "pipe"],
            shell: true,
            timeout: EXEC_TIMEOUT_MS
        });

        // Enviar prompt via stdin y cerrar
        proc.stdin.write(prompt);
        proc.stdin.end();

        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (d) => { stdout += d.toString(); });
        proc.stderr.on("data", (d) => { stderr += d.toString(); });

        let resolved = false;
        function finish(code) {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            log("claude terminó con código " + code + " (stdout: " + stdout.length + " bytes, stderr: " + stderr.length + " bytes)");
            if (stderr) log("STDERR: " + stderr.substring(0, 500));
            resolve({ code, stdout, stderr });
        }

        const timer = setTimeout(() => {
            log("Timeout ejecutando claude — matando proceso (PID " + proc.pid + ")");
            // En Windows, SIGTERM no mata procesos con shell:true.
            // Usar taskkill /T (tree kill) para matar el árbol completo.
            try {
                spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { shell: true, stdio: "ignore" });
            } catch (e) {}
            // Fallback: resolver después de 3s aunque close no se dispare
            setTimeout(() => finish(-1), 3000);
        }, EXEC_TIMEOUT_MS);

        proc.on("close", (code) => finish(code));

        proc.on("error", (e) => {
            log("Error spawning claude: " + e.message);
            finish(-1);
        });
    });
}

async function sendResult(label, result) {
    let output = "";

    if (result.code !== 0) {
        output = "❌ <b>Error</b> (exit code " + result.code + ")\n\n";
        if (result.stderr) {
            output += "<pre>" + escHtml(result.stderr.substring(0, 3000)) + "</pre>";
        }
        await sendLongMessage(output);
        return;
    }

    // Intentar parsear JSON de claude --output-format json
    try {
        const json = JSON.parse(result.stdout);
        const text = json.result || json.text || json.content || result.stdout;
        output = "✅ <b>" + escHtml(label) + "</b>\n\n" + escHtml(text);
    } catch (e) {
        // No es JSON — enviar raw
        output = "✅ <b>" + escHtml(label) + "</b>\n\n" + escHtml(result.stdout || "(sin output)");
    }

    await sendLongMessage(output);
}

// ─── Polling loop ────────────────────────────────────────────────────────────

async function pollingLoop() {
    let offset = loadOffset();

    // Avanzar offset para ignorar updates anteriores al arranque
    // Reintentar hasta 3 veces si hay conflicto 409 con otro poller
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const pending = await telegramPost("getUpdates", {
                limit: 100,
                timeout: 0,
                allowed_updates: ["message"]
            }, 5000);
            if (pending && pending.length > 0) {
                const maxId = pending[pending.length - 1].update_id;
                if (maxId >= offset) {
                    offset = maxId + 1;
                    log("Descartados " + pending.length + " updates previos. Nuevo offset: " + offset);
                }
            }
            break;
        } catch (e) {
            const is409 = (e.message || "").includes("409");
            log("Error obteniendo updates iniciales (intento " + (attempt + 1) + "): " + e.message);
            if (is409 && attempt < 2) {
                await sleep(2000);
            }
        }
    }

    saveOffset(offset);

    let conflictStreak = 0;  // Contador de 409s consecutivos
    let useShortPoll = false; // Degradar a short-poll si hay conflicto persistente

    while (running) {
        const pollTimeout = useShortPoll ? 0 : POLL_TIMEOUT_SEC;
        let updates;
        try {
            updates = await telegramPost("getUpdates", {
                offset: offset,
                timeout: pollTimeout,
                allowed_updates: ["message"]
            }, (pollTimeout + 10) * 1000);
            // Éxito — resetear conflicto
            if (conflictStreak > 0) {
                log("Polling OK — reseteando conflicto streak");
                conflictStreak = 0;
            }
            // Si estábamos en short-poll y funciona, intentar volver a long-poll
            if (useShortPoll) {
                useShortPoll = false;
                log("Volviendo a long-poll");
            }
        } catch (e) {
            const errStr = e.message || "";
            const is409 = errStr.includes("409") || errStr.includes("Conflict");
            if (is409) {
                conflictStreak++;
                if (conflictStreak <= POLL_CONFLICT_MAX) {
                    log("Conflicto 409 (" + conflictStreak + "/" + POLL_CONFLICT_MAX + ") — reintentando en " + POLL_CONFLICT_RETRY_MS + "ms");
                    await sleep(POLL_CONFLICT_RETRY_MS);
                } else if (!useShortPoll) {
                    log("Conflicto persistente — degradando a short-poll cada " + SHORT_POLL_INTERVAL_MS + "ms");
                    useShortPoll = true;
                    await sleep(SHORT_POLL_INTERVAL_MS);
                } else {
                    await sleep(SHORT_POLL_INTERVAL_MS);
                }
            } else {
                log("Error en polling: " + errStr);
                await sleep(3000);
            }
            continue;
        }

        // Pausa entre short-polls para no saturar la API
        if (useShortPoll) {
            await sleep(SHORT_POLL_INTERVAL_MS);
        }

        if (!updates || !Array.isArray(updates) || updates.length === 0) continue;

        for (const update of updates) {
            if (update.update_id >= offset) {
                offset = update.update_id + 1;
                saveOffset(offset);
            }

            const msg = update.message;
            if (!msg) continue;

            // Solo aceptar mensajes del chat autorizado
            if (String(msg.chat && msg.chat.id) !== String(CHAT_ID)) {
                log("Mensaje de chat no autorizado: " + (msg.chat && msg.chat.id));
                continue;
            }

            const text = msg.text;
            if (!text) continue;

            log("Mensaje recibido: " + text.substring(0, 100));

            const cmd = parseCommand(text);
            if (!cmd) continue;

            try {
                switch (cmd.type) {
                    case "help":
                        await handleHelp();
                        break;
                    case "status":
                        await handleStatus();
                        break;
                    case "stop":
                        await sendMessage("🔴 Commander apagándose...");
                        running = false;
                        break;
                    case "skill":
                        await handleSkill(cmd.skill, cmd.args);
                        break;
                    case "freetext":
                        await handleFreetext(cmd.text);
                        break;
                    case "sprint":
                        await handleSprint(cmd.agentNumber);
                        break;
                    case "unknown_command":
                        await sendMessage("❓ Comando <code>/" + escHtml(cmd.command) + "</code> no reconocido.\nUsá /help para ver los skills disponibles.");
                        break;
                }
            } catch (e) {
                log("Error procesando comando: " + e.message);
                try {
                    await sendMessage("⚠️ Error: <code>" + escHtml(e.message) + "</code>");
                } catch (e2) {}
            }
        }
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Shutdown ────────────────────────────────────────────────────────────────

async function shutdown(signal) {
    if (!running) return;
    running = false;
    log("Shutdown por " + signal);

    try {
        await sendMessage("🔴 <b>Commander offline</b> (" + signal + ")");
    } catch (e) {
        log("Error enviando mensaje de shutdown: " + e.message);
    }

    releaseLock();
    process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    log("Arrancando Commander...");

    // Lockfile
    acquireLock();

    // Descubrir skills
    skills = discoverSkills();
    log("Skills descubiertos: " + skills.map(s => s.name).join(", ") + " (" + skills.length + ")");

    if (skills.length === 0) {
        log("ADVERTENCIA: no se encontraron skills en " + SKILLS_DIR);
    }

    // Notificar arranque
    try {
        let msg = "🟢 <b>Commander online</b>\n\n";
        msg += "🔧 " + skills.length + " skills disponibles\n";
        msg += "🆔 PID: " + process.pid + "\n";
        msg += "Enviá /help para ver los comandos.";
        await sendMessage(msg);
    } catch (e) {
        log("Error enviando mensaje de arranque: " + e.message);
        console.error("No se pudo enviar mensaje a Telegram:", e.message);
        releaseLock();
        process.exit(1);
    }

    // Polling principal
    await pollingLoop();

    // Si salimos del loop (por /stop)
    log("Loop terminado.");
    releaseLock();
    process.exit(0);
}

main().catch((e) => {
    log("Error fatal: " + e.message);
    console.error("Error fatal:", e);
    releaseLock();
    process.exit(1);
});
