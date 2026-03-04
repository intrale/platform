// Test P-17: Agent progress display hook (#1206)
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const HOOKS_DIR = path.resolve(__dirname, "..");
const HOOK_SCRIPT = path.join(HOOKS_DIR, "agent-progress.js");
const STATE_FILE = path.join(HOOKS_DIR, "agent-progress-state.json");

// El REPO_ROOT real del repo principal (no worktree)
const REPO_ROOT = "C:\\Workspaces\\Intrale\\platform";
const SESSIONS_DIR = path.join(REPO_ROOT, ".claude", "sessions");
const PLAN_FILE = path.join(REPO_ROOT, "scripts", "sprint-plan.json");

// Crear sesion de prueba temporal
const TEST_SESSION_ID = "tst17abc";
const TEST_SESSION_FILE = path.join(SESSIONS_DIR, TEST_SESSION_ID + ".json");

function createTestSession(overrides) {
    const base = {
        id: TEST_SESSION_ID,
        full_id: TEST_SESSION_ID + "-0000-0000-0000-000000000000",
        type: "parent",
        started_ts: new Date().toISOString(),
        last_activity_ts: new Date().toISOString(),
        action_count: 5,
        status: "active",
        branch: "agent/1206-progreso-terminal-agentes",
        pid: process.pid,
        last_tool: "Edit",
        last_target: "some-file.js",
        agent_name: null,
        skills_invoked: [],
        sub_count: 0,
        permission_mode: "unknown",
        current_task: null,
        current_tasks: [],
        ...overrides
    };
    fs.writeFileSync(TEST_SESSION_FILE, JSON.stringify(base, null, 2), "utf8");
    return base;
}

function runHook(toolInput, opts) {
    const clearThrottle = opts && opts.keepThrottle ? false : true;
    if (clearThrottle) {
        try { fs.unlinkSync(STATE_FILE); } catch (e) {}
    }

    const input = JSON.stringify({
        tool_name: toolInput.tool_name || "TaskCreate",
        session_id: toolInput.session_id || TEST_SESSION_ID + "-0000-0000-0000-000000000000",
        tool_input: toolInput.tool_input || { subject: "Test" }
    });

    const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
        input: input,
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
        cwd: REPO_ROOT,
        env: {
            ...process.env,
            CLAUDE_PROJECT_DIR: REPO_ROOT
        }
    });

    return (result.stderr || "") + (result.stdout || "");
}

describe("P-17: Agent progress display", () => {
    before(() => {
        if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        try { fs.unlinkSync(STATE_FILE); } catch (e) {}
    });

    after(() => {
        try { fs.unlinkSync(TEST_SESSION_FILE); } catch (e) {}
        try { fs.unlinkSync(STATE_FILE); } catch (e) {}
    });

    it("hook file existe", () => {
        assert.ok(fs.existsSync(HOOK_SCRIPT), "agent-progress.js deberia existir");
    });

    it("muestra progreso para sesion sin tareas", () => {
        createTestSession({ action_count: 10, last_tool: "Bash" });
        const output = runHook({});
        assert.ok(output.includes("Agente"), "deberia contener Agente -- output: " + output.substring(0, 200));
        assert.ok(output.includes("#1206"), "deberia contener el issue");
        assert.ok(output.includes("10 acciones"), "deberia mostrar count de acciones");
    });

    it("muestra tareas con checkboxes", () => {
        createTestSession({
            current_tasks: [
                { id: "1", subject: "Leer issue", status: "completed" },
                { id: "2", subject: "Implementar hook", status: "in_progress" },
                { id: "3", subject: "Crear PR", status: "pending" }
            ]
        });
        const output = runHook({});
        assert.ok(output.includes("Leer issue"), "deberia mostrar tarea completada");
        assert.ok(output.includes("Implementar hook"), "deberia mostrar tarea en progreso");
        assert.ok(output.includes("Crear PR"), "deberia mostrar tarea pendiente");
        assert.ok(output.includes("1/3"), "deberia mostrar 1 de 3 completadas");
        assert.ok(output.includes("33%"), "deberia mostrar 33% progreso");
    });

    it("muestra sub-pasos en tarea en progreso", () => {
        createTestSession({
            current_tasks: [
                {
                    id: "1",
                    subject: "Configurar entorno",
                    status: "in_progress",
                    steps: ["Instalar deps", "Configurar paths", "Verificar"],
                    completed_steps: ["Instalar deps"],
                    current_step: 1,
                    progress: 33
                }
            ]
        });
        const output = runHook({});
        assert.ok(output.includes("1/3"), "deberia mostrar sub-pasos 1/3");
        assert.ok(output.includes("33%"), "deberia mostrar 33% progreso de sub-pasos");
    });

    it("throttle bloquea impresiones dentro de 30s", () => {
        createTestSession({});
        const first = runHook({});
        assert.ok(first.includes("Agente"), "primera impresion deberia funcionar");

        const second = runHook(
            { tool_name: "TaskUpdate", tool_input: { taskId: "1", status: "completed" } },
            { keepThrottle: true }
        );
        assert.equal(second.trim(), "", "segunda impresion dentro de 30s deberia ser vacia");
    });

    it("no imprime para herramientas no significativas (Read)", () => {
        const output = runHook({ tool_name: "Read", tool_input: { file_path: "test.js" } });
        assert.equal(output.trim(), "", "Read no deberia disparar impresion");
    });

    it("no imprime para sesion inexistente", () => {
        const output = runHook({
            tool_name: "TaskCreate",
            session_id: "nonexist-0000-0000-0000-000000000000",
            tool_input: { subject: "Test" }
        });
        assert.equal(output.trim(), "", "sesion inexistente no deberia imprimir");
    });
});
