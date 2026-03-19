// test-p35-response-summarizer.js — Tests para telegram-response-summarizer.js
// Verifica que el resumidor inteligente cumpla los criterios del issue #1681
"use strict";

const path = require("path");
const summarizer = require(path.join(__dirname, "..", "telegram-response-summarizer"));

let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) {
        console.log("  ✅ " + msg);
        passed++;
    } else {
        console.error("  ❌ FAIL: " + msg);
        failed++;
    }
}

console.log("\n=== test-p35: telegram-response-summarizer ===\n");

// Test 1: isShort — texto corto no necesita resumen
{
    const shortText = "✅ Sprint activo\n\n3 agentes lanzados.";
    assert(summarizer.isShort(shortText), "isShort: texto corto devuelve true");
    assert(!summarizer.isShort("x".repeat(1600)), "isShort: texto largo devuelve false");
}

// Test 2: summarize — texto corto se devuelve sin cambios
{
    const shortText = "✅ Sprint SPR-045 activo — 7 issues\n\n3 agentes lanzados.";
    const result = summarizer.summarize(shortText);
    assert(result === shortText, "summarize: texto corto devuelve igual");
}

// Test 3: summarize — texto largo se resume a <= 1500 chars
{
    const longText = "✅ Sprint SPR-045 activo — 7 issues\n\n" +
        "Slots: #1681, #1650, #1622\nCola: #1600, #1590, #1585, #1570\n\n" +
        "https://github.com/intrale/platform/pull/1234\n" +
        "https://github.com/intrale/platform/pull/1235\n" +
        "C:\Users\Admin\AppData\Local\node\modules\express\index.js\n" +
        "| Issue | Estado | PR | Stream | Tamaño | Labels | Agente |\n" +
        "|-------|--------|-----|--------|--------|--------|--------|\n" +
        "| #1681 | in_progress | PR#123 | infra | M | area:infra | agent/1681 |\n" +
        "| #1650 | pending | - | backend | S | area:backend | - |\n" +
        "| #1622 | done | PR#120 | app | L | app:android | - |\n" +
        "x".repeat(2000);

    const result = summarizer.summarize(longText);
    assert(result.length <= summarizer.MAX_SUMMARY_CHARS, "summarize: resultado <= 1500 chars (got " + result.length + ")");
}

// Test 4: cleanText — elimina URLs
{
    const text = "Resultado OK https://github.com/intrale/platform/pull/123 ver PR";
    const cleaned = summarizer.cleanText(text);
    assert(!cleaned.includes("https://"), "cleanText: URLs eliminadas");
    assert(cleaned.includes("Resultado OK"), "cleanText: contenido útil preservado");
}

// Test 5: cleanText — elimina paths de archivos Windows
{
    const text = "Error en C:\Workspaces\platform\backend\src\Main.kt línea 42";
    const cleaned = summarizer.cleanText(text);
    assert(!cleaned.includes("C:\\"), "cleanText: paths Windows eliminados");
}

// Test 6: cleanText — elimina separadores de tabla markdown
{
    const text = "Tabla:\n| Col1 | Col2 | Col3 | Col4 |\n|------|------|------|------|\n| val1 | val2 | val3 | val4 |\nFin";
    const cleaned = summarizer.cleanText(text);
    assert(!cleaned.includes("|------|"), "cleanText: separadores de tabla eliminados");
}

// Test 7: summarize preserva números de issue
{
    const longText = "Resultados:\n" + "#1681 iniciado\n#1650 pendiente\n#1622 completado\n" +
        "Detalles técnicos extensos: " + "blah ".repeat(300) +
        "\nURLs: https://example.com/very/long/url\n" +
        "Paths: C:\Users\Admin\file.js\n";
    const result = summarizer.summarize(longText);
    assert(result.includes("#168") || result.includes("#165") || result.includes("#162"),
        "summarize: al menos un número de issue preservado");
}

// Test 8: summarize — no null ni undefined
{
    assert(summarizer.summarize(null) === null, "summarize(null) devuelve null");
    assert(summarizer.summarize("") === "", "summarize('') devuelve ''");
    assert(summarizer.summarize(undefined) === undefined, "summarize(undefined) devuelve undefined");
}

console.log("\n=== Resultado: " + passed + " ok, " + failed + " fallados ===\n");
process.exit(failed > 0 ? 1 : 0);
