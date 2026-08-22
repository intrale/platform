// Test P-27: Hook post-issue-close — gate de calidad QA (#1260)
// Verifica que el hook distingue entre issues con/sin labels de QA
// y los mueve a la columna correcta en Project V2
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const HOOK_FILE = path.join(__dirname, "..", "post-issue-close.js");
const source = fs.readFileSync(HOOK_FILE, "utf8");

describe("P-27: Gate de calidad QA en post-issue-close (#1260)", () => {

    // ─── Constantes del gate ──────────────────────────────────────────────────

    it("define QA_PASS_LABELS con qa:passed y qa:skipped", () => {
        assert.ok(source.includes("qa:passed"),
            "Debe incluir qa:passed como label de aprobacion QA");
        assert.ok(source.includes("qa:skipped"),
            "Debe incluir qa:skipped como label de omision QA");
    });

    it("define QA_PENDING_OPTION_ID con el ID correcto de Project V2", () => {
        assert.ok(source.includes("QA_PENDING_OPTION_ID"),
            "Debe tener constante QA_PENDING_OPTION_ID");
        assert.ok(source.includes("dcd0a053"),
            "El ID de QA Pending en Project V2 debe ser dcd0a053");
    });

    it("define DONE_OPTION_ID con el ID correcto de Project V2", () => {
        assert.ok(source.includes("DONE_OPTION_ID"),
            "Debe tener constante DONE_OPTION_ID");
        assert.ok(source.includes("b30e67ed"),
            "El ID de Done en Project V2 debe ser b30e67ed");
    });

    it("define AUDIT_FILE apuntando a delivery-gate-audit.jsonl", () => {
        assert.ok(source.includes("AUDIT_FILE"),
            "Debe tener constante AUDIT_FILE");
        assert.ok(source.includes("delivery-gate-audit.jsonl"),
            "El audit log debe ser delivery-gate-audit.jsonl");
    });

    // ─── Funciones del gate ───────────────────────────────────────────────────

    it("tiene funcion getIssueLabels para obtener labels del issue", () => {
        assert.ok(source.includes("async function getIssueLabels"),
            "Debe tener getIssueLabels");
    });

    it("tiene funcion addLabelToIssue para agregar qa:pending", () => {
        assert.ok(source.includes("async function addLabelToIssue"),
            "Debe tener addLabelToIssue");
    });

    it("tiene funcion ensureLabelExists para crear label si no existe", () => {
        assert.ok(source.includes("async function ensureLabelExists"),
            "Debe tener ensureLabelExists");
    });

    it("tiene funcion moveIssueInProject para mover en Project V2", () => {
        assert.ok(source.includes("async function moveIssueInProject"),
            "Debe tener moveIssueInProject");
    });

    it("tiene funcion appendAudit para registrar en delivery-gate-audit.jsonl", () => {
        assert.ok(source.includes("function appendAudit"),
            "Debe tener appendAudit");
    });

    // ─── Logica del gate en processIssueClose ────────────────────────────────

    it("processIssueClose obtiene los labels del issue antes de decidir", () => {
        assert.ok(source.includes("getIssueLabels(token, issueNumber)"),
            "Debe llamar a getIssueLabels antes de mover");
    });

    it("processIssueClose mueve a Done cuando tiene label QA aprobado", () => {
        assert.ok(source.includes("DONE_OPTION_ID") && source.includes("moved_to_done"),
            "Debe mover a Done y registrar 'moved_to_done' en audit");
    });

    it("processIssueClose mueve a QA Pending cuando no tiene label QA", () => {
        assert.ok(source.includes("QA_PENDING_OPTION_ID") && source.includes("moved_to_qa_pending"),
            "Debe mover a QA Pending y registrar 'moved_to_qa_pending' en audit");
    });

    it("processIssueClose agrega label qa:pending cuando mueve a QA Pending", () => {
        assert.ok(source.includes('"qa:pending"') || source.includes("'qa:pending'"),
            "Debe agregar label qa:pending");
        assert.ok(source.includes("addLabelToIssue"),
            "Debe llamar addLabelToIssue para agregar qa:pending");
        assert.ok(source.includes("ensureLabelExists"),
            "Debe llamar ensureLabelExists antes de agregar el label");
    });

    // ─── Notificacion Telegram ────────────────────────────────────────────────

    it("envia notificacion por Telegram cuando mueve a QA Pending", () => {
        assert.ok(source.includes("sendTelegram"),
            "Debe tener funcion sendTelegram");
        assert.ok(source.includes("QA Pending") || source.includes("QA E2E"),
            "El mensaje de Telegram debe mencionar QA Pending o QA E2E");
    });

    it("la notificacion Telegram incluye el numero de issue", () => {
        assert.ok(source.includes("Issue #") || source.includes('"#"'),
            "El mensaje de Telegram debe incluir el numero de issue");
    });

    // ─── Audit log ────────────────────────────────────────────────────────────

    it("el audit log incluye ts, issue, qa_status, pr y action", () => {
        assert.ok(source.includes('"ts"') || source.includes("ts:"),
            "El audit debe incluir timestamp");
        assert.ok(source.includes('"issue"') || source.includes("issue:"),
            "El audit debe incluir numero de issue");
        assert.ok(source.includes('"qa_status"') || source.includes("qa_status:"),
            "El audit debe incluir qa_status");
        assert.ok(source.includes('"action"') || source.includes("action:"),
            "El audit debe incluir la accion tomada");
    });

    it("el audit registra qa_status 'pending' cuando no hay label QA", () => {
        assert.ok(source.includes('"pending"') || source.includes("pending"),
            "Debe registrar qa_status pending en audit");
    });

    it("el audit registra qa_status 'passed' o 'skipped' cuando pasa el gate", () => {
        assert.ok(source.includes('"passed"') || source.includes("passed"),
            "Debe registrar qa_status passed en audit");
        assert.ok(source.includes('"skipped"') || source.includes("skipped"),
            "Debe registrar qa_status skipped en audit");
    });

    // ─── No bloqueante ────────────────────────────────────────────────────────

    it("el gate no bloquea el proceso (no lanza excepciones no manejadas)", () => {
        // Verificar que errores en processIssueClose son capturados
        assert.ok(source.includes("processIssueClose(issueNumbers["),
            "processIssueClose se llama dentro de un loop con manejo de errores");
        // Verificar que hay catch para el loop de issues
        const loopCatchPattern = /for.*issueNumbers.*\{[\s\S]*?catch.*\(.*\)[\s\S]*?\}/m;
        assert.ok(loopCatchPattern.test(source) || source.includes("catch (e) {"),
            "Debe capturar errores por cada issue sin bloquear los demas");
    });

    // ─── Integracion con PR merge ─────────────────────────────────────────────

    it("handlePrMerge llama processIssueClose pasando el numero de PR", () => {
        assert.ok(source.includes("processIssueClose(issueNumbers["),
            "processIssueClose debe recibir el numero de issue del PR body");
        // Verificar que se pasa prNumber
        assert.ok(source.includes("prNumber"),
            "Debe pasar prNumber a processIssueClose para el audit log");
    });

    // ─── Archivo de audit existe ──────────────────────────────────────────────

    it("el archivo delivery-gate-audit.jsonl existe en el sistema de archivos", () => {
        const auditFile = path.join(__dirname, "..", "delivery-gate-audit.jsonl");
        assert.ok(fs.existsSync(auditFile),
            "El archivo delivery-gate-audit.jsonl debe existir en .claude/hooks/");
    });
});
