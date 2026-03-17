// Test: telegram-sanitizer.js — Sanitización UTF-8 para Telegram (#1637)
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { sanitize, sanitizeHtml, needsSanitization } = require("../telegram-sanitizer");

describe("telegram-sanitizer: sanitize()", () => {
    it("retorna string vacío para null/undefined", () => {
        assert.equal(sanitize(null), "");
        assert.equal(sanitize(undefined), "");
        assert.equal(sanitize(""), "");
    });

    it("no modifica texto limpio ASCII", () => {
        const text = "Hello world! This is a test 123.";
        assert.equal(sanitize(text), text);
    });

    it("no modifica texto con emojis válidos", () => {
        const text = "Estado: \u2705 OK \ud83d\ude80 Deploy exitoso \ud83d\udcca";
        assert.equal(sanitize(text), text);
    });

    it("no modifica texto con caracteres españoles válidos", () => {
        const text = "Implementación exitosa — configuración actualizada ñ á é í ó ú";
        assert.equal(sanitize(text), text);
    });

    it("preserva \\n, \\r\\n y \\t", () => {
        const text = "Línea 1\nLínea 2\tcon tab";
        assert.equal(sanitize(text), text);
    });

    it("remueve caracteres de control C0 (excepto \\n, \\r, \\t)", () => {
        const text = "Hola\x00mundo\x01test\x07bell";
        const result = sanitize(text, { logWarnings: false });
        assert.equal(result, "Holamundotestbell");
    });

    it("remueve NULL byte (\\u0000)", () => {
        const text = "texto\u0000con\u0000nulls";
        const result = sanitize(text, { logWarnings: false });
        assert.equal(result, "textoconnulls");
    });

    it("remueve caracteres de control C1", () => {
        const text = "texto\u0085con\u008Dcontrol\u009F";
        const result = sanitize(text, { logWarnings: false });
        assert.equal(result, "textoconcontrol");
    });

    it("remueve BOM (U+FEFF)", () => {
        const text = "\uFEFFtexto con BOM";
        const result = sanitize(text, { logWarnings: false });
        assert.equal(result, "texto con BOM");
    });

    it("remueve U+FFFE y U+FFFF", () => {
        const text = "texto\uFFFE\uFFFFfin";
        const result = sanitize(text, { logWarnings: false });
        assert.equal(result, "textofin");
    });

    it("remueve zero-width spaces", () => {
        const text = "texto\u200Bcon\u200Czero\u200Dwidth";
        const result = sanitize(text, { logWarnings: false });
        assert.equal(result, "textoconzerowidth");
    });

    it("remueve word joiner (U+2060)", () => {
        const text = "texto\u2060junto";
        const result = sanitize(text, { logWarnings: false });
        assert.equal(result, "textojunto");
    });

    it("remueve LTR/RTL marks", () => {
        const text = "texto\u200Econ\u200Fmarks";
        const result = sanitize(text, { logWarnings: false });
        assert.equal(result, "textoconmarks");
    });

    it("normaliza CRLF a LF", () => {
        const text = "línea 1\r\nlínea 2\r\nlínea 3";
        const result = sanitize(text, { logWarnings: false });
        assert.equal(result, "línea 1\nlínea 2\nlínea 3");
    });

    it("normaliza \\r sueltos a \\n", () => {
        const text = "línea 1\rlínea 2";
        const result = sanitize(text, { logWarnings: false });
        assert.equal(result, "línea 1\nlínea 2");
    });

    it("colapsa más de 3 líneas vacías consecutivas", () => {
        const text = "párrafo 1\n\n\n\n\n\npárrafo 2";
        const result = sanitize(text, { logWarnings: false });
        assert.equal(result, "párrafo 1\n\n\npárrafo 2");
    });

    it("maneja múltiples problemas combinados", () => {
        const text = "\uFEFF\x00Hola\u200B\u0085mundo\r\ntest";
        const result = sanitize(text, { logWarnings: false });
        assert.equal(result, "Holamundo\ntest");
    });

    it("no modifica markdown de Telegram válido", () => {
        const text = "<b>negrita</b> <i>cursiva</i> <code>código</code>";
        assert.equal(sanitize(text), text);
    });
});

describe("telegram-sanitizer: sanitizeHtml()", () => {
    it("sanitiza caracteres problemáticos en HTML", () => {
        const html = "<b>Hola\x00mundo</b>";
        const result = sanitizeHtml(html, { logWarnings: false });
        assert.equal(result, "<b>Holamundo</b>");
    });

    it("cierra tags HTML huérfanos", () => {
        const html = "<b>texto sin cerrar";
        const result = sanitizeHtml(html, { logWarnings: false });
        assert.ok(result.includes("</b>"), "Debería cerrar el tag <b>");
    });

    it("cierra múltiples tags huérfanos", () => {
        const html = "<b><i>texto";
        const result = sanitizeHtml(html, { logWarnings: false });
        assert.ok(result.includes("</b>"), "Debería cerrar <b>");
        assert.ok(result.includes("</i>"), "Debería cerrar <i>");
    });

    it("no agrega tags extra si ya están balanceados", () => {
        const html = "<b>ok</b> <i>ok</i>";
        const result = sanitizeHtml(html, { logWarnings: false });
        assert.equal(result, html);
    });

    it("maneja tags con atributos (ej: <a href>)", () => {
        const html = '<a href="https://example.com">link';
        const result = sanitizeHtml(html, { logWarnings: false });
        assert.ok(result.includes("</a>"), "Debería cerrar <a>");
    });

    it("retorna string vacío para null", () => {
        assert.equal(sanitizeHtml(null), "");
        assert.equal(sanitizeHtml(undefined), "");
    });

    it("maneja HTML con emojis y caracteres especiales", () => {
        const html = "<b>\u2705 Deploy exitoso</b>\n\ud83d\udcca <i>Métricas</i>";
        const result = sanitizeHtml(html, { logWarnings: false });
        assert.equal(result, html);
    });
});

describe("telegram-sanitizer: needsSanitization()", () => {
    it("retorna false para texto limpio", () => {
        assert.equal(needsSanitization("Hello world"), false);
    });

    it("retorna false para null/undefined", () => {
        assert.equal(needsSanitization(null), false);
        assert.equal(needsSanitization(undefined), false);
    });

    it("retorna true para texto con NULL byte", () => {
        assert.equal(needsSanitization("hola\x00mundo"), true);
    });

    it("retorna true para texto con BOM", () => {
        assert.equal(needsSanitization("\uFEFFtexto"), true);
    });

    it("retorna true para texto con zero-width chars", () => {
        assert.equal(needsSanitization("texto\u200Btest"), true);
    });

    it("retorna true para texto con control C1", () => {
        assert.equal(needsSanitization("texto\u0085test"), true);
    });

    it("retorna false para texto con emojis válidos", () => {
        assert.equal(needsSanitization("\u2705 OK \ud83d\ude80"), false);
    });

    it("retorna false para texto con acentos españoles", () => {
        assert.equal(needsSanitization("Implementación exitosa ñ á é"), false);
    });
});

describe("telegram-sanitizer: integración con telegram-client", () => {
    it("telegram-client.js importa telegram-sanitizer", () => {
        const fs = require("fs");
        const path = require("path");
        const src = fs.readFileSync(path.join(__dirname, "..", "telegram-client.js"), "utf8");
        assert.ok(src.includes('require("./telegram-sanitizer")'), "telegram-client debería importar telegram-sanitizer");
    });

    it("commander/telegram-api.js importa telegram-sanitizer", () => {
        const fs = require("fs");
        const path = require("path");
        const src = fs.readFileSync(path.join(__dirname, "..", "commander", "telegram-api.js"), "utf8");
        assert.ok(src.includes('require("../telegram-sanitizer")'), "telegram-api debería importar telegram-sanitizer");
    });

    it("notify-telegram.js importa telegram-sanitizer", () => {
        const fs = require("fs");
        const path = require("path");
        const src = fs.readFileSync(path.join(__dirname, "..", "notify-telegram.js"), "utf8");
        assert.ok(src.includes('require("./telegram-sanitizer")'), "notify-telegram debería importar telegram-sanitizer");
    });
});
