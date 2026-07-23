// Test P-24: Auditoría de coherencia estado-columna en Project V2 (#1301)
// Verifica que scrum-auto-corrections.js:
//   - Detecta issues cerrados fuera de Done
//   - Detecta issues con label 'in-progress' en Backlog
//   - Detecta issues con label 'ready' en Backlog
//   - Detecta issues en Blocked sin label 'blocked'
//   - Respeta prioridad de reglas (closed → Done tiene prioridad máxima)
//   - Genera comentarios con el patrón correcto
//   - Exporta módulo correctamente
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SCRIPT_PATH = path.join(__dirname, "..", "scrum-auto-corrections.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeIssue(overrides = {}) {
    return Object.assign({
        itemId: "PVTI_test123",
        number: 999,
        title: "Test issue",
        state: "OPEN",
        labels: [],
        currentStatus: "Todo",
        closedAt: null,
        updatedAt: new Date().toISOString()
    }, overrides);
}

// ─── Tests de estructura del módulo ──────────────────────────────────────────

describe("P-24: scrum-auto-corrections — estructura del módulo", () => {

    it("archivo existe", () => {
        assert.ok(fs.existsSync(SCRIPT_PATH), "scrum-auto-corrections.js debe existir");
    });

    it("módulo exporta funciones requeridas", () => {
        const mod = require(SCRIPT_PATH);
        assert.ok(typeof mod.runAutoCorrections === "function", "debe exportar runAutoCorrections");
        assert.ok(typeof mod.formatAuditSection === "function", "debe exportar formatAuditSection");
        assert.ok(typeof mod.evaluateCoherenceRules === "function", "debe exportar evaluateCoherenceRules");
        assert.ok(Array.isArray(mod.COHERENCE_RULES), "debe exportar COHERENCE_RULES como array");
        assert.ok(Array.isArray(mod.BACKLOG_COLUMNS), "debe exportar BACKLOG_COLUMNS como array");
        assert.ok(typeof mod.isBacklogColumn === "function", "debe exportar isBacklogColumn");
    });

    it("COHERENCE_RULES tiene exactamente 5 reglas", () => {
        const { COHERENCE_RULES } = require(SCRIPT_PATH);
        assert.strictEqual(COHERENCE_RULES.length, 5, "debe tener 5 reglas de coherencia");
    });

    it("COHERENCE_RULES tienen estructura correcta", () => {
        const { COHERENCE_RULES } = require(SCRIPT_PATH);
        for (const rule of COHERENCE_RULES) {
            assert.ok(rule.id, `Regla debe tener id: ${JSON.stringify(rule)}`);
            assert.ok(rule.description, `Regla ${rule.id} debe tener description`);
            assert.ok(typeof rule.priority === "number", `Regla ${rule.id} debe tener priority numérica`);
            assert.ok(typeof rule.check === "function", `Regla ${rule.id} debe tener check function`);
            assert.ok(rule.targetStatus, `Regla ${rule.id} debe tener targetStatus`);
            assert.ok(typeof rule.reason === "function", `Regla ${rule.id} debe tener reason function`);
            assert.ok(["high", "medium", "low"].includes(rule.severity), `Regla ${rule.id} debe tener severity válida`);
            assert.ok(typeof rule.autoFix === "boolean", `Regla ${rule.id} debe tener autoFix booleano`);
        }
    });

    it("COHERENCE_RULES tienen prioridades únicas y ordenadas 1-5", () => {
        const { COHERENCE_RULES } = require(SCRIPT_PATH);
        const priorities = COHERENCE_RULES.map(r => r.priority).sort((a, b) => a - b);
        assert.deepStrictEqual(priorities, [1, 2, 3, 4, 5], "prioridades deben ser 1 a 5 sin duplicados");
    });

    it("no usa eval (seguridad)", () => {
        const source = fs.readFileSync(SCRIPT_PATH, "utf8");
        const hasEval = /(?<!\w)eval\s*\(/.test(source);
        assert.ok(!hasEval, "No debe usar eval() — usar JSON.parse");
    });

    it("usa archivos temporales para comentarios (evitar shell injection)", () => {
        const source = fs.readFileSync(SCRIPT_PATH, "utf8");
        assert.ok(source.includes("--body-file"), "debe usar --body-file para evitar shell injection");
        assert.ok(source.includes("tmpFile"), "debe usar archivos temporales para comentarios");
    });
});

// ─── Tests de reglas de coherencia ───────────────────────────────────────────

describe("P-24: scrum-auto-corrections — reglas de coherencia", () => {

    it("isBacklogColumn detecta columnas Backlog correctamente", () => {
        const { isBacklogColumn } = require(SCRIPT_PATH);
        assert.ok(isBacklogColumn("Todo"), "Todo es Backlog");
        assert.ok(isBacklogColumn("Backlog Tecnico"), "Backlog Tecnico es Backlog");
        assert.ok(isBacklogColumn("Backlog CLIENTE"), "Backlog CLIENTE es Backlog");
        assert.ok(isBacklogColumn("Backlog NEGOCIO"), "Backlog NEGOCIO es Backlog");
        assert.ok(isBacklogColumn("Backlog DELIVERY"), "Backlog DELIVERY es Backlog");
        assert.ok(isBacklogColumn("Refined"), "Refined es Backlog");
        assert.ok(!isBacklogColumn("In Progress"), "In Progress NO es Backlog");
        assert.ok(!isBacklogColumn("Ready"), "Ready NO es Backlog");
        assert.ok(!isBacklogColumn("Blocked"), "Blocked NO es Backlog");
        assert.ok(!isBacklogColumn("Done"), "Done NO es Backlog");
    });

    it("Regla 1: issue CLOSED fuera de Done → corrección automática", () => {
        const { evaluateCoherenceRules } = require(SCRIPT_PATH);
        const items = [
            makeIssue({ state: "CLOSED", currentStatus: "Todo" }),
            makeIssue({ state: "CLOSED", currentStatus: "In Progress" }),
            makeIssue({ state: "CLOSED", currentStatus: "Backlog Tecnico" })
        ];
        const { corrections, warnings } = evaluateCoherenceRules(items);
        assert.strictEqual(corrections.length, 3, "3 issues cerrados fuera de Done deben ser correcciones");
        assert.ok(corrections.every(c => c.targetStatus === "Done"), "todos deben moverse a Done");
        assert.ok(corrections.every(c => c.ruleId === "closed_not_done"), "debe usar regla closed_not_done");
        assert.ok(corrections.every(c => c.autoFix === true), "todos deben ser autoFix");
    });

    it("Regla 1: issue CLOSED ya en Done → sin corrección", () => {
        const { evaluateCoherenceRules } = require(SCRIPT_PATH);
        const items = [makeIssue({ state: "CLOSED", currentStatus: "Done" })];
        const { corrections } = evaluateCoherenceRules(items);
        assert.strictEqual(corrections.length, 0, "issue cerrado en Done no debe generar corrección");
    });

    it("Regla 2: label 'in-progress' en Backlog → mover a In Progress", () => {
        const { evaluateCoherenceRules } = require(SCRIPT_PATH);
        const items = [
            makeIssue({ state: "OPEN", labels: ["in-progress"], currentStatus: "Todo" }),
            makeIssue({ state: "OPEN", labels: ["in-progress"], currentStatus: "Backlog Tecnico" })
        ];
        const { corrections } = evaluateCoherenceRules(items);
        assert.strictEqual(corrections.length, 2, "2 issues con in-progress en Backlog deben corregirse");
        assert.ok(corrections.every(c => c.targetStatus === "In Progress"), "deben moverse a In Progress");
        assert.ok(corrections.every(c => c.ruleId === "in_progress_label_in_backlog"));
    });

    it("Regla 2: label 'in-progress' ya en In Progress → sin corrección", () => {
        const { evaluateCoherenceRules } = require(SCRIPT_PATH);
        const items = [makeIssue({ state: "OPEN", labels: ["in-progress"], currentStatus: "In Progress" })];
        const { corrections } = evaluateCoherenceRules(items);
        assert.strictEqual(corrections.length, 0, "issue con in-progress ya en In Progress no corrige");
    });

    it("Regla 3: label 'ready' en Backlog → mover a Ready", () => {
        const { evaluateCoherenceRules } = require(SCRIPT_PATH);
        const items = [makeIssue({ state: "OPEN", labels: ["ready"], currentStatus: "Todo" })];
        const { corrections } = evaluateCoherenceRules(items);
        assert.strictEqual(corrections.length, 1, "issue con ready en Backlog debe corregirse");
        assert.strictEqual(corrections[0].targetStatus, "Ready");
        assert.strictEqual(corrections[0].ruleId, "ready_label_in_backlog");
    });

    it("Regla 4: Status=Blocked sin label 'blocked' → mover a Todo", () => {
        const { evaluateCoherenceRules } = require(SCRIPT_PATH);
        const items = [makeIssue({ state: "OPEN", labels: [], currentStatus: "Blocked" })];
        const { corrections } = evaluateCoherenceRules(items);
        assert.strictEqual(corrections.length, 1, "issue en Blocked sin label debe corregirse");
        assert.strictEqual(corrections[0].targetStatus, "Todo");
        assert.strictEqual(corrections[0].ruleId, "blocked_status_no_label");
    });

    it("Regla 4: Status=Blocked con label 'blocked' → sin corrección", () => {
        const { evaluateCoherenceRules } = require(SCRIPT_PATH);
        const items = [makeIssue({ state: "OPEN", labels: ["blocked"], currentStatus: "Blocked" })];
        const { corrections } = evaluateCoherenceRules(items);
        assert.strictEqual(corrections.length, 0, "issue en Blocked con label blocked no corrige");
    });

    it("Regla 5: label 'blocked' fuera de Blocked → solo advertencia (no autoFix)", () => {
        const { evaluateCoherenceRules } = require(SCRIPT_PATH);
        const items = [makeIssue({ state: "OPEN", labels: ["blocked"], currentStatus: "In Progress" })];
        const { corrections, warnings } = evaluateCoherenceRules(items);
        assert.strictEqual(corrections.length, 0, "no debe generar corrección automática");
        assert.strictEqual(warnings.length, 1, "debe generar advertencia");
        assert.strictEqual(warnings[0].ruleId, "blocked_label_not_in_blocked");
        assert.strictEqual(warnings[0].autoFix, false);
    });

    it("Prioridad: issue CLOSED con label 'in-progress' → Done (regla 1 tiene prioridad)", () => {
        const { evaluateCoherenceRules } = require(SCRIPT_PATH);
        const items = [
            makeIssue({ state: "CLOSED", labels: ["in-progress"], currentStatus: "Todo" })
        ];
        const { corrections } = evaluateCoherenceRules(items);
        assert.strictEqual(corrections.length, 1, "debe generar 1 corrección");
        assert.strictEqual(corrections[0].targetStatus, "Done", "debe mover a Done, no a In Progress");
        assert.strictEqual(corrections[0].ruleId, "closed_not_done", "debe usar regla closed_not_done");
    });

    it("issue coherente (OPEN, sin labels especiales, en Todo) → sin corrección", () => {
        const { evaluateCoherenceRules } = require(SCRIPT_PATH);
        const items = [makeIssue({ state: "OPEN", labels: [], currentStatus: "Todo" })];
        const { corrections, warnings, ok } = evaluateCoherenceRules(items);
        assert.strictEqual(corrections.length, 0, "no debe haber correcciones");
        assert.strictEqual(warnings.length, 0, "no debe haber advertencias");
        assert.strictEqual(ok.length, 1, "debe estar en ok");
    });

    it("múltiples issues, mix de correcciones y OK", () => {
        const { evaluateCoherenceRules } = require(SCRIPT_PATH);
        const items = [
            makeIssue({ number: 1, state: "CLOSED", currentStatus: "Todo" }),          // → corrección (closed_not_done)
            makeIssue({ number: 2, state: "OPEN", labels: ["in-progress"], currentStatus: "Todo" }), // → corrección
            makeIssue({ number: 3, state: "OPEN", labels: [], currentStatus: "In Progress" }),        // → OK
            makeIssue({ number: 4, state: "OPEN", labels: ["blocked"], currentStatus: "In Progress" }), // → advertencia
            makeIssue({ number: 5, state: "OPEN", labels: [], currentStatus: "Done" })  // → OK (Done sin closed, válido)
        ];
        const { corrections, warnings, ok } = evaluateCoherenceRules(items);
        assert.strictEqual(corrections.length, 2, "2 correcciones automáticas");
        assert.strictEqual(warnings.length, 1, "1 advertencia");
        assert.strictEqual(ok.length, 2, "2 items OK");
    });
});

// ─── Tests de formatAuditSection ─────────────────────────────────────────────

describe("P-24: scrum-auto-corrections — formato de reporte", () => {

    it("formatAuditSection sin correcciones → mensaje de board coherente", () => {
        const { formatAuditSection } = require(SCRIPT_PATH);
        const result = formatAuditSection({
            corrections: [],
            warnings: [],
            appliedResults: [],
            dryRun: false,
            timestamp: "2026-03-09T00:00:00Z"
        });
        assert.ok(result.includes("Sin inconsistencias"), "debe indicar board coherente");
    });

    it("formatAuditSection con correcciones → tabla markdown", () => {
        const { formatAuditSection } = require(SCRIPT_PATH);
        const corrections = [{
            ruleId: "closed_not_done",
            issue: 123,
            title: "Test issue",
            currentStatus: "Todo",
            targetStatus: "Done",
            reason: "Issue cerrado (state: CLOSED)"
        }];
        const appliedResults = [{
            issue: 123,
            title: "Test issue",
            from: "Todo",
            to: "Done",
            status: "ok",
            reason: "Issue cerrado"
        }];
        const result = formatAuditSection({
            corrections,
            warnings: [],
            appliedResults,
            dryRun: false,
            timestamp: "2026-03-09T00:00:00Z"
        });
        assert.ok(result.includes("#123"), "debe mencionar el issue");
        assert.ok(result.includes("✅ Aplicada"), "debe indicar corrección aplicada");
        assert.ok(result.includes("Done"), "debe mencionar columna destino");
    });

    it("formatAuditSection en dry-run → indica detectada", () => {
        const { formatAuditSection } = require(SCRIPT_PATH);
        const corrections = [{
            ruleId: "in_progress_label_in_backlog",
            issue: 456,
            title: "Test",
            currentStatus: "Todo",
            targetStatus: "In Progress",
            reason: "Tiene label in-progress"
        }];
        const result = formatAuditSection({
            corrections,
            warnings: [],
            appliedResults: null, // null = dry-run, no se aplicó
            dryRun: true,
            timestamp: "2026-03-09T00:00:00Z"
        });
        assert.ok(result.includes("Detectada"), "dry-run debe indicar detectada, no aplicada");
    });
});

// ─── Tests de rate limiting ───────────────────────────────────────────────────

describe("P-24: scrum-auto-corrections — rate limiting", () => {

    it("script define rate limit de 30 mutations/min", () => {
        const source = fs.readFileSync(SCRIPT_PATH, "utf8");
        assert.ok(source.includes("RATE_LIMIT"), "debe definir RATE_LIMIT");
        assert.ok(source.includes("30"), "RATE_LIMIT debe ser 30");
        assert.ok(source.includes("RATE_WINDOW_MS"), "debe definir ventana temporal");
    });

    it("script procesa correcciones con rate limit aplicado", () => {
        const source = fs.readFileSync(SCRIPT_PATH, "utf8");
        assert.ok(source.includes("applyWithRateLimit"), "debe tener función applyWithRateLimit");
        assert.ok(source.includes("mutationsThisWindow"), "debe contar mutations en la ventana");
    });
});

// ─── Tests de seguridad de comentarios ───────────────────────────────────────

describe("P-24: scrum-auto-corrections — seguridad", () => {

    it("comentarios usan archivos temporales (no interpolación directa en shell)", () => {
        const source = fs.readFileSync(SCRIPT_PATH, "utf8");
        assert.ok(source.includes("--body-file"), "debe usar --body-file para comentarios");
        assert.ok(!source.includes("--body \"$"), "no debe interpolar variables en --body directamente");
    });

    it("archivos temporales se limpian con try/finally", () => {
        const source = fs.readFileSync(SCRIPT_PATH, "utf8");
        assert.ok(source.includes("finally"), "debe usar finally para limpiar archivos temporales");
        assert.ok(source.includes("fs.unlinkSync"), "debe eliminar archivos temporales");
    });

    it("audit log registra todas las correcciones", () => {
        const source = fs.readFileSync(SCRIPT_PATH, "utf8");
        assert.ok(source.includes("appendAudit"), "debe registrar en audit log");
        assert.ok(source.includes("sprint-audit.jsonl"), "debe usar sprint-audit.jsonl");
    });

    it("script no usa eval()", () => {
        const source = fs.readFileSync(SCRIPT_PATH, "utf8");
        const hasEval = /(?<!\w)eval\s*\(/.test(source);
        assert.ok(!hasEval, "No debe usar eval()");
    });
});
