// Test P-15: Ops learnings — bitácora auto-actualizable
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Crear directorio temporal para aislar tests
const TEST_DIR = path.join(os.tmpdir(), "test-p15-" + process.pid);
const LEARNINGS_FILE = path.join(TEST_DIR, "ops-learnings.jsonl");
const ARCHIVE_FILE = path.join(TEST_DIR, "ops-learnings-archive.jsonl");
const DIGEST_STATE = path.join(TEST_DIR, "ops-learnings-digest.json");

// Monkey-patch: cargar el módulo y sobreescribir las rutas
let opsLearnings;

describe("P-15: Ops learnings", () => {
    before(() => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        // Cargar módulo fresco con paths de test
        // Como el módulo usa __dirname para las rutas, hacemos un workaround:
        // copiamos el archivo al dir temporal y lo requerimos desde ahí
        const sourceFile = path.join(__dirname, "..", "ops-learnings.js");
        const source = fs.readFileSync(sourceFile, "utf8");
        // Reemplazar HOOKS_DIR con nuestro dir temporal
        const patched = source.replace(
            "const HOOKS_DIR = __dirname;",
            "const HOOKS_DIR = " + JSON.stringify(TEST_DIR) + ";"
        );
        const patchedFile = path.join(TEST_DIR, "ops-learnings.js");
        fs.writeFileSync(patchedFile, patched, "utf8");
        opsLearnings = require(patchedFile);
    });

    after(() => {
        try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (e) {}
    });

    it("recordLearning crea entry con campos correctos", () => {
        const entry = opsLearnings.recordLearning({
            source: "test",
            category: "test_category",
            severity: "low",
            symptom: "test symptom 1",
            root_cause: "test cause",
            resolution: "test resolution",
            affected: ["test.js"]
        });
        assert.equal(entry.source, "test");
        assert.equal(entry.category, "test_category");
        assert.equal(entry.severity, "low");
        assert.equal(entry.symptom, "test symptom 1");
        assert.equal(entry.times_seen, 1);
        assert.equal(entry.status, "open");
        assert.ok(entry.ts);
    });

    it("segunda llamada con mismo symptom incrementa times_seen", () => {
        const entry = opsLearnings.recordLearning({
            source: "test",
            symptom: "test symptom 1"
        });
        assert.equal(entry.times_seen, 2);
    });

    it("escalamiento: times_seen >= 3 con severity low → high", () => {
        opsLearnings.recordLearning({ symptom: "test symptom 1" }); // 3
        const entries = opsLearnings.getLearnings({ symptom: "test symptom 1" });
        // Buscar el entry (getLearnings no filtra por symptom directamente, usa loadAll)
        const all = opsLearnings.getLearnings();
        const entry = all.find(e => e.symptom === "test symptom 1");
        assert.equal(entry.times_seen, 3);
        assert.equal(entry.severity, "high");
    });

    it("escalamiento: times_seen >= 5 → critical", () => {
        opsLearnings.recordLearning({ symptom: "test symptom 1" }); // 4
        opsLearnings.recordLearning({ symptom: "test symptom 1" }); // 5
        const all = opsLearnings.getLearnings();
        const entry = all.find(e => e.symptom === "test symptom 1");
        assert.equal(entry.times_seen, 5);
        assert.equal(entry.severity, "critical");
    });

    it("getLearnings filtra por severity", () => {
        opsLearnings.recordLearning({ symptom: "low symptom", severity: "low" });
        const criticals = opsLearnings.getLearnings({ severity: "critical" });
        assert.ok(criticals.length >= 1);
        assert.ok(criticals.every(e => e.severity === "critical"));
    });

    it("autoMitigate marca entries viejos como mitigated", () => {
        // Crear entry con last_seen viejo (>7 días)
        opsLearnings.recordLearning({ symptom: "old symptom", severity: "low" });
        const all = opsLearnings.getLearnings();
        const entry = all.find(e => e.symptom === "old symptom");
        // Manipular last_seen directamente en el archivo
        const raw = fs.readFileSync(LEARNINGS_FILE, "utf8").trim();
        const lines = raw.split("\n").map(l => {
            const parsed = JSON.parse(l);
            if (parsed.symptom === "old symptom") {
                parsed.last_seen = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
            }
            return JSON.stringify(parsed);
        });
        fs.writeFileSync(LEARNINGS_FILE, lines.join("\n") + "\n", "utf8");

        const mitigated = opsLearnings.autoMitigate();
        assert.ok(mitigated >= 1, "Debería mitigar al menos 1 entry");

        const updated = opsLearnings.getLearnings();
        const mitEntry = updated.find(e => e.symptom === "old symptom");
        assert.equal(mitEntry.status, "mitigated");
    });

    it("autoResolve marca resolved con commit fix(hooks):", () => {
        opsLearnings.recordLearning({
            symptom: "bug en health-check",
            affected: ["health-check.js"]
        });
        const resolved = opsLearnings.autoResolve("fix(hooks): corregir health-check.js");
        assert.ok(resolved >= 1, "Debería resolver al menos 1 entry");
    });

    it("getDigest retorna string con formato HTML", () => {
        const digest = opsLearnings.getDigest();
        assert.equal(typeof digest, "string");
        assert.ok(digest.includes("<b>"), "Digest debería contener HTML bold");
        assert.ok(digest.includes("Ops Learnings"), "Digest debería contener título");
    });

    it("shouldSendDigest retorna true en primera ejecución", () => {
        // Borrar state file si existe
        try { fs.unlinkSync(DIGEST_STATE); } catch (e) {}
        assert.equal(opsLearnings.shouldSendDigest(), true);
    });
});
