// agent-retry-diagnostics.js (#1749)
// Diagnostico automatico de causa de muerte de agentes.
//
// Causas detectadas:
//   zero_tool_calls   agente arranco pero no hizo ningun tool call
//   explored_no_code  mas de 5 tool calls pero 0 commits
//   build_failed      Claude termino OK pero build-check fallo
//   delivery_failed   build OK pero push/PR fallo
//   short_session     sesion corta sin commits
//   unknown           sin datos suficientes
"use strict";

const fs   = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const CAUSES = {
    ZERO_TOOL_CALLS:  "zero_tool_calls",
    EXPLORED_NO_CODE: "explored_no_code",
    BUILD_FAILED:     "build_failed",
    DELIVERY_FAILED:  "delivery_failed",
    SHORT_SESSION:    "short_session",
    UNKNOWN:          "unknown",
};

function readPipelineResult(issue, logsDir) {
    const filePath = path.join(logsDir, "agent-" + issue + "-pipeline-result.json");
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) { return null; }
}

function getLocalCommitCount(agente, worktreeDir) {
    try {
        if (worktreeDir && fs.existsSync(worktreeDir)) {
            const out = execSync(
                "git log origin/main..HEAD --oneline 2>NUL",
                { cwd: worktreeDir, encoding: "utf8", timeout: 10000, windowsHide: true }
            );
            return out.trim().split("\n").filter(Boolean).length;
        }
    } catch (e) {}
    return 0;
}

function hasRemoteBranch(agente, repoRoot) {
    const branch = "agent/" + agente.issue + "-" + agente.slug;
    try {
        const out = execSync(
            "git ls-remote --heads origin " + branch + " 2>NUL",
            { cwd: repoRoot, encoding: "utf8", timeout: 10000, windowsHide: true }
        );
        return out.trim().length > 0;
    } catch (e) { return false; }
}

function getWorktreeDir(agente, repoRoot) {
    return path.join(path.dirname(repoRoot),
        path.basename(repoRoot) + ".agent-" + agente.issue + "-" + agente.slug);
}

/**
 * Analiza la causa de muerte de un agente.
 * @param {object} agente    Objeto del agente del sprint-plan
 * @param {string} repoRoot  Path al repo principal
 * @param {string} hooksDir  Path a .claude/hooks/
 * @returns {object} diagnosis
 */
function analyzeDeath(agente, repoRoot, hooksDir) {
    const logsDir     = path.join(repoRoot, "scripts", "logs");
    const worktreeDir = getWorktreeDir(agente, repoRoot);
    const wtExists    = fs.existsSync(path.join(worktreeDir, ".git"));

    const pipelineResult   = readPipelineResult(agente.issue, logsDir);
    const localCommitCount = getLocalCommitCount(agente, worktreeDir);
    const hasLocal         = localCommitCount > 0;
    const hasRemote        = hasRemoteBranch(agente, repoRoot);

    const toolCallCount  = pipelineResult ? (pipelineResult.toolCalls || 0) : (agente._last_tool_calls || 0);
    const buildFailed    = pipelineResult ? (pipelineResult.buildOk === false) : false;
    const deliveryFailed = pipelineResult ? (pipelineResult.deliveryOk === false) : false;
    const buildError     = buildFailed ? (pipelineResult.buildError || "") : null;

    let cause = CAUSES.UNKNOWN;
    if (pipelineResult) {
        if (deliveryFailed && !buildFailed && (hasLocal || hasRemote)) {
            cause = CAUSES.DELIVERY_FAILED;
        } else if (buildFailed) {
            cause = CAUSES.BUILD_FAILED;
        } else if (toolCallCount === 0) {
            cause = CAUSES.ZERO_TOOL_CALLS;
        } else if (toolCallCount > 5 && !hasLocal) {
            cause = CAUSES.EXPLORED_NO_CODE;
        } else if (!hasLocal) {
            cause = CAUSES.SHORT_SESSION;
        } else {
            cause = CAUSES.DELIVERY_FAILED;
        }
    } else {
        if (hasLocal || hasRemote) {
            cause = CAUSES.DELIVERY_FAILED;
        } else if (wtExists && toolCallCount > 5) {
            cause = CAUSES.EXPLORED_NO_CODE;
        } else if (wtExists) {
            cause = CAUSES.SHORT_SESSION;
        } else {
            cause = CAUSES.ZERO_TOOL_CALLS;
        }
    }

    return {
        cause,
        hasLocalCommits:   hasLocal,
        localCommitCount,
        hasRemoteBranch:   hasRemote,
        buildError,
        toolCallCount,
        deliveryFailed,
        buildFailed,
        pipelineResult,
        worktreeExists:    wtExists,
    };
}

/**
 * Construye el prompt enriquecido para el reintento.
 * @param {string} originalPrompt Prompt base
 * @param {object} agente         Objeto del agente
 * @param {object} diagnosis      Resultado de analyzeDeath()
 * @returns {string} Prompt enriquecido
 */
function buildRetryPrompt(originalPrompt, agente, diagnosis) {
    const branch     = "agent/" + agente.issue + "-" + agente.slug;
    const retryCount = agente._retry_count || 0;
    const retryLabel = "REINTENTO " + retryCount + "/3";
    let context = "";

    switch (diagnosis.cause) {
        case CAUSES.ZERO_TOOL_CALLS:
            context = "[" + retryLabel + "] El intento anterior fallo sin ejecutar ningun tool call. " +
                "Problema de arranque o entorno. Verificar con /ops antes de comenzar la implementacion.";
            break;
        case CAUSES.EXPLORED_NO_CODE:
            context = "[" + retryLabel + "] El intento anterior exploro el codebase (" +
                diagnosis.toolCallCount + " tool calls) pero no produjo codigo ni commits. " +
                "Ir directamente a implementar los cambios del issue sin exploracion extensa.";
            break;
        case CAUSES.BUILD_FAILED:
            context = "[" + retryLabel + "] El intento anterior implemento el codigo pero fallo el build. " +
                "La rama " + branch + " tiene los cambios. " +
                "IMPORTANTE: NO reimplementar desde cero. Continuar desde la rama existente y corregir solo el build." +
                (diagnosis.buildError ? "\nError de build:\n" + diagnosis.buildError.substring(0, 400) : "");
            break;
        case CAUSES.DELIVERY_FAILED:
            if (diagnosis.hasLocalCommits) {
                context = "[" + retryLabel + "] El codigo esta implementado en la rama " + branch + " (" +
                    diagnosis.localCommitCount + " commit(s)). " +
                    "El intento anterior fallo en delivery (push/PR). " +
                    "IMPORTANTE: NO reimplementar. Solo hacer /delivery desde la rama existente.";
            } else if (diagnosis.hasRemoteBranch) {
                context = "[" + retryLabel + "] El codigo fue pusheado a origin/" + branch + " pero falta la PR. " +
                    "IMPORTANTE: NO reimplementar. Solo crear la PR con /delivery.";
            } else {
                context = "[" + retryLabel + "] El intento anterior completo la implementacion pero fallo el delivery. " +
                    "Verificar el estado de la rama " + branch + " y completar el delivery.";
            }
            break;
        case CAUSES.SHORT_SESSION:
            context = "[" + retryLabel + "] El intento anterior duro muy poco sin producir resultados. " +
                "Posible problema de arranque. Verificar entorno con /ops e implementar directamente.";
            break;
        default:
            context = "[" + retryLabel + "] Reintento automatico, causa no determinada. " +
                "Verificar estado de la rama " + branch + " antes de implementar.";
    }
    return context + "\n" + originalPrompt;
}

/**
 * Determina si el worktree debe reutilizarse (hay commits que no deben perderse).
 */
function shouldReuseWorktree(diagnosis) {
    return diagnosis.hasLocalCommits && diagnosis.localCommitCount > 0;
}

/**
 * Construye el objeto de diagnostico para persistir en plan._retry_diagnostics.
 */
function buildDiagnosticsEntry(agente, diagnosis) {
    return {
        retry:            agente._retry_count || 0,
        timestamp:        new Date().toISOString(),
        cause:            diagnosis.cause,
        hasLocalCommits:  diagnosis.hasLocalCommits,
        localCommitCount: diagnosis.localCommitCount,
        hasRemoteBranch:  diagnosis.hasRemoteBranch,
        buildError:       diagnosis.buildError,
        toolCallCount:    diagnosis.toolCallCount,
        deliveryFailed:   diagnosis.deliveryFailed,
        buildFailed:      diagnosis.buildFailed,
        worktreeExists:   diagnosis.worktreeExists,
    };
}

/**
 * Construye resumen en HTML para notificacion Telegram cuando se agotan reintentos.
 */
function buildExhaustedSummary(agente, diagnosticsHistory) {
    const branch = "agent/" + agente.issue + "-" + agente.slug;
    const CAUSE_LABELS = {
        [CAUSES.ZERO_TOOL_CALLS]:  "Sin tool calls (problema de entorno)",
        [CAUSES.EXPLORED_NO_CODE]: "Exploro sin producir codigo",
        [CAUSES.BUILD_FAILED]:     "Build fallo",
        [CAUSES.DELIVERY_FAILED]:  "Delivery/push fallo",
        [CAUSES.SHORT_SESSION]:    "Sesion demasiado corta",
        [CAUSES.UNKNOWN]:          "Causa desconocida",
    };
    const lines = [
        "🚫 <b>Agente #" + agente.issue + " agoto reintentos</b>",
        "Slug: " + branch, "",
        "<b>Historial de causas:</b>",
    ];
    for (const entry of (diagnosticsHistory || [])) {
        const label = CAUSE_LABELS[entry.cause] || entry.cause;
        lines.push("  Intento " + entry.retry + ": " + label +
            (entry.buildError ? " -- " + entry.buildError.substring(0, 100) : ""));
    }
    lines.push("", "<i>Accion: revisar issue manualmente y relanzar si es necesario</i>");
    return lines.join("\n");
}

module.exports = {
    CAUSES,
    analyzeDeath,
    buildRetryPrompt,
    shouldReuseWorktree,
    buildDiagnosticsEntry,
    buildExhaustedSummary,
};
