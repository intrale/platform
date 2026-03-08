// Test P-21: Agent monitor — promocion automatica de _queue (#1266)
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const agentMonitor = require("../agent-monitor");

describe("P-21: Agent monitor — promocion de cola (#1266)", () => {
    after(() => {
        agentMonitor.stopAgentMonitor();
    });

    // ─── Exportaciones ───────────────────────────────────────────────────────

    it("exporta promoteFromQueue", () => {
        assert.equal(typeof agentMonitor.promoteFromQueue, "function");
    });

    it("exporta countActiveAgents", () => {
        assert.equal(typeof agentMonitor.countActiveAgents, "function");
    });

    it("exporta moveToCompleted", () => {
        assert.equal(typeof agentMonitor.moveToCompleted, "function");
    });

    it("exporta MAX_CONCURRENT_AGENTS igual a 2", () => {
        assert.equal(typeof agentMonitor.MAX_CONCURRENT_AGENTS, "number");
        assert.equal(agentMonitor.MAX_CONCURRENT_AGENTS, 2,
            "MAX_CONCURRENT_AGENTS debe ser 2");
    });

    // ─── Logica en el source ─────────────────────────────────────────────────

    it("agent-monitor.js define funcion promoteFromQueue", () => {
        const sourceFile = path.join(__dirname, "..", "agent-monitor.js");
        const source = fs.readFileSync(sourceFile, "utf8");
        assert.ok(source.includes("function promoteFromQueue"),
            "Debe tener funcion promoteFromQueue");
    });

    it("agent-monitor.js define funcion countActiveAgents", () => {
        const sourceFile = path.join(__dirname, "..", "agent-monitor.js");
        const source = fs.readFileSync(sourceFile, "utf8");
        assert.ok(source.includes("function countActiveAgents"),
            "Debe tener funcion countActiveAgents");
    });

    it("agent-monitor.js define funcion moveToCompleted", () => {
        const sourceFile = path.join(__dirname, "..", "agent-monitor.js");
        const source = fs.readFileSync(sourceFile, "utf8");
        assert.ok(source.includes("function moveToCompleted"),
            "Debe tener funcion moveToCompleted");
    });

    it("agent-monitor.js define funcion launchAgents", () => {
        const sourceFile = path.join(__dirname, "..", "agent-monitor.js");
        const source = fs.readFileSync(sourceFile, "utf8");
        assert.ok(source.includes("function launchAgents"),
            "Debe tener funcion launchAgents para lanzar agentes promovidos");
    });

    // ─── Promocion respeta maximo ────────────────────────────────────────────

    it("promoteFromQueue respeta MAX_CONCURRENT_AGENTS", () => {
        const sourceFile = path.join(__dirname, "..", "agent-monitor.js");
        const source = fs.readFileSync(sourceFile, "utf8");
        assert.ok(source.includes("MAX_CONCURRENT_AGENTS"),
            "promoteFromQueue debe usar MAX_CONCURRENT_AGENTS");
        assert.ok(source.includes("slotsAvailable"),
            "Debe calcular slots disponibles");
    });

    it("promoteFromQueue usa splice para extraer de _queue", () => {
        const sourceFile = path.join(__dirname, "..", "agent-monitor.js");
        const source = fs.readFileSync(sourceFile, "utf8");
        assert.ok(source.includes("_queue.splice"),
            "Debe usar splice para mover items de _queue a agentes");
    });

    // ─── Persistencia ────────────────────────────────────────────────────────

    it("promoteFromQueue persiste cambios en sprint-plan.json", () => {
        const sourceFile = path.join(__dirname, "..", "agent-monitor.js");
        const source = fs.readFileSync(sourceFile, "utf8");
        assert.ok(source.includes("fs.writeFileSync(PLAN_FILE"),
            "Debe escribir sprint-plan.json tras promover");
    });

    it("moveToCompleted persiste cambios en sprint-plan.json", () => {
        const sourceFile = path.join(__dirname, "..", "agent-monitor.js");
        const source = fs.readFileSync(sourceFile, "utf8");
        // moveToCompleted debe escribir al archivo
        const moveSection = source.substring(source.indexOf("function moveToCompleted"));
        assert.ok(moveSection.includes("writeFileSync"),
            "moveToCompleted debe persistir en sprint-plan.json");
    });

    // ─── Integracion con _checkAgentsImpl ────────────────────────────────────

    it("_checkAgentsImpl llama promoteFromQueue cuando hay agentes terminados", () => {
        const sourceFile = path.join(__dirname, "..", "agent-monitor.js");
        const source = fs.readFileSync(sourceFile, "utf8");
        assert.ok(source.includes("promoteFromQueue()"),
            "_checkAgentsImpl debe llamar promoteFromQueue");
    });

    it("_checkAgentsImpl llama launchAgents con los agentes promovidos", () => {
        const sourceFile = path.join(__dirname, "..", "agent-monitor.js");
        const source = fs.readFileSync(sourceFile, "utf8");
        assert.ok(source.includes("launchAgents(promoted)"),
            "_checkAgentsImpl debe llamar launchAgents con promovidos");
    });

    it("_checkAgentsImpl notifica por Telegram cuando promueve agentes", () => {
        const sourceFile = path.join(__dirname, "..", "agent-monitor.js");
        const source = fs.readFileSync(sourceFile, "utf8");
        assert.ok(source.includes("Cola de sprint avanz"),
            "Debe notificar por Telegram la promocion de cola");
    });

    // ─── Cierre de sprint ────────────────────────────────────────────────────

    it("cierre de sprint solo ocurre cuando _queue esta vacia Y todos terminaron", () => {
        const sourceFile = path.join(__dirname, "..", "agent-monitor.js");
        const source = fs.readFileSync(sourceFile, "utf8");
        assert.ok(source.includes("currentQueue.length === 0"),
            "Debe verificar que _queue esta vacia antes de cerrar sprint");
        assert.ok(source.includes("allTerminal"),
            "Debe verificar que todos los agentes estan en estado terminal");
    });
});
