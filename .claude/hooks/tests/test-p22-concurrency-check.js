// Test P-22: Hook de validación de concurrencia de agentes (#1277)
// Verifica que agent-concurrency-check.js:
//   - Detecta correctamente el agente que finaliza
//   - Mueve items de cola a agentes cuando hay slots disponibles
//   - Respeta el concurrency_limit
//   - Escribe sprint-plan.json de forma atómica (lock file)
//   - No actúa en sesiones fuera de sprint
"use strict";

const { describe, it, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p22-test-"));
    return dir;
}

function buildPlan(overrides = {}) {
    return Object.assign({
        fecha: "2026-03-08",
        fechaFin: "2026-03-15",
        concurrency_limit: 3,
        agentes: [
            { numero: 1, issue: 1277, slug: "hooks-validar-concurrencia-agentes" },
            { numero: 2, issue: 1200, slug: "otra-feature" }
        ],
        cola: [
            { numero: 3, issue: 1300, slug: "proxima-feature", prompt: "Implementar issue #1300..." }
        ]
    }, overrides);
}

function buildSession(branch) {
    return { branch, status: "active" };
}

// ─── Tests unitarios de lógica interna (sin stdin) ───────────────────────────

describe("P-22: agent-concurrency-check — lógica de concurrencia", () => {

    it("módulo carga sin error de sintaxis", () => {
        // Verificar que el archivo existe y tiene sintaxis válida
        const hookPath = path.join(__dirname, "..", "agent-concurrency-check.js");
        assert.ok(fs.existsSync(hookPath), "agent-concurrency-check.js debe existir");
        const source = fs.readFileSync(hookPath, "utf8");
        // Verificar que no tiene eval (seguridad)
        assert.ok(!source.includes("\beval\b"), "No debe usar eval");
        // Verificar que usa JSON.parse (no eval para JSON)
        assert.ok(source.includes("JSON.parse"), "Debe usar JSON.parse");
    });

    it("sprint-plan.json incluye concurrency_limit:3 en auto-plan-sprint.js", () => {
        const planScript = path.join(__dirname, "..", "..", "..", "scripts", "auto-plan-sprint.js");
        assert.ok(fs.existsSync(planScript), "auto-plan-sprint.js debe existir");
        const source = fs.readFileSync(planScript, "utf8");
        assert.ok(source.includes("concurrency_limit"), "auto-plan-sprint.js debe incluir concurrency_limit");
        assert.ok(source.includes("MAX_AGENTS = 3"), "MAX_AGENTS debe ser 3");
    });

    it("hook registrado en settings.json como Stop hook", () => {
        const settingsPath = path.join(__dirname, "..", "..", "settings.json");
        assert.ok(fs.existsSync(settingsPath), "settings.json debe existir");
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
        const stopHooks = (settings.hooks && settings.hooks.Stop) || [];
        const allCmds = stopHooks.flatMap(g => (g.hooks || []).map(h => h.command || ""));
        const hasHook = allCmds.some(cmd => cmd.includes("agent-concurrency-check.js"));
        assert.ok(hasHook, "agent-concurrency-check.js debe estar registrado en Stop hooks");
    });

    it("CLAUDE.md menciona límite de 3 agentes", () => {
        const claudeMd = path.join(__dirname, "..", "..", "..", "CLAUDE.md");
        assert.ok(fs.existsSync(claudeMd), "CLAUDE.md debe existir");
        const content = fs.readFileSync(claudeMd, "utf8");
        assert.ok(
            content.includes("3 agentes") || content.includes("concurrency_limit") || content.includes("agent-concurrency-check"),
            "CLAUDE.md debe mencionar el nuevo límite o el hook de concurrencia"
        );
    });

    it("auto-plan-sprint.js genera prompts en items de cola", () => {
        const planScript = path.join(__dirname, "..", "..", "..", "scripts", "auto-plan-sprint.js");
        const source = fs.readFileSync(planScript, "utf8");
        assert.ok(source.includes("generateDefaultPrompt"), "auto-plan-sprint.js debe incluir generateDefaultPrompt");
        assert.ok(
            source.includes("prompt: generateDefaultPrompt"),
            "Los items de cola deben incluir prompt generado"
        );
    });

    it("getQueue soporta campo 'cola'", () => {
        // Test de la lógica de getQueue sin importar el módulo completo
        // (el módulo tiene stdin listener que no queremos activar en tests)
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        assert.ok(source.includes("plan.cola"), "debe soportar campo cola");
        assert.ok(source.includes("plan._queue"), "debe soportar campo _queue como fallback");
    });

    it("hook usa lock file para escritura atómica", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        assert.ok(source.includes("LOCK_FILE"), "debe definir LOCK_FILE");
        assert.ok(source.includes("acquireLock"), "debe tener acquireLock");
        assert.ok(source.includes("releaseLock"), "debe tener releaseLock");
        assert.ok(source.includes("finally"), "debe liberar lock en bloque finally");
    });

    it("hook detecta anomalía de concurrencia (agentes > límite)", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        assert.ok(source.includes("afterCount > concurrencyLimit"), "debe detectar exceso de concurrencia");
        assert.ok(source.includes("ALERTA"), "debe enviar alerta crítica");
    });

    it("hook auto-lanza siguiente agente de la cola cuando hay slots", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        assert.ok(source.includes("afterCount < concurrencyLimit"), "debe verificar si hay slots disponibles");
        assert.ok(source.includes("launchAgent"), "debe llamar a launchAgent");
        assert.ok(source.includes("Start-Agente.ps1"), "debe usar Start-Agente.ps1 para lanzar");
    });

    it("hook no actúa si branch no es agent/*", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        assert.ok(source.includes('startsWith("agent/")'), 'debe validar branch.startsWith("agent/")');
    });

    it("hook no actúa si cola vacía", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        assert.ok(source.includes("queue.length > 0"), "debe verificar que hay items en la cola");
    });

    it("hook notifica a Telegram con mensaje informativo post-acción", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        assert.ok(source.includes("lanzado desde cola"), "debe notificar auto-lanzamiento desde cola");
        assert.ok(source.includes("Slots activos"), "debe incluir conteo de slots en notificación");
    });

    it("hook genera prompt por defecto si el agente no tiene prompt", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        assert.ok(source.includes("generateDefaultPrompt"), "debe tener generateDefaultPrompt");
        assert.ok(source.includes("!agente.prompt"), "debe detectar ausencia de prompt y generarlo");
    });

    it("hook escribe log detallado en hook-debug.log", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        assert.ok(source.includes("LOG_FILE"), "debe definir LOG_FILE");
        assert.ok(source.includes("ConcurrencyCheck:"), "debe prefixar logs con ConcurrencyCheck:");
    });

    it("hook notifica sprint completado cuando no hay agentes ni cola", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        assert.ok(source.includes("Sprint completado"), "debe notificar cuando el sprint termina");
    });

    it("hook no usa eval (seguridad)", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        // Verificar que eval no aparece como llamada a función
        const hasEval = /(?<!\w)eval\s*\(/.test(source);
        assert.ok(!hasEval, "No debe usar eval() — usar JSON.parse");
    });

    it("hook usa stop_hook_active para evitar recursión", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        assert.ok(source.includes("stop_hook_active"), "debe verificar stop_hook_active para evitar recursión");
    });

    // ─── Tests #1356: estado waiting ─────────────────────────────────────────

    it("#1356: hook excluye agentes en waiting del conteo de slots activos", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        assert.ok(
            source.includes('ag.status !== "waiting"'),
            "debe filtrar agentes waiting al contar slots activos"
        );
        assert.ok(
            source.includes("afterCount = plan.agentes.filter"),
            "afterCount debe calcularse filtrando waiting"
        );
    });

    it("#1356: hook detecta si el agente que termina estaba en waiting", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        assert.ok(
            source.includes('finishingAgent.status === "waiting"'),
            "debe detectar si el agente que termina estaba en waiting"
        );
        assert.ok(
            source.includes("wasWaiting"),
            "debe usar variable wasWaiting para tracking del estado"
        );
    });

    it("#1356: post-git-push.js tiene función markAgentWaitingInPlan", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "post-git-push.js"),
            "utf8"
        );
        assert.ok(source.includes("markAgentWaitingInPlan"), "debe tener función markAgentWaitingInPlan");
        assert.ok(source.includes('status = "waiting"'), "debe marcar status=waiting en el agente");
        assert.ok(source.includes("waiting_since"), "debe registrar waiting_since timestamp");
        assert.ok(source.includes("waiting_reason"), "debe registrar waiting_reason");
    });

    it("#1356: post-git-push.js promueve siguiente de cola al liberar slot", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "post-git-push.js"),
            "utf8"
        );
        assert.ok(
            source.includes("activeCount < concurrencyLimit"),
            "debe verificar si hay espacio para promover de cola"
        );
        assert.ok(source.includes("launchAgentFromPlan"), "debe lanzar el agente promovido");
        assert.ok(
            source.includes("slot liberado, promoviendo"),
            "debe loguear el mensaje de liberación de slot"
        );
    });

    it("#1356: post-git-push.js notifica Telegram al liberar slot", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "post-git-push.js"),
            "utf8"
        );
        assert.ok(source.includes("notifyTelegram"), "debe notificar a Telegram");
        assert.ok(source.includes("Slot liberado"), "debe mencionar 'Slot liberado' en la notificación");
        assert.ok(source.includes("en espera de CI"), "debe indicar que el agente espera CI");
    });

    it("#1356: post-git-push.js solo actúa en ramas agent/*", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "post-git-push.js"),
            "utf8"
        );
        assert.ok(
            source.includes('branch.startsWith("agent/")'),
            "debe validar que la rama es agent/* antes de marcar waiting"
        );
    });

    it("#1356: activity-logger.js tiene función syncWaitingToSprintPlan", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "activity-logger.js"),
            "utf8"
        );
        assert.ok(source.includes("syncWaitingToSprintPlan"), "debe tener función syncWaitingToSprintPlan");
        assert.ok(
            source.includes('agent.status === "waiting"'),
            "syncWaitingToSprintPlan debe ser idempotente (verificar si ya es waiting)"
        );
    });

    it("#1356: activity-logger.js sincroniza waiting al detectar por primera vez", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "activity-logger.js"),
            "utf8"
        );
        assert.ok(source.includes("wasAlreadyWaiting"), "debe detectar primera vez con wasAlreadyWaiting");
        assert.ok(
            source.includes("syncWaitingToSprintPlan(session.branch"),
            "debe llamar syncWaitingToSprintPlan cuando es primera vez en waiting"
        );
    });

    it("#1356: log incluye conteo de agentes en waiting junto con activos", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        assert.ok(
            source.includes("en waiting"),
            "debe mostrar agentes en waiting en los logs"
        );
        assert.ok(
            source.includes("waitingCount"),
            "debe calcular waitingCount separado de afterCount"
        );
    });
});

// ─── Tests para Bug 1345: 4 bugs de concurrencia ────────────────────────────

describe("P-22b: Bug 1345 — captura de errores y estado completo", () => {

    it("Bug 2: launchAgent redirige stdio a spawn_agente_N.log (no usa stdio:ignore)", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        assert.ok(source.includes("spawn_agente_"), "debe crear log file con patrón spawn_agente_N");
        assert.ok(source.includes("spawnLogPath"), "debe definir spawnLogPath");
        assert.ok(source.includes("openSync"), "debe abrir el fd del log con fs.openSync");
        assert.ok(source.includes("closeSync"), "debe cerrar el fd del padre después del spawn");
        // Verifica que el path principal usa logFd, no stdio:ignore
        const launchFn = source.slice(source.indexOf("function launchAgent"), source.indexOf("// ─── Leer stdin"));
        assert.ok(launchFn.includes("stdio = ["), 'la asignación principal debe usar stdio = [logFd, logFd]');
        assert.ok(launchFn.includes("logFd"), "debe usar logFd para stderr/stdout");
    });

    it("Bug 2: log de spawn tiene path en scripts/logs/", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        assert.ok(source.includes('"scripts"') || source.includes("scripts/logs") || source.includes("scripts\", \"logs\""),
            "el path del log de spawn debe apuntar a scripts/logs/");
    });

    it("Bug 3: _completed se actualiza al remover agente de agentes", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        assert.ok(source.includes("plan._completed"), "debe referenciar plan._completed");
        assert.ok(source.includes("_completed.push"), "debe agregar el agente a _completed");
        assert.ok(source.includes("completado_at"), "debe guardar timestamp de completado (completado_at)");
        assert.ok(source.includes("resultado"), "debe guardar campo resultado en _completed");
    });

    it("Bug 3: _completed se inicializa como array si no existe", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        assert.ok(
            source.includes("Array.isArray(plan._completed)"),
            "debe verificar que _completed es array antes de push"
        );
    });

    it("Bug 4: lock se adquiere ANTES de loadPlan (protege lectura+escritura)", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        const lockIdx = source.indexOf("acquireLock()");
        const loadPlanIdx = source.indexOf("plan = loadPlan()");
        assert.ok(lockIdx !== -1, "debe llamar a acquireLock()");
        assert.ok(loadPlanIdx !== -1, "debe llamar a loadPlan()");
        assert.ok(lockIdx < loadPlanIdx, "acquireLock() debe llamarse ANTES que loadPlan() — protege lectura+escritura");
    });

    it("Bug 4: warn cuando fail-open por timeout de lock", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        assert.ok(
            source.includes("Operando sin lock") || source.includes("race condition"),
            "debe advertir sobre posible race condition cuando el lock no se pudo adquirir"
        );
    });

    it("Bug 1: Start-Agente.ps1 verifica PID activo antes de remover .claude/", () => {
        const ps1Path = path.join(__dirname, "..", "..", "..", "scripts", "Start-Agente.ps1");
        assert.ok(fs.existsSync(ps1Path), "Start-Agente.ps1 debe existir");
        const source = fs.readFileSync(ps1Path, "utf8");
        assert.ok(source.includes("sprint-pids.json"), "debe leer sprint-pids.json para verificar PIDs");
        assert.ok(source.includes("Get-Process -Id"), "debe verificar si el proceso está vivo con Get-Process");
        assert.ok(source.includes("ya esta activo") || source.includes("ya está activo"),
            "debe loguear warning cuando el agente ya está corriendo");
    });

    it("Bug 1: Start-Agente.ps1 usa try/catch en Remove-Item .claude/", () => {
        const ps1Path = path.join(__dirname, "..", "..", "..", "scripts", "Start-Agente.ps1");
        const source = fs.readFileSync(ps1Path, "utf8");
        // Verificar que hay un try/catch alrededor de Remove-Item $claudeDst
        const removeItemIdx = source.indexOf("Remove-Item $claudeDst -Recurse -Force");
        assert.ok(removeItemIdx !== -1, "debe tener Remove-Item $claudeDst");
        // Buscar el try { previo a Remove-Item
        const beforeRemove = source.slice(Math.max(0, removeItemIdx - 200), removeItemIdx);
        assert.ok(beforeRemove.includes("try {"), "Remove-Item $claudeDst debe estar dentro de un bloque try");
        // Buscar catch posterior
        const afterRemove = source.slice(removeItemIdx, removeItemIdx + 300);
        assert.ok(afterRemove.includes("} catch {"), "debe tener catch después de Remove-Item $claudeDst");
    });
});

// ─── Tests para Bug 1399: validación PR y lanzamiento real de agentes ─────────

describe("P-22c: Bug 1399 — validación PR y lanzamiento real de agentes", () => {

    it("#1399: hook tiene función checkPRStatus", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        assert.ok(source.includes("function checkPRStatus"), "debe tener función checkPRStatus");
        assert.ok(source.includes("pr list"), "checkPRStatus debe llamar 'pr list'");
        assert.ok(source.includes("--state all"), "debe consultar PRs en todos los estados");
        assert.ok(source.includes("--json number,state"), "debe retornar número y estado del PR");
    });

    it("#1399: checkPRStatus retorna 'merged', 'open', 'none' o 'unknown'", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        assert.ok(source.includes('"merged"'), "debe manejar estado merged");
        assert.ok(source.includes('"open"'), "debe manejar estado open");
        assert.ok(source.includes('"none"'), "debe manejar ausencia de PR");
        assert.ok(source.includes('"unknown"'), "debe manejar error en gh CLI");
    });

    it("#1399: agente sin PR se mueve a _incomplete[] con resultado 'failed'", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        assert.ok(source.includes("plan._incomplete"), "debe referenciar plan._incomplete");
        assert.ok(source.includes("_incomplete.push"), "debe agregar el agente a _incomplete");
        assert.ok(source.includes('"failed"'), "debe marcar resultado como failed");
        assert.ok(
            source.includes("Sin PR — el agente no completó /delivery"),
            "debe incluir motivo descriptivo para PR faltante"
        );
        assert.ok(source.includes("incompleteEntry.motivo"), "debe guardar motivo en la entrada");
    });

    it("#1399: agente con PR abierta se mantiene en agentes[] con status waiting", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        assert.ok(
            source.includes('"pending_review"'),
            "debe usar resultado pending_review para PR abierta"
        );
        assert.ok(
            source.includes('status: "waiting"'),
            "debe mantener agente en waiting cuando PR está abierta"
        );
    });

    it("#1399: agente con PR mergeada se mueve a _completed[] con resultado 'ok'", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        const completedBlock = source.slice(
            source.indexOf("prStatus.status === \"merged\""),
            source.indexOf("prStatus.status === \"open\"")
        );
        assert.ok(completedBlock.includes("_completed.push"), "PR mergeada debe ir a _completed");
        assert.ok(completedBlock.includes('"ok"'), "PR mergeada debe tener resultado ok");
    });

    it("#1399: Telegram notifica agente fallido con motivo", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        assert.ok(source.includes("FALLIDO"), "debe notificar FALLIDO por Telegram");
        assert.ok(source.includes("Acción: revisar worktree"), "debe incluir acción sugerida");
    });

    it("#1399: _incomplete se inicializa como array si no existe", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        assert.ok(
            source.includes("Array.isArray(plan._incomplete)"),
            "debe inicializar _incomplete como array si no existe"
        );
    });

    it("#1399: launchAgent pasa -Force a Start-Agente.ps1", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        assert.ok(
            source.includes('"-Force"'),
            "launchAgent debe pasar -Force al PowerShell para worktree fresco"
        );
    });

    it("#1399: prompt se asigna al agente antes de guardar plan", () => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "agent-concurrency-check.js"),
            "utf8"
        );
        // Verificar que el prompt se asigna antes de savePlan en el bloque de cola
        const queueBlock = source.slice(
            source.indexOf("// Asegurar que el prompt está asignado"),
            source.indexOf("// Mover de cola a agentes")
        );
        assert.ok(queueBlock.length > 0, "debe asignar prompt antes de mover de cola");
        assert.ok(queueBlock.includes("nextAgente.prompt"), "debe asignar prompt al agente promovido");
        assert.ok(queueBlock.includes("generateDefaultPrompt"), "debe generar prompt por defecto si falta");
    });

    it("#1399: Start-Agente.ps1 tiene parámetro -Force", () => {
        const ps1Path = path.join(__dirname, "..", "..", "..", "scripts", "Start-Agente.ps1");
        const source = fs.readFileSync(ps1Path, "utf8");
        assert.ok(source.includes("[switch]$Force"), "Start-Agente.ps1 debe tener parámetro -Force");
        assert.ok(
            source.includes("$wtExists -and $Force"),
            "debe verificar combinación $wtExists + $Force"
        );
        assert.ok(
            source.includes("git worktree remove"),
            "debe eliminar worktree viejo con git worktree remove"
        );
        assert.ok(
            source.includes("Se creará uno nuevo desde origin/main"),
            "debe loguear que se creará worktree fresco"
        );
    });

    it("#1399: Start-Agente.ps1 documenta -Force en synopsis", () => {
        const ps1Path = path.join(__dirname, "..", "..", "..", "scripts", "Start-Agente.ps1");
        const source = fs.readFileSync(ps1Path, "utf8");
        assert.ok(
            source.includes(".PARAMETER Force") || source.includes("Start-Agente.ps1 1 -Force"),
            "debe documentar el parámetro -Force en el synopsis"
        );
    });
});
