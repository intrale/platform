// =============================================================================
// Tests para skills-deterministicos/report.js — Issue #2904
//
// Cobertura del skill wrapper:
//   - runReport() sin sección devuelve menú de ayuda (CA-2)
//   - runReport('invalida') devuelve menú de ayuda (CA-3)
//   - runReport('cuota') devuelve markdown válido (CA-1)
//   - splitMessage del reporte resulta en N mensajes válidos
//   - buildFallbacks produce HTML escapado correcto (TR-4)
//   - VALID_SECTIONS y HELP_MENU reexportados desde el skill
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const skill = require('../report');

test('runReport() sin sección devuelve help', async () => {
    const r = await skill.runReport();
    assert.equal(r.status, 'help');
    assert.ok(Array.isArray(r.messages));
    assert.match(r.messages[0], /Reportes Pipeline V3/);
});

test('runReport con sección inválida devuelve help (CA-3)', async () => {
    const r = await skill.runReport('zzz-no-existe');
    assert.equal(r.status, 'help');
    assert.match(r.messages[0], /Reportes Pipeline V3/);
});

test('runReport(cuota) devuelve report ok con messages no vacío (CA-1)', async () => {
    const r = await skill.runReport('cuota');
    assert.equal(r.status, 'ok');
    assert.equal(r.section, 'cuota');
    assert.ok(Array.isArray(r.messages));
    assert.ok(r.messages.length >= 1);
    assert.ok(r.messages[0].length > 0);
});

test('runReport(all) devuelve report ok (CA-1)', async () => {
    const r = await skill.runReport('all');
    assert.equal(r.status, 'ok');
    assert.equal(r.section, 'all');
});

test('runReport(sprint) devuelve report ok (CA-1)', async () => {
    const r = await skill.runReport('sprint');
    assert.equal(r.status, 'ok');
});

test('VALID_SECTIONS re-exportado coincide con lista canónica', () => {
    assert.deepEqual(
        [...skill.VALID_SECTIONS].sort(),
        ['agentes', 'all', 'cuota', 'pipeline', 'rebotes', 'sistema', 'sprint']
    );
});

test('HELP_MENU re-exportado contiene los 7 subcomandos', () => {
    for (const s of skill.VALID_SECTIONS) {
        assert.match(skill.HELP_MENU, new RegExp(s));
    }
});

// -----------------------------------------------------------------------------
// buildFallbacks — TR-4: HTML escape para fallback cuando MarkdownV2 falla
// -----------------------------------------------------------------------------

test('buildFallbacks envuelve cuerpo en <pre> (TR-4)', () => {
    const md = 'hola';
    const { html } = skill.buildFallbacks(md);
    assert.match(html, /<pre>hola<\/pre>/);
});

test('buildFallbacks escapa caracteres HTML peligrosos', () => {
    const md = 'a<script>alert(1)</script>b';
    const { html } = skill.buildFallbacks(md);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
});

test('buildFallbacks desescapa MarkdownV2 antes del HTML escape', () => {
    // Caracteres MD V2 escapados deben desescaparse, sino el HTML queda con
    // backslashes inservibles que ensucian el render.
    const md = 'sistema \\- ok';
    const { html } = skill.buildFallbacks(md);
    assert.match(html, /sistema - ok/);
    assert.doesNotMatch(html, /\\-/);
});

test('buildFallbacks NO ejecuta HTML cuando el MD trae backticks', () => {
    const md = '`#1234`';
    const { html } = skill.buildFallbacks(md);
    // El cuerpo va envuelto en `<pre>...</pre>` y solo esos dos tags están
    // permitidos. Cualquier otro tag inyectado sería un escape failure.
    assert.match(html, /^<pre>`#1234`<\/pre>$/);
});

// -----------------------------------------------------------------------------
// Mensajes nunca exceden 4096 chars (límite Telegram)
// -----------------------------------------------------------------------------

test('runReport: ningún chunk excede 4096 chars (límite Telegram)', async () => {
    for (const section of skill.VALID_SECTIONS) {
        const r = await skill.runReport(section);
        for (const m of r.messages) {
            assert.ok(m.length <= 4096, `${section}: chunk de ${m.length} chars supera 4096`);
        }
    }
});
