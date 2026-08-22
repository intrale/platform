// Test P-28: add-to-project-status.js — asignación de Status en Project V2 (#1333)
// Verifica que getBacklogOptionId asigna el backlog correcto según labels del issue
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const utils = require(path.join(__dirname, "..", "project-utils.js"));

describe("P-28: add-to-project-status — asignación de Status por labels (#1333)", () => {

    it("issues con label backlog-tecnico retornan Backlog Tecnico (4fef8264)", () => {
        const result = utils.getBacklogOptionId(["backlog-tecnico", "area:infra"]);
        assert.strictEqual(result, "4fef8264",
            "Issues de infra deben ir al Backlog Tecnico");
    });

    it("issues con label app:client retornan Backlog CLIENTE (74b58f5f)", () => {
        const result = utils.getBacklogOptionId(["app:client", "area:ux"]);
        assert.strictEqual(result, "74b58f5f",
            "Issues de cliente deben ir al Backlog CLIENTE");
    });

    it("issues con label app:business retornan Backlog NEGOCIO (1e51e9ff)", () => {
        const result = utils.getBacklogOptionId(["app:business"]);
        assert.strictEqual(result, "1e51e9ff",
            "Issues de negocio deben ir al Backlog NEGOCIO");
    });

    it("issues con label app:delivery retornan Backlog DELIVERY (0fa31c9f)", () => {
        const result = utils.getBacklogOptionId(["app:delivery"]);
        assert.strictEqual(result, "0fa31c9f",
            "Issues de delivery deben ir al Backlog DELIVERY");
    });

    it("issues sin labels específicas de app retornan Backlog Tecnico por defecto (4fef8264)", () => {
        const result = utils.getBacklogOptionId([]);
        assert.strictEqual(result, "4fef8264",
            "Issues sin labels de app deben ir al Backlog Tecnico por defecto");
    });

    it("STATUS_OPTIONS contiene todos los backlogs esperados", () => {
        assert.strictEqual(utils.STATUS_OPTIONS["Backlog Tecnico"], "4fef8264");
        assert.strictEqual(utils.STATUS_OPTIONS["Backlog CLIENTE"], "74b58f5f");
        assert.strictEqual(utils.STATUS_OPTIONS["Backlog NEGOCIO"], "1e51e9ff");
        assert.strictEqual(utils.STATUS_OPTIONS["Backlog DELIVERY"], "0fa31c9f");
        assert.strictEqual(utils.STATUS_OPTIONS["Done"], "b30e67ed");
        assert.strictEqual(utils.STATUS_OPTIONS["In Progress"], "29e2553a");
    });
});
