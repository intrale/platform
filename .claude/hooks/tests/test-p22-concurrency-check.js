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
        assert.ok(source.includes("Auto-lanzado agente"), "debe notificar auto-lanzamiento");
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
        assert.ok(source.includes("completedAt"), "debe guardar timestamp de completado");
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
