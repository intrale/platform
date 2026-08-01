// Test P-16: Promoción automática a MEMORY.md
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TEST_DIR = path.join(os.tmpdir(), "test-p16-" + process.pid);
const MEMORY_DIR = path.join(TEST_DIR, "memory");
const MEMORY_FILE = path.join(MEMORY_DIR, "ops-lessons.md");

let opsLearnings;

describe("P-16: Promoción a MEMORY.md", () => {
    before(() => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        // Copiar y patchear ops-learnings.js para usar dir temporal
        const sourceFile = path.join(__dirname, "..", "ops-learnings.js");
        const source = fs.readFileSync(sourceFile, "utf8");
        const patched = source
            .replace("const HOOKS_DIR = __dirname;", "const HOOKS_DIR = " + JSON.stringify(TEST_DIR) + ";")
            .replace(/const MEMORY_DIR = [\s\S]*?;/, "const MEMORY_DIR = " + JSON.stringify(MEMORY_DIR) + ";")
            .replace(/const MEMORY_FILE = [\s\S]*?;/, "const MEMORY_FILE = " + JSON.stringify(MEMORY_FILE) + ";");
        const patchedFile = path.join(TEST_DIR, "ops-learnings-p16.js");
        fs.writeFileSync(patchedFile, patched, "utf8");
        opsLearnings = require(patchedFile);
    });

    after(() => {
        try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (e) {}
    });

    it("promoteToMemory crea archivo ops-lessons.md si no existe", () => {
        const entry = {
            severity: "critical",
            symptom: "Test critical symptom",
            resolution: "Fix applied",
            first_seen: "2026-03-01T00:00:00Z",
            times_seen: 5
        };
        const result = opsLearnings.promoteToMemory(entry);
        assert.equal(result, true);
        assert.ok(fs.existsSync(MEMORY_FILE), "ops-lessons.md debería existir");
    });

    it("contenido incluye header y línea con symptom", () => {
        const content = fs.readFileSync(MEMORY_FILE, "utf8");
        assert.ok(content.includes("Ops Lessons"), "Debería contener header");
        assert.ok(content.includes("Test critical symptom"), "Debería contener el symptom");
    });

    it("formato correcto: **SEVERITY** symptom → resolution [date, xN]", () => {
        const content = fs.readFileSync(MEMORY_FILE, "utf8");
        assert.ok(content.includes("**CRITICAL**"), "Debería contener severity en mayúsculas");
        assert.ok(content.includes("Fix applied"), "Debería contener resolution");
        assert.ok(content.includes("x5"), "Debería contener times_seen");
    });

    it("segunda llamada con mismo symptom NO duplica (dedup)", () => {
        const entry = {
            severity: "critical",
            symptom: "Test critical symptom",
            resolution: "Fix applied",
            first_seen: "2026-03-01T00:00:00Z",
            times_seen: 6
        };
        const result = opsLearnings.promoteToMemory(entry);
        assert.equal(result, false, "No debería agregar duplicado");
        const content = fs.readFileSync(MEMORY_FILE, "utf8");
        const matches = content.match(/Test critical symptom/g);
        assert.equal(matches.length, 1, "Debería aparecer solo una vez");
    });
});
