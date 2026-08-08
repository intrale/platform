// Test P-33: sprint-sync.js — Reconciliación sprint-plan.json ↔ GitHub (#1432)
// Verifica que sprint-sync.js:
// - Exporta runSync() y syncRoadmapOnly() como módulo
// - Implementa throttle de 2 minutos
// - Detecta PR mergeada y mueve agente a _completed[] con resultado "ok"
// - Detecta PR cerrada sin merge y mueve agente a _completed[] con resultado "failed"
// - Detecta sesión terminada sin PR (worktree inexistente) y genera alerta
// - Verifica issues cerrados en _queue[] y los mueve a _completed[]
// - Es invocable como script standalone (require.main === module)
// - Registrado como PostToolUse en settings.json
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SPRINT_SYNC_FILE = path.join(__dirname, "..", "sprint-sync.js");
const SETTINGS_FILE = path.join(__dirname, "..", "..", "settings.json");

const src = fs.readFileSync(SPRINT_SYNC_FILE, "utf8");
const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));

describe("P-33: sprint-sync.js — Reconciliación sprint-plan ↔ GitHub (#1432)", () => {

    describe("Exports y estructura del módulo", () => {
        it("exporta runSync como función", () => {
            assert.ok(src.includes("module.exports"), "Debe exportar módulo");
            assert.ok(src.includes("runSync"), "Debe exportar runSync");
        });
        it("exporta syncRoadmapOnly como función", () => {
            assert.ok(src.includes("syncRoadmapOnly"), "Debe exportar syncRoadmapOnly");
        });
        it("es invocable como script standalone (require.main === module)", () => {
            assert.ok(src.includes("require.main === module"), "Debe soportar ejecución directa con node sprint-sync.js");
        });
    });

    describe("Throttle de 2 minutos", () => {
        it("define SYNC_INTERVAL_MS de 2 minutos", () => {
            assert.ok(src.includes("SYNC_INTERVAL_MS"), "Debe definir SYNC_INTERVAL_MS");
            assert.ok(
                src.includes("2 * 60 * 1000") || src.includes("120000"),
                "SYNC_INTERVAL_MS debe ser 2 minutos (120000ms)"
            );
        });
        it("implementa función shouldRun que respeta el throttle", () => {
            assert.ok(src.includes("function shouldRun"), "Debe implementar shouldRun()");
            assert.ok(src.includes("SYNC_INTERVAL_MS"), "shouldRun debe usar SYNC_INTERVAL_MS");
        });
        it("soporta flag --force para saltear el throttle", () => {
            assert.ok(src.includes("force"), "Debe soportar flag force para saltear throttle");
        });
    });

    describe("reconcileSprintPlan — PR mergeada", () => {
        it("implementa función reconcileSprintPlan", () => {
            assert.ok(src.includes("function reconcileSprintPlan"), "Debe implementar reconcileSprintPlan()");
        });
        it("itera sobre TODOS los agentes[] (no solo done/waiting)", () => {
            // Verifica que el filtro .filter(a => a.status === "done"...) no existe en reconcileSprintPlan
            // La función debe iterar sobre todos los agentes, no solo los completados
            const fnStart = src.indexOf("function reconcileSprintPlan");
            const fnEnd = src.indexOf("\nfunction ", fnStart + 1);
            const fnBody = src.substring(fnStart, fnEnd > 0 ? fnEnd : fnStart + 3000);
            // La función debe usar spread o slice, no filtrar por status
            assert.ok(
                fnBody.includes("[...plan.agentes]") || fnBody.includes("plan.agentes : []"),
                "reconcileSprintPlan debe iterar sobre todos los agentes"
            );
        });
        it("mueve agentes con PR mergeada a _completed[] con resultado 'ok'", () => {
            assert.ok(src.includes('"merged"'), "Debe detectar PR mergeada");
            assert.ok(src.includes('resultado: "ok"'), "Debe marcar resultado como 'ok' al mergearse");
            assert.ok(
                src.includes("_completed[] (PR mergeada)") || src.includes("a _completed[] (PR mergeada)"),
                "Debe loguear el movimiento de agente a _completed[] al mergearse"
            );
        });
        it("registra el número del PR mergeado en _completed[]", () => {
            assert.ok(src.includes("getMergedPRNumber"), "Debe obtener el número del PR mergeado");
            assert.ok(src.includes("pr: prNum"), "Debe guardar el número del PR en _completed[]");
        });
    });

    describe("reconcileSprintPlan — PR cerrada sin merge", () => {
        it("detecta el estado 'closed_no_merge' del PR", () => {
            assert.ok(src.includes('"closed_no_merge"'), "Debe detectar PR cerrada sin merge");
        });
        it("mueve agentes con PR cerrada sin merge a _completed[] con resultado 'failed'", () => {
            assert.ok(src.includes('resultado: "failed"'), "Debe marcar resultado como 'failed' cuando PR cierra sin merge");
        });
        it("remueve al agente de agentes[] cuando PR cierra sin merge", () => {
            // Buscar el bloque de reconcileSprintPlan donde se maneja closed_no_merge
            const reconcileIdx = src.indexOf("function reconcileSprintPlan");
            assert.ok(reconcileIdx !== -1, "Debe existir reconcileSprintPlan");
            // Buscar el caso closed_no_merge DENTRO de reconcileSprintPlan (no en checkPRStatus)
            const closedIdx = src.indexOf('"closed_no_merge"', reconcileIdx);
            assert.ok(closedIdx !== -1, "Debe manejar el caso closed_no_merge en reconcileSprintPlan");
            const closedBlock = src.substring(closedIdx, closedIdx + 500);
            assert.ok(
                closedBlock.includes("plan.agentes.filter"),
                "Debe remover el agente de agentes[] cuando PR cierra sin merge"
            );
        });
        it("genera cambio de tipo 'sprint-plan:' para PR cerrada sin merge", () => {
            assert.ok(
                src.includes("PR cerrada sin merge"),
                "Debe registrar el cambio indicando que la PR fue cerrada sin merge"
            );
        });
    });

    describe("reconcileSprintPlan — Sesión terminada sin PR", () => {
        it("define función getWorktreePath para calcular el path del worktree", () => {
            assert.ok(src.includes("function getWorktreePath"), "Debe definir getWorktreePath()");
        });
        it("define función worktreeExists para verificar si el worktree existe", () => {
            assert.ok(src.includes("function worktreeExists"), "Debe definir worktreeExists()");
        });
        it("define WORKTREES_PARENT para calcular paths de worktrees", () => {
            assert.ok(src.includes("WORKTREES_PARENT"), "Debe definir WORKTREES_PARENT");
        });
        it("detecta sesión terminada cuando prStatus es 'none' y worktree no existe", () => {
            assert.ok(src.includes('prStatus === "none"') || src.includes("prStatus === 'none'"), "Debe verificar caso prStatus none");
            assert.ok(src.includes("worktreeExists"), "Debe verificar si el worktree existe");
        });
        it("genera alerta cuando sesión termina sin PR", () => {
            assert.ok(
                src.includes("sesión terminada sin PR"),
                "Debe generar alerta de tipo 'alerta:' cuando sesión termina sin PR"
            );
        });
    });

    describe("reconcileSprintPlan — _queue[] con issues cerrados", () => {
        it("verifica issues en _queue[] contra GitHub", () => {
            assert.ok(src.includes("checkIssueClosed"), "Debe verificar si issues en _queue[] están cerrados");
        });
        it("mueve issues cerrados de _queue[] a _completed[]", () => {
            assert.ok(
                src.includes("issue cerrado en GitHub") || src.includes("_queue[] a _completed[]"),
                "Debe mover issues cerrados de _queue[] a _completed[]"
            );
        });
    });

    describe("Idempotencia", () => {
        it("implementa lock para evitar ejecuciones concurrentes", () => {
            assert.ok(src.includes("function acquireLock"), "Debe implementar acquireLock()");
            assert.ok(src.includes("function releaseLock"), "Debe implementar releaseLock()");
            assert.ok(src.includes("LOCK_FILE"), "Debe usar un lock file");
        });
        it("actualiza estado con timestamp después de cada ejecución", () => {
            assert.ok(src.includes("function updateState"), "Debe implementar updateState()");
            assert.ok(src.includes("lastRun"), "Debe persistir timestamp de última ejecución");
        });
    });

    describe("Notificaciones Telegram", () => {
        it("implementa sendTelegram para notificar cambios", () => {
            assert.ok(src.includes("function sendTelegram"), "Debe implementar sendTelegram()");
        });
        it("notifica cuando hay cambios reales en sprint-plan", () => {
            assert.ok(src.includes("Sprint Sync"), "Debe notificar via Telegram cuando hay cambios");
        });
        it("notifica alertas por desincronización", () => {
            assert.ok(
                src.includes("Sprint Sync — Alerta") || src.includes("Alerta"),
                "Debe notificar alertas de desincronización"
            );
        });
    });

    describe("Hook PostToolUse — Registro en settings.json", () => {
        it("sprint-sync.js está registrado en PostToolUse de settings.json", () => {
            const postToolUse = settings.hooks && settings.hooks.PostToolUse;
            assert.ok(Array.isArray(postToolUse), "settings.json debe tener PostToolUse");
            const allHooks = postToolUse.flatMap(m => m.hooks || []);
            const registered = allHooks.some(h => (h.command || "").includes("sprint-sync.js"));
            assert.ok(registered, "sprint-sync.js debe estar registrado en PostToolUse de settings.json");
        });
        it("el timeout del hook es suficiente para llamadas a GitHub API", () => {
            const postToolUse = settings.hooks && settings.hooks.PostToolUse;
            const allHooks = (postToolUse || []).flatMap(m => m.hooks || []);
            const sprintSyncHook = allHooks.find(h => (h.command || "").includes("sprint-sync.js"));
            assert.ok(sprintSyncHook, "sprint-sync.js debe estar registrado");
            assert.ok(
                sprintSyncHook.timeout >= 15000,
                "El timeout debe ser >= 15s para permitir llamadas a GitHub API (actual: " + sprintSyncHook.timeout + ")"
            );
        });
    });

    describe("Ejecución como hook (stdin mode)", () => {
        it("lee stdin cuando se ejecuta como hook (no como CLI)", () => {
            assert.ok(src.includes("process.stdin"), "Debe leer stdin cuando se ejecuta como hook");
        });
        it("tiene timeout de seguridad para stdin", () => {
            assert.ok(src.includes("setTimeout"), "Debe tener timeout de seguridad para stdin");
        });
    });

});
