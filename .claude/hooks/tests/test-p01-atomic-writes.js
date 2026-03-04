// Test P-01: Escritura atómica en pending-questions.js
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TEST_DIR = path.join(os.tmpdir(), "test-p01-" + process.pid);

let pq;

describe("P-01: Escritura atómica en pending-questions", () => {
    before(() => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        const sourceFile = path.join(__dirname, "..", "pending-questions.js");
        const source = fs.readFileSync(sourceFile, "utf8");
        const patched = source.replace(
            /const PENDING_FILE = [^;]+;/,
            "const PENDING_FILE = " + JSON.stringify(path.join(TEST_DIR, "pending-questions.json")) + ";"
        );
        const patchedFile = path.join(TEST_DIR, "pending-questions.js");
        fs.writeFileSync(patchedFile, patched, "utf8");
        pq = require(patchedFile);
    });

    after(() => {
        try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (e) {}
    });

    it("saveQuestions usa escritura atómica (temp + rename en source)", () => {
        const sourceFile = path.join(__dirname, "..", "pending-questions.js");
        const source = fs.readFileSync(sourceFile, "utf8");
        assert.ok(source.includes(".tmp") && source.includes("renameSync"), "Debería usar archivo temporal .tmp + renameSync");
        assert.ok(source.includes("renameSync"), "Debería usar renameSync para atomicidad");
    });

    it("addPendingQuestion crea archivo correctamente", () => {
        pq.addPendingQuestion({
            id: "test-001",
            type: "permission",
            message: "Test question"
        });
        const pqFile = path.join(TEST_DIR, "pending-questions.json");
        assert.ok(fs.existsSync(pqFile), "Archivo debería existir");
    });

    it("no deja archivos .tmp huérfanos tras escritura", () => {
        pq.addPendingQuestion({
            id: "test-002",
            type: "permission",
            message: "Test question 2"
        });
        const tmpFiles = fs.readdirSync(TEST_DIR).filter(f => f.includes(".tmp."));
        assert.equal(tmpFiles.length, 0, "No debería haber archivos .tmp huérfanos");
    });

    it("contenido es JSON válido tras save+load roundtrip", () => {
        const pqFile = path.join(TEST_DIR, "pending-questions.json");
        const data = JSON.parse(fs.readFileSync(pqFile, "utf8"));
        assert.ok(data.questions, "Debería tener campo questions");
        assert.ok(Array.isArray(data.questions), "questions debería ser array");
        assert.ok(data.questions.length >= 2, "Debería tener al menos 2 questions");
    });

    it("getQuestionById retorna question existente", () => {
        const q = pq.getQuestionById("test-001");
        assert.ok(q, "Debería encontrar question test-001");
        assert.equal(q.id, "test-001");
    });
});
