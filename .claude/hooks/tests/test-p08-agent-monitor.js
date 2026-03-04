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
});
