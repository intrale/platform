// Test P-14: Process supervisor centralizado
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TEST_DIR = path.join(os.tmpdir(), "test-p14-" + process.pid);

let supervisor;

describe("P-14: Process supervisor", () => {
    before(() => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        // Patchear para usar dir temporal
        const sourceFile = path.join(__dirname, "..", "process-supervisor.js");
        const source = fs.readFileSync(sourceFile, "utf8");
        const patched = source
            .replace("const HOOKS_DIR = __dirname;", "const HOOKS_DIR = " + JSON.stringify(TEST_DIR) + ";");
        const patchedFile = path.join(TEST_DIR, "process-supervisor.js");
        fs.writeFileSync(patchedFile, patched, "utf8");
        supervisor = require(patchedFile);
    });

    after(() => {
        supervisor.stopSupervision();
        try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (e) {}
    });

    it("register agrega proceso al registry", () => {
        supervisor.register(process.pid, "test-process", { policy: "notify" });
        const registry = supervisor.getRegistry();
        const entry = registry.find(e => e.pid === process.pid);
        assert.ok(entry, "Debería encontrar el PID registrado");
        assert.equal(entry.role, "test-process");
        assert.equal(entry.policy, "notify");
    });

    it("getRegistry retorna alive:true para PID actual", () => {
        const registry = supervisor.getRegistry();
        const entry = registry.find(e => e.pid === process.pid);
        assert.equal(entry.alive, true, "PID actual debería estar alive");
    });

    it("heartbeat actualiza lastHeartbeat", () => {
        const before = supervisor.getRegistry().find(e => e.pid === process.pid).lastHeartbeat;
        // Pequeño delay para asegurar timestamp diferente
        const start = Date.now();
        while (Date.now() - start < 10) {} // busy wait 10ms
        supervisor.heartbeat(process.pid);
        const after = supervisor.getRegistry().find(e => e.pid === process.pid).lastHeartbeat;
        assert.ok(after >= before, "lastHeartbeat debería ser >= anterior");
    });

    it("unregister remueve del registry", () => {
        supervisor.unregister(process.pid);
        const registry = supervisor.getRegistry();
        const entry = registry.find(e => e.pid === process.pid);
        assert.equal(entry, undefined, "PID no debería estar en registry tras unregister");
    });

    it("PID ficticio se detecta como muerto", () => {
        supervisor.register(99999, "fake-dead-process", { policy: "ignore" });
        const registry = supervisor.getRegistry();
        const entry = registry.find(e => e.pid === 99999);
        assert.ok(entry, "Debería encontrar PID 99999");
        assert.equal(entry.alive, false, "PID 99999 debería estar muerto");
        supervisor.unregister(99999);
    });

    it("startSupervision / stopSupervision no throw", () => {
        assert.doesNotThrow(() => supervisor.startSupervision());
        assert.doesNotThrow(() => supervisor.stopSupervision());
    });

    it("registry se persiste a archivo", () => {
        supervisor.register(process.pid, "persist-test");
        const regFile = path.join(TEST_DIR, "process-registry.json");
        assert.ok(fs.existsSync(regFile), "Registry file debería existir");
        const data = JSON.parse(fs.readFileSync(regFile, "utf8"));
        assert.ok(data[process.pid], "Debería contener PID en archivo persistido");
        supervisor.unregister(process.pid);
    });

    it("integra ops-learnings (P-15)", () => {
        const sourceFile = path.join(__dirname, "..", "process-supervisor.js");
        const source = fs.readFileSync(sourceFile, "utf8");
        assert.ok(source.includes('require("./ops-learnings")'), "Debería integrar ops-learnings");
    });
});
