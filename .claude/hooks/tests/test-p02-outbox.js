// Test P-02: Outbox pattern (telegram-outbox.js)
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TEST_DIR = path.join(os.tmpdir(), "test-p02-" + process.pid);
const OUTBOX_FILE = path.join(TEST_DIR, "telegram-outbox.jsonl");

let outbox;

describe("P-02: Outbox pattern", () => {
    before(() => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        const sourceFile = path.join(__dirname, "..", "telegram-outbox.js");
        const source = fs.readFileSync(sourceFile, "utf8");
        const patched = source
            .replace("const HOOKS_DIR = __dirname;", "const HOOKS_DIR = " + JSON.stringify(TEST_DIR) + ";")
            // Disable tgClient import to avoid side effects
            .replace(/let tgClient;[\s\S]*?try \{[^}]+\} catch \(e\) \{ tgClient = null; \}/, "let tgClient = null;");
        const patchedFile = path.join(TEST_DIR, "telegram-outbox.js");
        fs.writeFileSync(patchedFile, patched, "utf8");
        outbox = require(patchedFile);
    });

    after(() => {
        try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (e) {}
    });

    it("enqueue agrega entry con status pending", () => {
        outbox.enqueue("Test message 1");
        assert.ok(fs.existsSync(OUTBOX_FILE), "Outbox file debería existir");
        const raw = fs.readFileSync(OUTBOX_FILE, "utf8").trim();
        const entry = JSON.parse(raw);
        assert.equal(entry.status, "pending");
        assert.equal(entry.text, "Test message 1");
    });

    it("múltiples enqueue acumulan entries", () => {
        outbox.enqueue("Test message 2");
        outbox.enqueue("Test message 3");
        const lines = fs.readFileSync(OUTBOX_FILE, "utf8").trim().split("\n");
        assert.ok(lines.length >= 3, "Debería tener al menos 3 entries");
    });

    it("entry tiene campos obligatorios (ts, text, status, category)", () => {
        const lines = fs.readFileSync(OUTBOX_FILE, "utf8").trim().split("\n");
        const entry = JSON.parse(lines[0]);
        assert.ok(entry.ts, "Debería tener ts");
        assert.ok(entry.text, "Debería tener text");
        assert.equal(entry.status, "pending");
        assert.ok(entry.category, "Debería tener category");
    });

    it("drainQueue sin tgClient retorna sent:0, failed:0", async () => {
        const result = await outbox.drainQueue();
        assert.equal(result.sent, 0);
        assert.equal(result.failed, 0);
    });

    it("enqueue con opciones personalizadas", () => {
        outbox.enqueue("Silent msg", { silent: true, category: "heartbeat" });
        const lines = fs.readFileSync(OUTBOX_FILE, "utf8").trim().split("\n");
        const last = JSON.parse(lines[lines.length - 1]);
        assert.equal(last.silent, true);
        assert.equal(last.category, "heartbeat");
    });
});
