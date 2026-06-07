// =============================================================================
// Tests escape-html.js — #3722 (padre #3715, cierra #2901)
//
// Cubre los 6 casos mínimos del CA-2 del issue:
//
//   1. Payload XSS canónico neutralizado en escapeHtmlText.
//   2. escapeHtmlAttr escapa comilla doble (breakout title="...").
//   3. escapeHtmlAttr escapa comilla simple (breakout title='...').
//   4. Contrato text-vs-attr: escapeHtmlText NO escapa comillas literales.
//   5. Coerción defensiva: null/undefined/0/false/objetos no crashean.
//   6. Idempotencia: doble encode no introduce nuevos '<' o '>' literales.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { escapeHtmlText, escapeHtmlAttr } = require('../escape-html');

test('escapeHtmlText escapa el payload XSS canónico <img src=x onerror=alert(1)>', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const out = escapeHtmlText(payload);
    assert.equal(out, '&lt;img src=x onerror=alert(1)&gt;');
    // Garantía operativa: ningún '<' o '>' literal sobrevive.
    assert.equal(out.includes('<'), false);
    assert.equal(out.includes('>'), false);
});

test('escapeHtmlAttr escapa la comilla doble para prevenir breakout de atributo', () => {
    const payload = '" onload="alert(1)';
    const out = escapeHtmlAttr(payload);
    assert.equal(out, '&quot; onload=&quot;alert(1)');
    // Sin comillas dobles literales sobrevive el escape.
    assert.equal(out.includes('"'), false);
});

test('escapeHtmlAttr escapa la comilla simple para prevenir breakout en single-quoted attrs', () => {
    const payload = "' onload='alert(1)";
    const out = escapeHtmlAttr(payload);
    assert.equal(out, '&#39; onload=&#39;alert(1)');
    assert.equal(out.includes("'"), false);
});

test('escapeHtmlText preserva las comillas literales (contrato text vs attr)', () => {
    // En contexto de texto las comillas son seguras; sólo se escapan & < >.
    assert.equal(escapeHtmlText('"hola"'), '"hola"');
    assert.equal(escapeHtmlText("'mundo'"), "'mundo'");
    assert.equal(escapeHtmlText('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
});

test('los helpers aceptan null, undefined, 0, false y objetos sin crashear', () => {
    // null y undefined coercionan a string vacío.
    assert.equal(escapeHtmlText(null), '');
    assert.equal(escapeHtmlText(undefined), '');
    assert.equal(escapeHtmlAttr(null), '');
    assert.equal(escapeHtmlAttr(undefined), '');

    // 0 y false se renderizan como su String() — son datos válidos del operador.
    assert.equal(escapeHtmlText(0), '0');
    assert.equal(escapeHtmlText(false), 'false');
    assert.equal(escapeHtmlAttr(0), '0');
    assert.equal(escapeHtmlAttr(false), 'false');

    // Objetos con toString() se coercionan y luego se escapan.
    const obj = { toString: () => '<x>' };
    assert.equal(escapeHtmlText(obj), '&lt;x&gt;');
    assert.equal(escapeHtmlAttr(obj), '&lt;x&gt;');
});

test('los helpers son idempotentes (double encode no rompe ni introduce XSS)', () => {
    // El segundo pase re-escapa el '&' que introdujo el primero — texto peor
    // pero sin '<' ni '>' literales nuevos. Eso es lo que importa para XSS.
    const onceText = escapeHtmlText('<x>');
    const twiceText = escapeHtmlText(onceText);
    assert.equal(twiceText, '&amp;lt;x&amp;gt;');
    assert.equal(twiceText.includes('<'), false);
    assert.equal(twiceText.includes('>'), false);

    const onceAttr = escapeHtmlAttr('"<x>"');
    const twiceAttr = escapeHtmlAttr(onceAttr);
    assert.equal(twiceAttr.includes('<'), false);
    assert.equal(twiceAttr.includes('>'), false);
    assert.equal(twiceAttr.includes('"'), false);
});
