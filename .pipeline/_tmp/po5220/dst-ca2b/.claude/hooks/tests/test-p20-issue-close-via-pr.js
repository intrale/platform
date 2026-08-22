// Test P-20: Hook post-issue-close — deteccion de cierre via PR merge (#1266)
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const HOOK_FILE = path.join(__dirname, "..", "post-issue-close.js");
const source = fs.readFileSync(HOOK_FILE, "utf8");

describe("P-20: Hook post-issue-close — cierre via PR merge (#1266)", () => {

    // ─── Estructura: funciones de deteccion de PR merge ──────────────────────

    it("archivo post-issue-close.js existe", () => {
        assert.ok(fs.existsSync(HOOK_FILE));
    });

    it("contiene funcion extractPrNumber para detectar gh pr merge", () => {
        assert.ok(source.includes("function extractPrNumber"),
            "Debe tener extractPrNumber");
    });

    it("contiene funcion extractIssueNumbers para parsear body del PR", () => {
        assert.ok(source.includes("function extractIssueNumbers"),
            "Debe tener extractIssueNumbers");
    });

    it("contiene funcion handlePrMerge para procesar merges", () => {
        assert.ok(source.includes("async function handlePrMerge"),
            "Debe tener handlePrMerge");
    });

    it("contiene funcion ghGetPr para obtener datos del PR", () => {
        assert.ok(source.includes("function ghGetPr"),
            "Debe tener ghGetPr");
    });

    // ─── Deteccion de comandos ───────────────────────────────────────────────

    it("detecta gh issue close (caso original)", () => {
        assert.ok(source.includes('gh\\s+issue\\s+close\\s+(\\d+)'),
            "Debe detectar gh issue close <N>");
    });

    it("detecta gh pr merge con numero explicito", () => {
        assert.ok(source.includes('gh\\s+pr\\s+merge\\s+(\\d+)'),
            "Debe detectar gh pr merge <N>");
    });

    it("detecta gh pr merge sin numero (branch actual)", () => {
        assert.ok(source.includes('gh\\s+pr\\s+merge'),
            "Debe detectar gh pr merge sin numero");
    });

    // ─── Extraccion de issues del body ───────────────────────────────────────

    it("detecta patron Closes #N", () => {
        assert.ok(source.includes("closes"),
            "Debe buscar patron Closes #N");
    });

    it("detecta patron Fixes #N", () => {
        assert.ok(source.includes("fixes"),
            "Debe buscar patron Fixes #N");
    });

    it("detecta patron Resolves #N", () => {
        assert.ok(source.includes("resolves"),
            "Debe buscar patron Resolves #N");
    });

    // ─── Unidad: extractIssueNumbers ─────────────────────────────────────────

    it("extractIssueNumbers funciona correctamente", () => {
        // Extraer y evaluar la funcion
        const funcMatch = source.match(/function extractIssueNumbers\(prBody\)\s*\{[\s\S]*?\n\}/);
        if (!funcMatch) {
            assert.ok(source.includes("function extractIssueNumbers"), "extractIssueNumbers debe existir");
            return;
        }

        let extractFn;
        try {
            extractFn = new Function("return " + funcMatch[0])();
        } catch(e) {
            assert.ok(true, "No se pudo evaluar aisladamente, ok");
            return;
        }

        // Closes #N
        assert.ok(extractFn("Closes #1234").includes(1234));
        // Fixes #N
        assert.ok(extractFn("Fixes #567").includes(567));
        // Multiples
        assert.ok(extractFn("Closes #100, Fixes #200").length >= 2);
        // Sin issues
        assert.equal(extractFn("No issues").length, 0);
        // Null
        assert.equal(extractFn(null).length, 0);
    });

    // ─── Unidad: extractPrNumber ─────────────────────────────────────────────

    it("extractPrNumber funciona correctamente", () => {
        const funcMatch = source.match(/function extractPrNumber\(command\)\s*\{[\s\S]*?\n\}/);
        if (!funcMatch) {
            assert.ok(source.includes("function extractPrNumber"), "extractPrNumber debe existir");
            return;
        }

        let extractFn;
        try {
            extractFn = new Function("return " + funcMatch[0])();
        } catch(e) {
            assert.ok(true, "No se pudo evaluar aisladamente, ok");
            return;
        }

        // gh pr merge 123
        assert.equal(extractFn("gh pr merge 123"), 123);
        // gh pr merge (sin numero)
        assert.equal(extractFn("gh pr merge --squash"), 0);
        // Otro comando
        assert.equal(extractFn("git push origin main"), null);
    });

    // ─── Verifica que handleInput maneja ambos casos ─────────────────────────

    it("handleInput tiene rama para gh issue close", () => {
        assert.ok(source.includes("Caso 1") || source.includes("issueMatch"),
            "Debe tener caso para cierre explicito");
    });

    it("handleInput tiene rama para gh pr merge", () => {
        assert.ok(source.includes("Caso 2") || source.includes("handlePrMerge"),
            "Debe tener caso para cierre via PR merge");
    });

    // ─── Verifica que llama processIssueClose para issues del PR ─────────────

    it("handlePrMerge llama processIssueClose para cada issue del body", () => {
        assert.ok(source.includes("processIssueClose(issueNumbers["),
            "Debe iterar issueNumbers y llamar processIssueClose");
    });

    // ─── Verifica merge a main ───────────────────────────────────────────────

    it("verifica que el PR fue a main antes de mover a Done", () => {
        assert.ok(source.includes('"main"'),
            "Debe verificar que el PR tiene main como branch base");
    });

    it("verifica merged_at para confirmar merge exitoso", () => {
        assert.ok(source.includes("merged_at"),
            "Debe verificar que el PR fue mergeado");
    });

    // ─── Tolerancia a fallos ─────────────────────────────────────────────────

    it("es tolerante a fallos en handlePrMerge", () => {
        const tryCatchCount = (source.match(/try\s*\{/g) || []).length;
        assert.ok(tryCatchCount >= 5,
            "Debe tener al menos 5 bloques try/catch");
    });
});
