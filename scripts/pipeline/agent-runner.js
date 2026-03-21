#!/usr/bin/env node
// agent-runner.js — Orquestador pre/post-Claude para agentes del sprint
// Ejecuta: pre-flight → Claude (prompt reducido) → tests → security → build → delivery
// Reduce el consumo de tokens ~44% al ejecutar tareas mecanicas como scripts externos.
//
// Uso: node agent-runner.js --workdir <dir> --prompt-file <file> --model <model>
//        --issue <N> --agent-num <N> --slug <slug> --branch <branch> --log-file <file>
//
// Modo: pipeline_mode en sprint-plan.json controla el comportamiento:
//   "scripts" = pipeline completo (pre/post scripts)
//   "skills"  = solo lanzar Claude sin wrapping (backward compat)
//   "hybrid"  = pre-flight como script, post-claude como skills (transicion gradual)

const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");
const { emitTransition, emitSkillInvoked, REPO_ROOT } = require("./emit-transition");

const PIPELINE_DIR = __dirname;
const LOGS_DIR = path.join(REPO_ROOT, "scripts", "logs");

// ─── Parse args ──────────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith("--") && i + 1 < args.length) {
            const key = args[i].substring(2).replace(/-/g, "_");
            opts[key] = args[++i];
        }
    }
    return {
        workDir: opts.workdir || process.cwd(),
        promptFile: opts.prompt_file || "",
        model: opts.model || "sonnet",
        issue: parseInt(opts.issue) || 0,
        agentNum: parseInt(opts.agent_num) || 1,
        slug: opts.slug || "",
        branch: opts.branch || "",
        logFile: opts.log_file || "",
    };
}

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg) {
    const ts = new Date().toISOString().substring(11, 19);
    const line = "[" + ts + "] " + msg;
    console.log(line);
    if (logFd) {
        try { fs.appendFileSync(logFd, line + "\n"); } catch (e) { }
    }
}

let logFd = null;

// ─── Pipeline mode detection ─────────────────────────────────────────────────

function getPipelineMode() {
    try {
        const plan = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "scripts", "sprint-plan.json"), "utf8"));
        return plan.pipeline_mode || "scripts"; // default: scripts (nuevo comportamiento)
    } catch (e) {
        return "scripts";
    }
}

// ─── Pre-flight ──────────────────────────────────────────────────────────────

function runPreFlight(workDir) {
    log("FASE 0: Pre-flight (verificacion de entorno)");
    try {
        const result = execSync("node " + path.join(PIPELINE_DIR, "pre-flight.js"), {
            cwd: workDir,
            encoding: "utf8",
            timeout: 60000,
            windowsHide: true,
            env: { ...process.env, CLAUDE_PROJECT_DIR: workDir },
        });
        log(result.trim().split("\n").pop()); // Ultima linea del pre-flight
        return true;
    } catch (e) {
        log("Pre-flight FALLO: " + (e.message || "").substring(0, 200));
        return false;
    }
}

// ─── Claude execution ────────────────────────────────────────────────────────

function runClaude(config) {
    return new Promise((resolve, reject) => {
        const claudePath = path.join(process.env.APPDATA || "", "npm", "claude.cmd");
        const args = ["-p", "--model", config.model, "--dangerously-skip-permissions",
            "--output-format", "stream-json", "--verbose"];

        log("FASE 1-4: Claude (" + config.model + ") — skills de razonamiento");

        const child = spawn(claudePath, args, {
            cwd: config.workDir,
            env: {
                ...process.env,
                CLAUDE_PROJECT_DIR: config.workDir,
                AGENT_SESSION_ID: process.env.AGENT_SESSION_ID || "",
            },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: false,
            shell: true, // Necesario en Windows para ejecutar .cmd
        });

        // Enviar prompt
        const prompt = fs.readFileSync(config.promptFile, "utf8");
        child.stdin.write(prompt);
        child.stdin.end();

        let toolCount = 0;
        let msgCount = 0;
        let resultText = "";

        child.stdout.on("data", (chunk) => {
            const lines = chunk.toString().split("\n").filter(l => l.trim());
            for (const line of lines) {
                // Log raw line
                if (logFd) {
                    try { fs.appendFileSync(logFd, line + "\n"); } catch (e) { }
                }

                try {
                    const evt = JSON.parse(line);
                    if (evt.type === "assistant" && evt.message && evt.message.content) {
                        for (const block of evt.message.content) {
                            if (block.type === "tool_use") {
                                toolCount++;
                                const name = block.name;
                                let snippet = block.input.command || block.input.pattern ||
                                    block.input.file_path || block.input.description || "";
                                if (snippet.length > 80) snippet = snippet.substring(0, 80);
                                log("  [" + toolCount + "] " + name + (snippet ? ": " + snippet : ""));
                            } else if (block.type === "text" && block.text) {
                                msgCount++;
                            }
                        }
                    } else if (evt.type === "result" && evt.result) {
                        resultText = evt.result;
                    }
                } catch (e) { /* not JSON */ }
            }
        });

        child.stderr.on("data", (chunk) => {
            if (logFd) {
                try { fs.appendFileSync(logFd, "STDERR: " + chunk.toString() + "\n"); } catch (e) { }
            }
        });

        child.on("close", (code) => {
            log("Claude finalizo: exit=" + code + ", tools=" + toolCount + ", msgs=" + msgCount);
            resolve({ exitCode: code, toolCount, msgCount, result: resultText });
        });

        child.on("error", (err) => {
            reject(err);
        });
    });
}

// ─── Collect API usage metrics (#1683) ───────────────────────────────────────

function collectApiMetrics(config) {
    try {
        const collectScript = path.join(REPO_ROOT, "scripts", "collect-api-usage.js");
        if (!fs.existsSync(collectScript)) return;
        let sprint = "";
        try {
            const plan = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "scripts", "sprint-plan.json"), "utf8"));
            sprint = plan.sprint_id || "";
        } catch (e) { /* sin sprint */ }
        const sprintArg = sprint ? " --sprint " + sprint : "";
        execSync(
            'node "' + collectScript + '" --log "' + config.logFile + '" --agent ' + config.agentNum +
            ' --issue ' + config.issue + ' --slug "' + config.slug + '"' + sprintArg,
            { timeout: 30000, encoding: "utf8", windowsHide: true }
        );
        log("Métricas de API recolectadas");
    } catch (e) {
        log("WARN: collect-api-usage falló: " + (e.message || "").substring(0, 100));
    }
}

// ─── Post-Claude pipeline ────────────────────────────────────────────────────

function runPostPipeline(config, claudeResult) {
    const workDir = config.workDir;
    const scripts = [
        { name: "run-tests", file: "run-tests.js", args: ["Claude", "Security", workDir], gate: true },
        { name: "security-scan", file: "security-scan.js", args: ["Tester", "Builder", workDir], gate: true },
        { name: "build-check", file: "build-check.js", args: ["Security", "DeliveryManager", workDir], gate: false },
        { name: "auto-delivery", file: "auto-delivery.js", args: ["Builder", workDir], gate: false },
    ];

    const results = {};

    for (const script of scripts) {
        log("POST: " + script.name);
        try {
            const output = execSync(
                "node " + path.join(PIPELINE_DIR, script.file) + " " + script.args.join(" "),
                {
                    cwd: workDir,
                    encoding: "utf8",
                    timeout: 15 * 60 * 1000,
                    windowsHide: true,
                    env: {
                        ...process.env,
                        CLAUDE_PROJECT_DIR: workDir,
                        AGENT_SESSION_ID: process.env.AGENT_SESSION_ID || "",
                        PATH: "/c/Workspaces/gh-cli/bin:" + process.env.PATH,
                    },
                }
            );
            results[script.name] = { ok: true, output: output.trim() };
            log("  " + script.name + ": OK");
        } catch (e) {
            results[script.name] = { ok: false, output: (e.stdout || "") + (e.stderr || "") };
            log("  " + script.name + ": FALLO");

            if (script.gate) {
                log("Gate " + script.name + " fallo — abortando pipeline post-Claude");
                // Intentar re-invocar Claude con errores? Por ahora, solo loguear
                return { ok: false, failedGate: script.name, results };
            }
        }
    }

    return { ok: true, results };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const config = parseArgs();
    const mode = getPipelineMode();

    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

    if (config.logFile) {
        logFd = config.logFile;
    }

    log("=== Agent Runner v1.0 ===");
    log("Issue: #" + config.issue + " (" + config.slug + ")");
    log("Branch: " + config.branch);
    log("Model: " + config.model);
    log("Mode: " + mode);

    // ─── Mode: skills (backward compat) ──────────────────────────────────
    if (mode === "skills") {
        log("Modo skills: lanzando Claude directamente (sin pipeline scripts)");
        const claudeResult = await runClaude(config);
        process.exit(claudeResult.exitCode);
    }

    // ─── Mode: scripts or hybrid ─────────────────────────────────────────

    // FASE 0: Pre-flight
    const preOk = runPreFlight(config.workDir);
    if (!preOk) {
        log("ABORT: Pre-flight fallo con errores criticos");
        process.exit(1);
    }

    // FASE 1-4: Claude (prompt reducido — solo /po + /dev + /review)
    let claudeResult;
    try {
        claudeResult = await runClaude(config);
    } catch (e) {
        log("ABORT: Claude no pudo iniciar: " + e.message);
        process.exit(1);
    }

    if (claudeResult.exitCode !== 0) {
        log("Claude termino con exit code " + claudeResult.exitCode);
    }

    // ─── Mode: hybrid → Claude maneja el post via skills ─────────────────
    if (mode === "hybrid") {
        log("Modo hybrid: post-pipeline delegado a Claude (skills)");
        process.exit(claudeResult.exitCode);
    }

    // ─── Mode: scripts → ejecutar post-pipeline ──────────────────────────
    // Obtener GH_TOKEN para auto-delivery
    if (!process.env.GH_TOKEN) {
        try {
            const token = execSync('printf "protocol=https\\nhost=github.com\\n" | git credential fill 2>/dev/null | grep "^password=" | cut -d= -f2',
                { encoding: "utf8", timeout: 10000, windowsHide: true, shell: true }).trim();
            if (token && token.length > 10) process.env.GH_TOKEN = token;
        } catch (e) { /* fallthrough */ }
        if (!process.env.GH_TOKEN) {
            try {
                const token = execSync("gh auth token", { encoding: "utf8", timeout: 5000, windowsHide: true,
                    env: { ...process.env, PATH: "/c/Workspaces/gh-cli/bin:" + process.env.PATH } }).trim();
                if (token && token.length > 10) process.env.GH_TOKEN = token;
            } catch (e) { /* fallthrough */ }
        }
    }
    log("=== Post-Claude Pipeline ===");
    const postResult = runPostPipeline(config, claudeResult);

    // ─── Escribir resultado estructurado para agent-retry-diagnostics.js (#1749) ──
    // Se escribe SIEMPRE (éxito y fallo) para que el módulo de diagnóstico pueda
    // determinar con precisión qué falló en el reintento.
    try {
        const buildResult = (postResult.results || {})["build-check"];
        const deliveryResult = (postResult.results || {})["auto-delivery"];
        const pipelineResultData = {
            timestamp: new Date().toISOString(),
            issue: config.issue,
            slug: config.slug,
            toolCalls: claudeResult.toolCount,
            exitCode: claudeResult.exitCode,
            ok: postResult.ok,
            failedGate: postResult.failedGate || null,
            buildOk: buildResult ? buildResult.ok : null,
            buildError: buildResult && !buildResult.ok
                ? (buildResult.output || "").substring(0, 500).trim()
                : null,
            deliveryOk: deliveryResult ? deliveryResult.ok : null,
        };
        fs.writeFileSync(
            path.join(LOGS_DIR, "agent-" + config.issue + "-pipeline-result.json"),
            JSON.stringify(pipelineResultData, null, 2),
            "utf8"
        );
        log("Pipeline result escrito: agent-" + config.issue + "-pipeline-result.json");
    } catch (e) {
        log("WARN: No se pudo escribir pipeline-result.json: " + (e.message || "").substring(0, 100));
    }

    if (!postResult.ok) {
        log("Pipeline fallo en gate: " + postResult.failedGate);
        // Guardar diagnostico (legacy — mantenido para compatibilidad)
        const diag = {
            timestamp: new Date().toISOString(),
            agent: config.agentNum,
            issue: config.issue,
            slug: config.slug,
            claudeExitCode: claudeResult.exitCode,
            claudeTools: claudeResult.toolCount,
            claudeMsgs: claudeResult.msgCount,
            failedGate: postResult.failedGate,
            pipelineResults: Object.fromEntries(
                Object.entries(postResult.results).map(([k, v]) => [k, v.ok])
            ),
        };
        fs.writeFileSync(
            path.join(LOGS_DIR, "agent-" + config.issue + "-diag.json"),
            JSON.stringify(diag, null, 2),
            "utf8"
        );

        collectApiMetrics(config);
        process.exit(1);
    }

    collectApiMetrics(config);

    log("=== Pipeline completo ===");
    process.exit(0);
}

main().catch(e => {
    console.error("[agent-runner] Fatal:", e.message);
    process.exit(1);
});
