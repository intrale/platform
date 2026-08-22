// =============================================================================
// Tests narrative-sanitize.js — #3539 (CA-UX-2)
//
// Cubre:
//   - Strip markdown (bold/italic/code/headings/bullets/fences).
//   - Strip emojis (header + decorativos).
//   - Strip HTML comments (envelope del deliverable).
//   - Reemplazo de separador visual ` · ` por pausa natural.
//   - Reemplazo del footer 🔗 URL por frase narrativa.
//   - Reemplazo de URLs sueltas por descriptor (la voz no deletrea).
//   - narrativeSanitizePreview reemplaza el sufijo `_(continúa en el issue)_`.
//   - Defensa ante input no-string.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { narrativeSanitize, narrativeSanitizePreview } = require('../narrative-sanitize');

test('narrativeSanitize devuelve string vacio para input no-string', () => {
    assert.equal(narrativeSanitize(null), '');
    assert.equal(narrativeSanitize(undefined), '');
    assert.equal(narrativeSanitize(123), '');
    assert.equal(narrativeSanitize(''), '');
});

test('CA-UX-2 · strippea HTML comments (envelope deliverable)', () => {
    const text = 'Análisis cerrado.\n\n<!-- pipeline-meta {"issue":3539,"skill":"guru"} -->';
    const out = narrativeSanitize(text);
    assert.equal(out.includes('<!--'), false, 'sin marcadores HTML');
    assert.equal(out.includes('pipeline-meta'), false, 'envelope eliminado');
    assert.match(out, /Análisis cerrado/);
});

test('CA-UX-2 · strippea bold/italic/code inline manteniendo contenido', () => {
    const text = 'El **rechazo** menciona `audio_error` y se _verifica_ con `md5sum`.';
    const out = narrativeSanitize(text);
    assert.equal(out.includes('**'), false);
    assert.equal(out.includes('`'), false);
    assert.match(out, /rechazo/);
    assert.match(out, /audio_error/);
    assert.match(out, /verifica/);
});

test('CA-UX-2 · strippea code fences multilinea sin dejar contenido leído', () => {
    const text = 'Patrón actual:\n```js\nconst x = 1;\n```\nEso es todo.';
    const out = narrativeSanitize(text);
    assert.equal(out.includes('```'), false);
    assert.equal(out.includes('const x'), false, 'el código no se narra');
    assert.match(out, /Patrón actual/);
    assert.match(out, /Eso es todo/);
});

test('CA-UX-2 · strippea headings markdown manteniendo el texto', () => {
    const text = '## Hallazgos\n- punto 1\n- punto 2';
    const out = narrativeSanitize(text);
    assert.equal(out.includes('##'), false);
    assert.match(out, /Hallazgos/);
    assert.match(out, /punto 1/);
});

test('CA-UX-2 · strippea bullets manteniendo el contenido como frase', () => {
    const text = '- hallazgo uno\n- hallazgo dos';
    const out = narrativeSanitize(text);
    assert.equal(out.includes('- '), false);
    assert.match(out, /hallazgo uno/);
    assert.match(out, /hallazgo dos/);
});

test('CA-UX-2 · convierte separador visual ` · ` a pausa natural', () => {
    const text = 'guru · analisis · #3539';
    const out = narrativeSanitize(text);
    assert.equal(out.includes(' · '), false);
    assert.match(out, /guru\. analisis\. #3539/);
});

test('CA-UX-2 · reemplaza footer 🔗 URL por frase narrativa', () => {
    const text = 'Cerré el análisis.\n\n🔗 https://github.com/intrale/platform/issues/3539';
    const out = narrativeSanitize(text);
    assert.equal(out.includes('🔗'), false);
    assert.equal(out.includes('github.com'), false, 'no debe deletrear la URL');
    assert.match(out, /enlace al issue/i);
});

test('CA-UX-2 · reemplaza URLs sueltas por descriptor', () => {
    const text = 'Ver https://docs.intrale.com/pipeline para más detalle.';
    const out = narrativeSanitize(text);
    assert.equal(out.includes('https://'), false);
    assert.match(out, /enlace en el mensaje/i);
});

test('CA-UX-2 · strippea emojis comunes del header del deliverable', () => {
    const text = '🔍 #3539 guru cerró el análisis 🎨📋🗺️';
    const out = narrativeSanitize(text);
    assert.equal(out.includes('🔍'), false);
    assert.equal(out.includes('🎨'), false);
    assert.equal(out.includes('📋'), false);
    assert.equal(out.includes('🗺️'), false);
    assert.match(out, /#3539 guru/);
});

test('CA-UX-2 · colapsa newlines triples o más a uno doble', () => {
    const text = 'Inicio.\n\n\n\nFin.';
    const out = narrativeSanitize(text);
    // Debe haber UNA línea en blanco entre Inicio y Fin (no varias).
    assert.match(out, /Inicio\.\n\nFin\./);
});

test('CA-UX-2 · normaliza espacios redundantes y trim final', () => {
    const text = '  Hola    mundo  \n  con   espacios  ';
    const out = narrativeSanitize(text);
    assert.equal(out.startsWith(' '), false);
    assert.equal(out.endsWith(' '), false);
    assert.equal(out.includes('   '), false);
});

test('CA-UX-2 · narrativeSanitizePreview reemplaza sufijo de truncado', () => {
    const text = 'Resumen breve…\n_(continúa en el issue)_';
    const out = narrativeSanitizePreview(text);
    assert.equal(out.includes('continúa en el issue'), false);
    assert.match(out, /contenido completo está en el issue/);
});

test('CA-UX-2 · cadena complex con todos los patrones', () => {
    const text = [
        '🔍 #3539 · analisis · guru',
        'Notificación de entregable parcial · Issue #3539',
        '',
        '## Hallazgos',
        '- **bold item** con `código`',
        '- _italic item_ con #hashtag',
        '',
        '🔗 https://github.com/intrale/platform/issues/3539',
        '',
        '<!-- pipeline-meta {"issue":3539,"skill":"guru","pipeline":"definicion"} -->',
    ].join('\n');
    const out = narrativeSanitize(text);
    // Lo que NO debe quedar
    assert.equal(out.includes('**'), false);
    assert.equal(out.includes('__'), false);
    assert.equal(out.includes('`'), false);
    assert.equal(out.includes('🔍'), false);
    assert.equal(out.includes('🔗'), false);
    assert.equal(out.includes('<!--'), false);
    assert.equal(out.includes('pipeline-meta'), false);
    assert.equal(out.includes('https://github.com'), false);
    assert.equal(out.includes(' · '), false);
    // Lo que SÍ debe quedar (el contenido narrable)
    assert.match(out, /#3539/);
    assert.match(out, /Hallazgos/);
    assert.match(out, /bold item/);
    assert.match(out, /italic item/);
    assert.match(out, /enlace al issue/i);
});
