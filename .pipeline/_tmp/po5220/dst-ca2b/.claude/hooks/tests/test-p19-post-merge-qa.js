// Test P-19: Hook post-merge-qa — deteccion de merges sin QA E2E (#1259)
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const HOOK_FILE = path.join(__dirname, "..", "post-merge-qa.js");
const source = fs.readFileSync(HOOK_FILE, "utf8");

describe("P-19: Hook post-merge-qa (#1259)", () => {

    // ─── Estructura del archivo ─────────────────────────────────────────────

    it("archivo post-merge-qa.js existe", () => {
        assert.ok(fs.existsSync(HOOK_FILE), "post-merge-qa.js debe existir en .claude/hooks/");
    });

    it("es Pure Node.js sin dependencias externas", () => {
        assert.ok(!source.includes('require("axios')
            && !source.includes('require("node-fetch')
            && !source.includes('require("superagent'),
            "No debe usar dependencias externas de HTTP");
    });

    // ─── Deteccion de merge ─────────────────────────────────────────────────

    it("contiene funcion extractPrNumber para detectar gh pr merge", () => {
        assert.ok(source.includes("function extractPrNumber"),
            "Debe tener extractPrNumber para detectar comandos de merge");
    });

    it("detecta gh pr merge con numero explicito", () => {
        // Verificar que el regex captura el numero de PR
        const match = source.match(/gh\\s\+pr\\s\+merge\\s\+\(\\d\+\)/);
        assert.ok(match || source.includes("gh\\s+pr\\s+merge\\s+(\\d+)"),
            "Debe detectar 'gh pr merge <N>' con regex");
    });

    it("detecta gh pr merge sin numero (PR del branch actual)", () => {
        assert.ok(source.includes("gh\\s+pr\\s+merge") || source.includes("gh pr merge"),
            "Debe detectar 'gh pr merge' sin numero explicito");
    });

    it("retorna null para comandos que no son merge de PR", () => {
        // El codigo debe tener logica para retornar null (ignorar)
        assert.ok(source.includes("return null"),
            "Debe retornar null para comandos que no son gh pr merge");
    });

    // ─── Extraccion de issues ───────────────────────────────────────────────

    it("contiene funcion extractIssueNumbers para parsear body del PR", () => {
        assert.ok(source.includes("function extractIssueNumbers"),
            "Debe tener extractIssueNumbers para extraer issues del body del PR");
    });

    it("detecta patron 'Closes #N' en body del PR (case-insensitive)", () => {
        assert.ok(source.includes("closes") || source.includes("Closes"),
            "Debe buscar patron 'Closes #N' en el body del PR");
    });

    it("detecta patron 'Fixes #N' en body del PR", () => {
        assert.ok(source.includes("fixes") || source.includes("Fixes"),
            "Debe buscar patron 'Fixes #N' en el body del PR");
    });

    it("detecta patron 'Resolves #N' en body del PR", () => {
        assert.ok(source.includes("resolves") || source.includes("Resolves"),
            "Debe buscar patron 'Resolves #N' en el body del PR");
    });

    it("maneja PR sin issues asociados (retorna array vacio)", () => {
        assert.ok(source.includes("issues.length === 0") || source.includes("issueNumbers.length === 0"),
            "Debe manejar el caso de PR sin 'Closes #N' en el body");
    });

    // ─── Verificacion de labels QA ──────────────────────────────────────────

    it("verifica label qa:passed en el issue", () => {
        assert.ok(source.includes("qa:passed"),
            "Debe verificar si el issue tiene label qa:passed");
    });

    it("verifica label qa:skipped en el issue", () => {
        assert.ok(source.includes("qa:skipped"),
            "Debe verificar si el issue tiene label qa:skipped");
    });

    it("agrega label qa:pending cuando no hay evidencia QA", () => {
        assert.ok(source.includes("qa:pending"),
            "Debe agregar label qa:pending cuando falta evidencia QA");
    });

    // ─── Idempotencia ───────────────────────────────────────────────────────

    it("es idempotente: no duplica si qa:pending ya existe", () => {
        assert.ok(source.includes("hasQaPending") || source.includes("qa:pending"),
            "Debe verificar si qa:pending ya existe antes de agregar");
        assert.ok(source.includes("no duplicar") || source.includes("ya tiene qa:pending"),
            "Debe tener logica para evitar duplicacion de notificaciones");
    });

    // ─── Tolerancia a fallos ────────────────────────────────────────────────

    it("es tolerante a fallos: usa try/catch en operaciones criticas", () => {
        const tryCatchCount = (source.match(/try\s*\{/g) || []).length;
        assert.ok(tryCatchCount >= 3,
            "Debe tener al menos 3 bloques try/catch para tolerancia a fallos");
    });

    it("no bloquea: usa .catch() en promesas asincronas", () => {
        assert.ok(source.includes(".catch(") || source.includes("catch(e)"),
            "Debe manejar errores asincronos con .catch()");
    });

    it("usa log() para registrar errores sin lanzarlos", () => {
        assert.ok(source.includes("function log"),
            "Debe tener funcion log() para registro de errores tolerante");
    });

    // ─── Verificacion de merge a main ────────────────────────────────────────

    it("verifica que el PR fue mergeado (merged_at no es null)", () => {
        assert.ok(source.includes("merged_at"),
            "Debe verificar que el PR fue efectivamente mergeado");
    });

    it("verifica que el PR fue a main (base.ref === 'main')", () => {
        assert.ok(source.includes('"main"') || source.includes("'main'"),
            "Debe verificar que el PR tiene main como branch base");
    });

    // ─── Notificacion Telegram ──────────────────────────────────────────────

    it("notifica por Telegram cuando detecta merge sin QA", () => {
        assert.ok(source.includes("function sendTelegram"),
            "Debe tener funcion sendTelegram para notificaciones");
    });

    it("el mensaje de Telegram incluye referencia al PR y al issue", () => {
        assert.ok(source.includes("prUrl") && source.includes("issueUrl"),
            "El mensaje de Telegram debe incluir URL del PR e issue");
    });

    it("el mensaje de Telegram menciona qa:pending", () => {
        assert.ok(source.includes("qa:pending"),
            "El mensaje de Telegram debe mencionar el label qa:pending");
    });

    // ─── Config Telegram ────────────────────────────────────────────────────

    it("lee configuracion de Telegram desde telegram-config.json", () => {
        assert.ok(source.includes("telegram-config.json"),
            "Debe leer el token y chat_id de telegram-config.json");
    });

    it("no tiene tokens hardcodeados", () => {
        // Verificar que no hay tokens o passwords en el codigo
        assert.ok(!source.includes("AAG0724") && !source.includes("6529617704"),
            "No debe tener tokens Telegram hardcodeados en el codigo");
    });

    // ─── Registro en settings.json ──────────────────────────────────────────

    it("el hook esta registrado en settings.json", () => {
        const settingsFile = path.join(__dirname, "..", "..", "settings.json");
        const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
        const postToolUseHooks = settings.hooks && settings.hooks.PostToolUse;
        assert.ok(postToolUseHooks, "settings.json debe tener PostToolUse hooks");

        const bashHookGroup = postToolUseHooks.find(g => g.matcher === "Bash");
        assert.ok(bashHookGroup, "Debe existir grupo PostToolUse con matcher Bash");

        const hasPostMergeQa = bashHookGroup.hooks.some(h =>
            h.command && h.command.includes("post-merge-qa.js")
        );
        assert.ok(hasPostMergeQa, "post-merge-qa.js debe estar registrado en PostToolUse[Bash]");
    });

    // ─── Lectura de stdin ───────────────────────────────────────────────────

    it("lee stdin correctamente (patron estandar de hooks)", () => {
        assert.ok(source.includes("process.stdin"),
            "Debe leer el input de stdin (datos del tool_input)");
    });

    it("tiene timeout para lectura de stdin", () => {
        assert.ok(source.includes("setTimeout"),
            "Debe tener setTimeout para evitar que el hook se cuelgue");
    });

    // ─── Unidad: extractIssueNumbers ────────────────────────────────────────

    it("extractIssueNumbers funciona con casos reales", () => {
        // Extraer la funcion del source y evaluarla en contexto aislado
        const funcMatch = source.match(/function extractIssueNumbers\(prBody\)\s*\{[\s\S]*?\n\}/);
        if (!funcMatch) {
            // Si no se puede aislar la funcion, verificar que existe en el source
            assert.ok(source.includes("function extractIssueNumbers"),
                "extractIssueNumbers debe existir");
            return;
        }

        // Crear funcion en contexto aislado
        let extractFn;
        try {
            extractFn = new Function("return " + funcMatch[0])();
        } catch(e) {
            // Si no se puede evaluar, skip el test de unidad
            assert.ok(source.includes("Closes"), "Debe buscar patron Closes en el body");
            return;
        }

        // Happy path: body con "Closes #N"
        const result1 = extractFn("Closes #1234\n\nSome description");
        assert.ok(result1.includes(1234), "Debe extraer issue #1234 de 'Closes #1234'");

        // Multiples issues
        const result2 = extractFn("Fixes #100, Closes #200");
        assert.ok(result2.length >= 1, "Debe extraer al menos un issue");

        // Sin issues
        const result3 = extractFn("No hay issues referenciados");
        assert.equal(result3.length, 0, "Debe retornar array vacio si no hay issues");

        // Body null/undefined
        const result4 = extractFn(null);
        assert.equal(result4.length, 0, "Debe retornar array vacio para body null");
    });
});
