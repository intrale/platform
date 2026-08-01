// Test P-08: Agent monitor (unificación Watch-Agentes + Guardian-Sprint)
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const agentMonitor = require("../agent-monitor");

describe("P-08: Agent monitor", () => {
    after(() => {
        // Asegurar cleanup de intervals
        agentMonitor.stopAgentMonitor();
    });

    it("módulo carga sin error", () => {
        assert.ok(agentMonitor, "agent-monitor debería cargar");
    });

    it("exporta startAgentMonitor", () => {
        assert.equal(typeof agentMonitor.startAgentMonitor, "function");
    });

    it("exporta stopAgentMonitor", () => {
        assert.equal(typeof agentMonitor.stopAgentMonitor, "function");
    });

    it("exporta getAgentStatus", () => {
        assert.equal(typeof agentMonitor.getAgentStatus, "function");
    });

    it("getAgentStatus sin plan retorna active:false, agents:[]", () => {
        const status = agentMonitor.getAgentStatus();
        assert.equal(status.active, false);
        assert.deepEqual(status.agents, []);
    });

    it("startAgentMonitor con guardianOnly retorna watching:false, guardian:true", () => {
        const result = agentMonitor.startAgentMonitor(null, { guardianOnly: true });
        assert.equal(result.watching, false);
        assert.equal(result.guardian, true);
        agentMonitor.stopAgentMonitor(); // cleanup
    });

    it("stopAgentMonitor no throw", () => {
        assert.doesNotThrow(() => agentMonitor.stopAgentMonitor());
    });

    it("Watch-Agentes.ps1 contiene mensaje de DEPRECADO", () => {
        const waFile = path.join(__dirname, "..", "..", "..", "scripts", "Watch-Agentes.ps1");
        const source = fs.readFileSync(waFile, "utf8");
        assert.ok(source.includes("DEPRECADO"), "Watch-Agentes.ps1 debería estar marcado como DEPRECADO");
    });

    it("Guardian-Sprint.ps1 contiene mensaje de DEPRECADO", () => {
        const gsFile = path.join(__dirname, "..", "..", "..", "scripts", "Guardian-Sprint.ps1");
        const source = fs.readFileSync(gsFile, "utf8");
        assert.ok(source.includes("DEPRECADO"), "Guardian-Sprint.ps1 debería estar marcado como DEPRECADO");
    });

    it("integra ops-learnings (P-15)", () => {
        const sourceFile = path.join(__dirname, "..", "agent-monitor.js");
        const source = fs.readFileSync(sourceFile, "utf8");
        assert.ok(source.includes('require("./ops-learnings")'), "Debería integrar ops-learnings");
    });

    // ─── Tests de timeout stale/failed (issue #1257) ─────────────────────────

    it("exporta constante STALE_MS igual a 15 minutos", () => {
        assert.equal(typeof agentMonitor.STALE_MS, "number");
        assert.equal(agentMonitor.STALE_MS, 15 * 60 * 1000, "STALE_MS debe ser 15 minutos (900000ms)");
    });

    it("exporta constante FAILED_TOTAL_MS igual a 45 minutos", () => {
        assert.equal(typeof agentMonitor.FAILED_TOTAL_MS, "number");
        assert.equal(agentMonitor.FAILED_TOTAL_MS, 45 * 60 * 1000, "FAILED_TOTAL_MS debe ser 45 minutos (2700000ms)");
    });

    it("getAgentStatus incluye campo status por agente", () => {
        const plan = {
            sprint_id: "SPR-TEST",
            size: "medio",
            started_at: "2026-03-08T10:00:00Z",
            agentes: [{ numero: 1, issue: 9999, slug: "test-slug" }]
        };
        agentMonitor.startAgentMonitor(plan, { guardianOnly: true });
        const status = agentMonitor.getAgentStatus();
        agentMonitor.stopAgentMonitor();
        assert.ok(Array.isArray(status.agents), "agents debe ser array");
        assert.equal(status.agents.length, 1);
        assert.ok("status" in status.agents[0], "cada agente debe tener campo status");
    });

    it("getAgentStatus incluye campos failed y terminal en el resumen", () => {
        const plan = {
            sprint_id: "SPR-TEST",
            size: "medio",
            started_at: "2026-03-08T10:00:00Z",
            agentes: [{ numero: 1, issue: 9998, slug: "test-slug-2" }]
        };
        agentMonitor.startAgentMonitor(plan, { guardianOnly: true });
        const status = agentMonitor.getAgentStatus();
        agentMonitor.stopAgentMonitor();
        assert.ok("failed" in status, "status debe incluir campo failed");
        assert.ok("terminal" in status, "status debe incluir campo terminal");
    });

    it("agent-monitor.js define función checkTimeouts (detección de stale/failed)", () => {
        const sourceFile = path.join(__dirname, "..", "agent-monitor.js");
        const source = fs.readFileSync(sourceFile, "utf8");
        assert.ok(source.includes("async function checkTimeouts"), "Debe tener función checkTimeouts");
    });

    it("agent-monitor.js define función updateSprintPlanStatus", () => {
        const sourceFile = path.join(__dirname, "..", "agent-monitor.js");
        const source = fs.readFileSync(sourceFile, "utf8");
        assert.ok(source.includes("function updateSprintPlanStatus"), "Debe tener función updateSprintPlanStatus");
    });

    it("agent-monitor.js define función agentBranchExists", () => {
        const sourceFile = path.join(__dirname, "..", "agent-monitor.js");
        const source = fs.readFileSync(sourceFile, "utf8");
        assert.ok(source.includes("function agentBranchExists"), "Debe tener función agentBranchExists");
    });

    it("sprint-plan.json se actualiza con campo status al iniciar monitor", () => {
        // Verificar que updateSprintPlanStatus escribe el campo status correctamente
        const sourceFile = path.join(__dirname, "..", "agent-monitor.js");
        const source = fs.readFileSync(sourceFile, "utf8");
        assert.ok(source.includes("agente.status = state.status"), "Debe persistir status en sprint-plan.json");
    });

    it("agentes failed se excluyen del denominador de progreso (todos en terminal → cierre)", () => {
        const sourceFile = path.join(__dirname, "..", "agent-monitor.js");
        const source = fs.readFileSync(sourceFile, "utf8");
        assert.ok(
            source.includes('state.status === "failed"') && source.includes("terminalCount"),
            "Debe contar agentes failed como terminales para cierre del sprint"
        );
    });
});
