// agent-doctor.js — Recovery inteligente para agentes muertos
// Diagnostica causa de muerte leyendo logs + estado git + pipeline results.
// Intenta acciones correctivas ANTES de relanzar.
// Registra todo en scripts/logs/agent-recovery.jsonl.
//
// Causas detectadas:
//   no_delivery     log termina sin /delivery invocado
//   delivery_failed /delivery fue invocado pero fallo
//   exit_error      Claude salio con error (exit code != 0)
//   rate_limit      hit rate limit de la API
//   timeout         excedio tiempo maximo
//   crash           muerte abrupta sin log coherente
//   build_failed    build fallo (delegado a retry-diagnostics)
//   unknown         no se puede determinar
//
// Importado por: agent-watcher.js y agent-monitor.js
"use strict";

const fs   = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// --- Constantes ---

const CAUSES = {
    NO_DELIVERY:     "no_delivery",
    DELIVERY_FAILED: "delivery_failed",
    EXIT_ERROR:      "exit_error",
    RATE_LIMIT:      "rate_limit",
    TIMEOUT:         "timeout",
    CRASH:           "crash",
    BUILD_FAILED:    "build_failed",
    UNKNOWN:         "unknown",
};

// Patrones de busqueda en logs (orden importa: mas especifico primero)
const LOG_PATTERNS = [
    { pattern: /rate_limit|rate.?limited|429|Too Many Requests|overageStatus.*rejected/i, cause: CAUSES.RATE_LIMIT },
    { pattern: /timed?\s*out|timeout|ETIMEDOUT|excedio.*tiempo/i, cause: CAUSES.TIMEOUT },
    { pattern: /exit.?code[:\s]+[1-9]\d*/i, cause: CAUSES.EXIT_ERROR },
    { pattern: /SIGKILL|SIGTERM|SIGABRT|heap out of memory|JavaScript heap/i, cause: CAUSES.CRASH },
    { pattern: /delivery.*fail|push.*fail|PR.*fail|gh pr create.*error/i, cause: CAUSES.DELIVERY_FAILED },
    { pattern: /build.*fail|compilation.*error|BUILD FAILED/i, cause: CAUSES.BUILD_FAILED },
];

// Cooldown por causa (ms) antes de relanzar
const COOLDOWN_BY_CAUSE = {
    [CAUSES.RATE_LIMIT]:      600000,   // 10 min
    [CAUSES.TIMEOUT]:         120000,   // 2 min
    [CAUSES.CRASH]:           60000,    // 1 min
    [CAUSES.EXIT_ERROR]:      60000,    // 1 min
    [CAUSES.BUILD_FAILED]:    30000,    // 30s
    [CAUSES.DELIVERY_FAILED]: 10000,    // 10s
    [CAUSES.NO_DELIVERY]:     10000,    // 10s
    [CAUSES.UNKNOWN]:         120000,   // 2 min
};

const GH_CLI_CANDIDATES = [
    "C:\\Workspaces\\gh-cli\\bin\\gh.exe",
    "/c/Workspaces/gh-cli/bin/gh.exe",
    "gh"
];

// --- Helpers ---

function findGhCli() {
    for (const candidate of GH_CLI_CANDIDATES) {
        try {
            execSync('"' + candidate + '" --version', {
                encoding: "utf8", timeout: 3000, windowsHide: true, stdio: "pipe"
            });
            return candidate;
        } catch (e) {}
    }
    return null;
}

function getWorktreeDir(agente, repoRoot) {
    return path.join(path.dirname(repoRoot),
        path.basename(repoRoot) + ".agent-" + agente.issue + "-" + agente.slug);
}

function getAgentBranch(agente) {
    return "agent/" + agente.issue + "-" + agente.slug;
}

function readLogTail(logPath, lines) {
    lines = lines || 200;
    try {
        if (!fs.existsSync(logPath)) return "";
        const content = fs.readFileSync(logPath, "utf8");
        const allLines = content.split("\n");
        return allLines.slice(-lines).join("\n");
    } catch (e) { return ""; }
}

function getAgentLogPath(agente, repoRoot) {
    const logsDir = path.join(repoRoot, "scripts", "logs");
    if (agente.numero) {
        const byNum = path.join(logsDir, "agente_" + agente.numero + ".log");
        if (fs.existsSync(byNum)) return byNum;
    }
    const byIssue = path.join(logsDir, "agente_" + agente.issue + ".log");
    if (fs.existsSync(byIssue)) return byIssue;
    return null;
}

function getLocalCommitCount(worktreeDir) {
    try {
        if (!worktreeDir || !fs.existsSync(worktreeDir)) return 0;
        const out = execSync(
            "git log origin/main..HEAD --oneline 2>NUL",
            { cwd: worktreeDir, encoding: "utf8", timeout: 10000, windowsHide: true }
        );
        return out.trim().split("\n").filter(Boolean).length;
    } catch (e) { return 0; }
}

function hasRemoteBranch(branch, repoRoot) {
    try {
        const out = execSync(
            "git ls-remote --heads origin " + branch + " 2>NUL",
            { cwd: repoRoot, encoding: "utf8", timeout: 10000, windowsHide: true }
        );
        return out.trim().length > 0;
    } catch (e) { return false; }
}

function hasUnpushedCommits(worktreeDir, branch) {
    try {
        if (!worktreeDir || !fs.existsSync(worktreeDir)) return false;
        const out = execSync(
            "git log origin/" + branch + "..HEAD --oneline 2>NUL",
            { cwd: worktreeDir, encoding: "utf8", timeout: 10000, windowsHide: true }
        );
        return out.trim().length > 0;
    } catch (e) {
        return getLocalCommitCount(worktreeDir) > 0;
    }
}

function readPipelineResult(issue, repoRoot) {
    const filePath = path.join(repoRoot, "scripts", "logs", "agent-" + issue + "-pipeline-result.json");
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) { return null; }
}

function extractRateLimitResetTime(logContent) {
    const matches = logContent.match(/"resetsAt"\s*:\s*(\d+)/g);
    if (matches && matches.length > 0) {
        const last = matches[matches.length - 1];
        const ts = parseInt(last.match(/(\d+)/)[1], 10);
        const resetMs = ts < 1e12 ? ts * 1000 : ts;
        return resetMs;
    }
    return 0;
}

// --- Diagnostico principal ---

/**
 * Diagnostica la causa de muerte de un agente.
 * Lee logs, estado git, pipeline results para clasificar.
 *
 * @param {object} agentInfo  Objeto del agente del sprint-plan
 * @param {string} repoRoot   Path al repo principal
 * @param {string} hooksDir   Path a .claude/hooks/
 * @returns {{ cause: string, details: string, recommendation: string,
 *             localCommitCount: number, hasRemoteBranch: boolean,
 *             worktreeExists: boolean, cooldownMs: number,
 *             rateLimitResetMs: number, logSnippet: string }}
 */
function diagnoseDeadAgent(agentInfo, repoRoot, hooksDir) {
    const worktreeDir = getWorktreeDir(agentInfo, repoRoot);
    const branch      = getAgentBranch(agentInfo);
    const wtExists    = fs.existsSync(path.join(worktreeDir, ".git")) || fs.existsSync(worktreeDir);
    const logPath     = getAgentLogPath(agentInfo, repoRoot);
    const logTail     = logPath ? readLogTail(logPath, 300) : "";
    const pipeline    = readPipelineResult(agentInfo.issue, repoRoot);
    const commitCount = getLocalCommitCount(worktreeDir);
    const hasRemote   = hasRemoteBranch(branch, repoRoot);
    const unpushed    = hasUnpushedCommits(worktreeDir, branch);

    var cause = CAUSES.UNKNOWN;
    var details = "";
    var recommendation = "";
    var rateLimitResetMs = 0;

    // 1. Analizar log del agente para patrones conocidos
    if (logTail) {
        for (var i = 0; i < LOG_PATTERNS.length; i++) {
            var lp = LOG_PATTERNS[i];
            if (lp.pattern.test(logTail)) {
                cause = lp.cause;
                var match = logTail.match(lp.pattern);
                details = "Patron detectado en log: " + (match ? match[0] : lp.cause);
                break;
            }
        }

        // Si detectamos rate_limit, extraer tiempo de reset
        if (cause === CAUSES.RATE_LIMIT) {
            rateLimitResetMs = extractRateLimitResetTime(logTail);
        }

        // Verificar si /delivery fue invocado en el log
        var deliveryInvoked = /\/delivery|skill.*delivery|"name"\s*:\s*"delivery"/i.test(logTail);

        // Refinar causa con contexto adicional
        if (cause === CAUSES.UNKNOWN) {
            if (pipeline) {
                if (pipeline.deliveryOk === false) {
                    cause = CAUSES.DELIVERY_FAILED;
                    details = "Pipeline indica delivery fallido";
                } else if (pipeline.buildOk === false) {
                    cause = CAUSES.BUILD_FAILED;
                    details = "Pipeline indica build fallido" + (pipeline.buildError ? ": " + pipeline.buildError.substring(0, 200) : "");
                }
            } else if (commitCount > 0 && !hasRemote && !deliveryInvoked) {
                cause = CAUSES.NO_DELIVERY;
                details = commitCount + " commit(s) local(es), sin push, /delivery no invocado";
            } else if (commitCount > 0 && hasRemote && !deliveryInvoked) {
                cause = CAUSES.NO_DELIVERY;
                details = commitCount + " commit(s) pusheado(s) pero /delivery no invocado (sin PR)";
            } else if (deliveryInvoked && !hasRemote) {
                cause = CAUSES.DELIVERY_FAILED;
                details = "/delivery invocado pero no se creo rama remota";
            } else if (!wtExists && !logTail.trim()) {
                cause = CAUSES.CRASH;
                details = "Sin worktree ni log -- muerte abrupta";
            } else if (!wtExists) {
                cause = CAUSES.CRASH;
                details = "Worktree no existe, posible muerte durante arranque";
            }
        }
    } else {
        // Sin log disponible
        if (commitCount > 0) {
            cause = CAUSES.NO_DELIVERY;
            details = commitCount + " commit(s) encontrado(s) pero sin log para analizar";
        } else if (!wtExists) {
            cause = CAUSES.CRASH;
            details = "Sin worktree ni log -- muerte abrupta o nunca arranco";
        } else {
            cause = CAUSES.UNKNOWN;
            details = "Worktree existe pero sin log para diagnosticar";
        }
    }

    // 2. Generar recomendacion basada en causa
    switch (cause) {
        case CAUSES.NO_DELIVERY:
            if (commitCount > 0 && unpushed) {
                recommendation = "Intentar push + PR automatico desde worktree existente";
            } else if (commitCount > 0 && hasRemote) {
                recommendation = "Intentar crear PR con gh cli (codigo ya pusheado)";
            } else {
                recommendation = "Relanzar agente -- no produjo trabajo recuperable";
            }
            break;
        case CAUSES.DELIVERY_FAILED:
            if (unpushed) {
                recommendation = "Intentar push forzado y luego crear PR";
            } else if (hasRemote) {
                recommendation = "Intentar crear PR con gh cli";
            } else {
                recommendation = "Relanzar con contexto de error de delivery";
            }
            break;
        case CAUSES.RATE_LIMIT:
            if (rateLimitResetMs > Date.now()) {
                var waitMin = Math.ceil((rateLimitResetMs - Date.now()) / 60000);
                recommendation = "Esperar " + waitMin + " min hasta reset del rate limit";
            } else {
                recommendation = "Cooldown de 10 min y relanzar";
            }
            break;
        case CAUSES.TIMEOUT:
            recommendation = "Relanzar con prompt simplificado o dividir el issue";
            break;
        case CAUSES.EXIT_ERROR:
            recommendation = "Relanzar con verificacion de entorno (/ops) previa";
            break;
        case CAUSES.CRASH:
            recommendation = "Relanzar con worktree limpio y monitoreo reforzado";
            break;
        case CAUSES.BUILD_FAILED:
            recommendation = "Relanzar con contexto del error de build para correccion";
            break;
        default:
            recommendation = "Relanzar con diagnostico completo previo";
    }

    // Log snippet: ultimas 5 lineas relevantes (no JSON puro)
    var logLines = logTail.split("\n").filter(function(l) { return l.trim() && !l.startsWith("{"); });
    var logSnippet = logLines.slice(-5).join("\n");

    return {
        cause:              cause,
        details:            details,
        recommendation:     recommendation,
        localCommitCount:   commitCount,
        hasRemoteBranch:    hasRemote,
        hasUnpushedCommits: unpushed,
        worktreeExists:     wtExists,
        cooldownMs:         COOLDOWN_BY_CAUSE[cause] || COOLDOWN_BY_CAUSE[CAUSES.UNKNOWN],
        rateLimitResetMs:   rateLimitResetMs,
        logSnippet:         logSnippet,
        pipelineResult:     pipeline,
    };
}

// --- Acciones de recovery ---

/**
 * Intenta acciones correctivas segun el diagnostico.
 * Retorna { action, success, details } describiendo lo que hizo.
 *
 * @param {{ cause: string }} diagnosis  Resultado de diagnoseDeadAgent
 * @param {object} agentInfo             Objeto del agente
 * @param {string} repoRoot              Path al repo principal
 * @returns {{ action: string, success: boolean, details: string, shouldRelaunch: boolean, cooldownMs: number }}
 */
function attemptRecovery(diagnosis, agentInfo, repoRoot) {
    var worktreeDir = getWorktreeDir(agentInfo, repoRoot);
    var branch      = getAgentBranch(agentInfo);
    var result      = { action: "none", success: false, details: "", shouldRelaunch: true, cooldownMs: 0 };

    switch (diagnosis.cause) {
        case CAUSES.NO_DELIVERY:
        case CAUSES.DELIVERY_FAILED:
            return _recoverDelivery(diagnosis, agentInfo, repoRoot, worktreeDir, branch);

        case CAUSES.RATE_LIMIT:
            return _recoverRateLimit(diagnosis, agentInfo);

        case CAUSES.BUILD_FAILED:
            result.action = "relaunch_with_build_context";
            result.success = false;
            result.details = "Build fallo -- relanzar con contexto de error";
            result.shouldRelaunch = true;
            result.cooldownMs = COOLDOWN_BY_CAUSE[CAUSES.BUILD_FAILED];
            return result;

        case CAUSES.CRASH:
        case CAUSES.EXIT_ERROR:
            result.action = "relaunch_with_ops_check";
            result.success = false;
            result.details = "Error/crash -- relanzar con verificacion de entorno";
            result.shouldRelaunch = true;
            result.cooldownMs = COOLDOWN_BY_CAUSE[diagnosis.cause];
            return result;

        case CAUSES.TIMEOUT:
            result.action = "relaunch_simplified";
            result.success = false;
            result.details = "Timeout -- relanzar con prompt simplificado";
            result.shouldRelaunch = true;
            result.cooldownMs = COOLDOWN_BY_CAUSE[CAUSES.TIMEOUT];
            return result;

        default:
            result.action = "relaunch_default";
            result.success = false;
            result.details = "Causa desconocida -- relanzar con diagnostico previo";
            result.shouldRelaunch = true;
            result.cooldownMs = COOLDOWN_BY_CAUSE[CAUSES.UNKNOWN];
            return result;
    }
}

/**
 * Intenta recuperar delivery: push commits y/o crear PR.
 */
function _recoverDelivery(diagnosis, agentInfo, repoRoot, worktreeDir, branch) {
    var result = { action: "attempted_delivery", success: false, details: "", shouldRelaunch: false, cooldownMs: 0 };

    // Paso 1: push commits locales no pusheados
    if (diagnosis.hasUnpushedCommits && diagnosis.worktreeExists) {
        try {
            execSync("git push origin HEAD:" + branch + " 2>&1", {
                cwd: worktreeDir, encoding: "utf8", timeout: 30000, windowsHide: true
            });
            result.details += "Push exitoso. ";
        } catch (e) {
            // Intentar rebase y retry
            try {
                execSync("git fetch origin main --quiet && git rebase origin/main --quiet 2>&1", {
                    cwd: worktreeDir, encoding: "utf8", timeout: 30000, windowsHide: true
                });
                execSync("git push origin HEAD:" + branch + " --force-with-lease 2>&1", {
                    cwd: worktreeDir, encoding: "utf8", timeout: 30000, windowsHide: true
                });
                result.details += "Push exitoso tras rebase. ";
            } catch (e2) {
                result.details += "Push fallo: " + e2.message.substring(0, 200) + ". ";
                result.shouldRelaunch = true;
                result.cooldownMs = COOLDOWN_BY_CAUSE[CAUSES.DELIVERY_FAILED];
                return result;
            }
        }
    }

    // Paso 2: crear PR si no existe
    if (diagnosis.hasRemoteBranch || result.details.indexOf("Push exitoso") >= 0) {
        var ghCmd = findGhCli();
        if (ghCmd) {
            try {
                // Verificar si ya hay PR abierta para esta rama
                var existingPR = execSync(
                    '"' + ghCmd + '" pr list --head ' + branch + ' --repo intrale/platform --json number --jq ".[0].number"',
                    { encoding: "utf8", timeout: 15000, windowsHide: true }
                ).trim();

                if (existingPR) {
                    result.details += "PR #" + existingPR + " ya existe. ";
                    result.success = true;
                    result.shouldRelaunch = false;
                } else {
                    // Crear PR
                    var prTitle = "feat: " + (agentInfo.slug || "agent-" + agentInfo.issue).replace(/-/g, " ") + " (#" + agentInfo.issue + ")";
                    var prBody = "## Recovery automatico\n\nPR creada automaticamente por agent-doctor tras muerte del agente.\n\nCloses #" + agentInfo.issue;
                    var prOutput = execSync(
                        '"' + ghCmd + '" pr create --repo intrale/platform --base main --head ' + branch +
                        ' --title "' + prTitle.replace(/"/g, '\\"') + '"' +
                        ' --body "' + prBody.replace(/"/g, '\\"') + '"' +
                        ' --assignee leitolarreta 2>&1',
                        { encoding: "utf8", timeout: 30000, windowsHide: true }
                    ).trim();
                    result.details += "PR creada: " + prOutput + ". ";
                    result.success = true;
                    result.shouldRelaunch = false;
                }
            } catch (e) {
                result.details += "Error creando PR: " + e.message.substring(0, 200) + ". ";
                result.shouldRelaunch = true;
                result.cooldownMs = COOLDOWN_BY_CAUSE[CAUSES.DELIVERY_FAILED];
            }
        } else {
            result.details += "gh CLI no disponible para crear PR. ";
            result.shouldRelaunch = true;
        }
    } else if (diagnosis.localCommitCount === 0) {
        result.action = "no_work_produced";
        result.details = "Agente no produjo commits -- nada que recuperar. ";
        result.shouldRelaunch = true;
        result.cooldownMs = COOLDOWN_BY_CAUSE[CAUSES.NO_DELIVERY];
    }

    return result;
}

/**
 * Maneja rate limit: calcula cooldown real desde el log.
 */
function _recoverRateLimit(diagnosis) {
    var result = { action: "rate_limit_cooldown", success: false, details: "", shouldRelaunch: true, cooldownMs: 0 };

    if (diagnosis.rateLimitResetMs > Date.now()) {
        result.cooldownMs = diagnosis.rateLimitResetMs - Date.now();
        var waitMin = Math.ceil(result.cooldownMs / 60000);
        result.details = "Rate limit activo -- cooldown " + waitMin + " min (reset: " + new Date(diagnosis.rateLimitResetMs).toISOString() + ")";
    } else {
        result.cooldownMs = COOLDOWN_BY_CAUSE[CAUSES.RATE_LIMIT];
        result.details = "Rate limit detectado -- cooldown default " + Math.round(result.cooldownMs / 60000) + " min";
    }

    return result;
}

// --- Logging de recovery ---

/**
 * Registra un diagnostico y recovery en el log append-only.
 *
 * @param {object} agentInfo  Objeto del agente
 * @param {{ cause, details }} diagnosis
 * @param {{ action, success, details, shouldRelaunch }} recovery
 * @param {string} repoRoot
 */
function logRecovery(agentInfo, diagnosis, recovery, repoRoot) {
    var logPath = path.join(repoRoot, "scripts", "logs", "agent-recovery.jsonl");
    var entry = {
        ts:              new Date().toISOString(),
        issue:           agentInfo.issue,
        slug:            agentInfo.slug || "",
        numero:          agentInfo.numero || null,
        retry:           agentInfo._retry_count || 0,
        cause:           diagnosis.cause,
        details:         diagnosis.details,
        recommendation:  diagnosis.recommendation,
        localCommits:    diagnosis.localCommitCount,
        hasRemoteBranch: diagnosis.hasRemoteBranch,
        worktreeExists:  diagnosis.worktreeExists,
        action:          recovery.action,
        result:          recovery.success ? "success" : "failed",
        actionDetails:   recovery.details,
        relaunched:      recovery.shouldRelaunch,
        cooldownMs:      recovery.cooldownMs,
        logSnippet:      (diagnosis.logSnippet || "").substring(0, 500),
    };

    try {
        fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf8");
    } catch (e) {
        // Intentar crear el directorio
        try {
            var dir = path.dirname(logPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf8");
        } catch (e2) {}
    }

    return entry;
}

// --- Integracion: funcion principal para watcher/monitor ---

/**
 * Funcion principal de integracion.
 * Diagnostica, intenta recovery, logea, y retorna si se debe relanzar.
 *
 * @param {object} agentInfo  Objeto del agente muerto
 * @param {string} repoRoot   Path al repo principal
 * @param {string} hooksDir   Path a .claude/hooks/
 * @returns {{ diagnosis: object, recovery: object, logEntry: object,
 *             shouldRelaunch: boolean, cooldownMs: number }}
 */
function handleDeadAgent(agentInfo, repoRoot, hooksDir) {
    // 1. Diagnosticar
    var diagnosis = diagnoseDeadAgent(agentInfo, repoRoot, hooksDir);

    // 2. Intentar recovery
    var recovery = attemptRecovery(diagnosis, agentInfo, repoRoot);

    // 3. Registrar en log
    var logEntry = logRecovery(agentInfo, diagnosis, recovery, repoRoot);

    return {
        diagnosis:     diagnosis,
        recovery:      recovery,
        logEntry:      logEntry,
        shouldRelaunch: recovery.shouldRelaunch,
        cooldownMs:     recovery.cooldownMs,
    };
}

/**
 * Construye un prompt enriquecido para reintentos basado en el diagnostico del doctor.
 * Complementa a buildRetryPrompt de agent-retry-diagnostics.
 *
 * @param {string} originalPrompt
 * @param {object} agentInfo
 * @param {{ cause, details, recommendation }} diagnosis
 * @returns {string}
 */
function buildDoctorRetryPrompt(originalPrompt, agentInfo, diagnosis) {
    var branch     = getAgentBranch(agentInfo);
    var retryCount = agentInfo._retry_count || 0;
    var retryLabel = "RECOVERY " + retryCount + "/3";
    var context = "";

    switch (diagnosis.cause) {
        case CAUSES.RATE_LIMIT:
            context = "[" + retryLabel + "] El intento anterior fue interrumpido por rate limit. " +
                "No hay problema con el codigo ni el entorno. Continuar desde donde se quedo. " +
                "Verificar rama " + branch + " para no perder trabajo previo.";
            break;
        case CAUSES.TIMEOUT:
            context = "[" + retryLabel + "] El intento anterior excedio el tiempo maximo. " +
                "Simplificar la implementacion: priorizar la funcionalidad core. " +
                "Verificar rama " + branch + " para continuar trabajo existente.";
            break;
        case CAUSES.EXIT_ERROR:
            context = "[" + retryLabel + "] Claude salio con error en el intento anterior. " +
                "Ejecutar /ops al inicio para verificar que el entorno funciona. " +
                "Verificar rama " + branch + " para continuar trabajo existente.";
            break;
        case CAUSES.CRASH:
            context = "[" + retryLabel + "] El agente murio abruptamente sin log. " +
                "Posible problema de memoria o proceso. Verificar entorno con /ops antes de empezar. " +
                "Verificar rama " + branch + " por si hay trabajo recuperable.";
            break;
        case CAUSES.NO_DELIVERY:
            if (diagnosis.localCommitCount > 0) {
                context = "[" + retryLabel + "] El agente produjo " + diagnosis.localCommitCount +
                    " commit(s) pero no invoco /delivery. " +
                    "IMPORTANTE: NO reimplementar. La rama " + branch + " tiene el trabajo. " +
                    "Solo ejecutar /delivery para completar.";
            } else {
                context = "[" + retryLabel + "] El agente no produjo commits ni invoco /delivery. " +
                    "Ir directamente a la implementacion sin exploracion extensa.";
            }
            break;
        case CAUSES.DELIVERY_FAILED:
            context = "[" + retryLabel + "] /delivery fue invocado pero fallo. " +
                "Detalles: " + (diagnosis.details || "desconocido") + ". " +
                "IMPORTANTE: NO reimplementar. Rama: " + branch + ". Solo corregir delivery.";
            break;
        case CAUSES.BUILD_FAILED:
            context = "[" + retryLabel + "] Build fallo en intento anterior. " +
                "Rama: " + branch + ". Corregir errores de build, NO reimplementar. " +
                (diagnosis.pipelineResult && diagnosis.pipelineResult.buildError
                    ? "Error: " + diagnosis.pipelineResult.buildError.substring(0, 300)
                    : "");
            break;
        default:
            context = "[" + retryLabel + "] Reintento automatico por el Doctor. " +
                "Causa: " + diagnosis.cause + ". " +
                "Verificar rama " + branch + " antes de implementar.";
    }

    return context + "\n" + originalPrompt;
}

/**
 * Construye resumen HTML para notificacion Telegram del diagnostico.
 */
function buildDiagnosisNotification(agentInfo, diagnosis, recovery) {
    var CAUSE_LABELS = {};
    CAUSE_LABELS[CAUSES.NO_DELIVERY]     = "No invoco /delivery";
    CAUSE_LABELS[CAUSES.DELIVERY_FAILED] = "Delivery fallo";
    CAUSE_LABELS[CAUSES.EXIT_ERROR]      = "Salio con error";
    CAUSE_LABELS[CAUSES.RATE_LIMIT]      = "Rate limit";
    CAUSE_LABELS[CAUSES.TIMEOUT]         = "Timeout";
    CAUSE_LABELS[CAUSES.CRASH]           = "Crash/muerte abrupta";
    CAUSE_LABELS[CAUSES.BUILD_FAILED]    = "Build fallo";
    CAUSE_LABELS[CAUSES.UNKNOWN]         = "Causa desconocida";

    var causeLabel = CAUSE_LABELS[diagnosis.cause] || diagnosis.cause;
    var actionResult = recovery.success ? "Recovery exitoso" : "Recovery pendiente -- relanzando";

    var lines = [
        "\uD83C\uDFE5 <b>Doctor: Agente #" + agentInfo.issue + "</b>",
        "Causa: <code>" + causeLabel + "</code>",
        "Commits: " + diagnosis.localCommitCount + " local" + (diagnosis.hasRemoteBranch ? " + remoto" : ""),
        "Accion: " + recovery.action,
        "Resultado: " + actionResult,
    ];

    if (recovery.cooldownMs > 0) {
        lines.push("Cooldown: " + Math.round(recovery.cooldownMs / 60000) + " min");
    }
    if (recovery.details) {
        lines.push("<i>" + recovery.details.substring(0, 200) + "</i>");
    }

    return lines.join("\n");
}

// --- Exports ---

module.exports = {
    CAUSES:                     CAUSES,
    COOLDOWN_BY_CAUSE:          COOLDOWN_BY_CAUSE,
    diagnoseDeadAgent:          diagnoseDeadAgent,
    attemptRecovery:            attemptRecovery,
    logRecovery:                logRecovery,
    handleDeadAgent:            handleDeadAgent,
    buildDoctorRetryPrompt:     buildDoctorRetryPrompt,
    buildDiagnosisNotification: buildDiagnosisNotification,
};
