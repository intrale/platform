'use strict';
// =============================================================================
// #6296 — Contrato del módulo que gobierna el desempate por severidad.
//
// Es un módulo chico que gobierna UN GATE: cualquier rama sin cubrir es una vía
// por la que un rechazo grave puede colarse como leve y dejar pasar un defecto.
// Por eso la whitelist se ejercita valor por valor, incluidos los tipos raros.
// =============================================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
    resolveSeverity, resolveSeverityAgregada,
    SEVERIDADES, SKILLS_PISO_GRAVE, GRAVE, LEVE,
} = require('./rejection-severity');

const sev = (yaml, skill = 'qa') => resolveSeverity({ skill, yaml });

// ─── Whitelist cerrada ──────────────────────────────────────────────────────
test('los dos únicos valores declarables son grave y leve', () => {
    assert.deepEqual([...SEVERIDADES], ['grave', 'leve']);
    assert.throws(() => SEVERIDADES.push('critica'), 'la lista está congelada');
});
test('`grave` explícito ⇒ grave', () => {
    assert.equal(sev({ severidad: 'grave' }), GRAVE);
});
test('`leve` explícito ⇒ leve (único camino al carril liviano)', () => {
    assert.equal(sev({ severidad: 'leve' }), LEVE);
});
test('normalización: mayúsculas y espacios no invalidan la declaración', () => {
    assert.equal(sev({ severidad: 'GRAVE ' }), GRAVE);
    assert.equal(sev({ severidad: '  Leve' }), LEVE);
    assert.equal(sev({ severidad: 'LEVE' }), LEVE);
});

// ─── Piso A: fail-closed ante CUALQUIER otra cosa ───────────────────────────
// Un solo `!== 'leve'` implícito haría que varios de estos casos den `grave`
// "de casualidad". La regla es explícita: fuera de la whitelist ⇒ grave.
for (const [nombre, yaml] of [
    ['campo ausente', {}],
    ['null', { severidad: null }],
    ['undefined explícito', { severidad: undefined }],
    ['string vacío', { severidad: '' }],
    ['sólo espacios', { severidad: '   ' }],
    ['número 0', { severidad: 0 }],
    ['número 1', { severidad: 1 }],
    ['boolean', { severidad: true }],
    ['array vacío', { severidad: [] }],
    ['array con leve', { severidad: ['leve'] }],
    ['objeto', { severidad: {} }],
    ['valor desconocido', { severidad: 'critica' }],
    ['casi-leve', { severidad: 'Leve!' }],
    ['prefijo de leve', { severidad: 'levemente cosmético' }],
]) {
    test(`fail-closed: ${nombre} ⇒ grave`, () => {
        assert.equal(sev(yaml), GRAVE);
    });
}
test('fail-closed: YAML ilegible (null/array/string/número) ⇒ grave', () => {
    assert.equal(resolveSeverity({ skill: 'qa', yaml: null }), GRAVE);
    assert.equal(resolveSeverity({ skill: 'qa', yaml: undefined }), GRAVE);
    assert.equal(resolveSeverity({ skill: 'qa', yaml: [] }), GRAVE);
    assert.equal(resolveSeverity({ skill: 'qa', yaml: 'leve' }), GRAVE);
    assert.equal(resolveSeverity({ skill: 'qa', yaml: 42 }), GRAVE);
});
test('fail-closed: llamada sin argumentos ⇒ grave', () => {
    assert.equal(resolveSeverity(), GRAVE);
    assert.equal(resolveSeverity({}), GRAVE);
});

// ─── Piso por skill (invariante de seguridad) ───────────────────────────────
test('piso de security: declara `leve` y la efectiva sigue siendo grave', () => {
    assert.equal(resolveSeverity({ skill: 'security', yaml: { severidad: 'leve' } }), GRAVE);
});
test('piso de security: insensible a mayúsculas del nombre del skill', () => {
    assert.equal(resolveSeverity({ skill: 'SECURITY', yaml: { severidad: 'leve' } }), GRAVE);
    assert.equal(resolveSeverity({ skill: ' Security ', yaml: { severidad: 'leve' } }), GRAVE);
});
test('el piso vive en CÓDIGO, no en config (no se puede bajar sin review)', () => {
    assert.deepEqual([...SKILLS_PISO_GRAVE], ['security']);
    assert.throws(() => SKILLS_PISO_GRAVE.push('qa'), 'la lista está congelada en runtime');
    // Código, no config: el módulo no puede leer nada del disco (ver el test de
    // pureza). Sin `require`, no hay forma de que el piso venga de `config.yaml`.
    const src = fs.readFileSync(path.join(__dirname, 'rejection-severity.js'), 'utf8');
    const sinComentarios = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/require\s*\(/.test(sinComentarios),
        'el módulo no puede leer configuración: el piso sería editable sin review');
});
test('otros validadores SÍ pueden declarar leve (el piso es sólo de security)', () => {
    for (const skill of ['qa', 'tester', 'review', 'po', 'ux']) {
        assert.equal(resolveSeverity({ skill, yaml: { severidad: 'leve' } }), LEVE);
    }
});

// ─── Agregación: un grave gana sobre N leves ────────────────────────────────
test('agregada: un solo grave gana sobre varios leves (nunca se promedia)', () => {
    assert.equal(resolveSeverityAgregada([
        { skill: 'review', yaml: { severidad: 'leve' } },
        { skill: 'po', yaml: { severidad: 'leve' } },
        { skill: 'tester', yaml: { severidad: 'grave' } },
    ]), GRAVE);
});
test('agregada: todos leves ⇒ leve', () => {
    assert.equal(resolveSeverityAgregada([
        { skill: 'review', yaml: { severidad: 'leve' } },
        { skill: 'po', yaml: { severidad: 'leve' } },
    ]), LEVE);
});
test('agregada: lista vacía o inválida ⇒ grave (nada habilita el carril liviano)', () => {
    assert.equal(resolveSeverityAgregada([]), GRAVE);
    assert.equal(resolveSeverityAgregada(null), GRAVE);
    assert.equal(resolveSeverityAgregada('leve'), GRAVE);
});
test('agregada: un security leve declarado arrastra todo el conjunto a grave', () => {
    assert.equal(resolveSeverityAgregada([
        { skill: 'review', yaml: { severidad: 'leve' } },
        { skill: 'security', yaml: { severidad: 'leve' } },
    ]), GRAVE);
});

// ─── Pureza (habilita que el detector siga siendo puro, CA-8) ───────────────
test('pureza: el módulo no requiere NADA (sin fs, sin path, sin config)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'rejection-severity.js'), 'utf8');
    const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    assert.deepEqual(requires, [],
        'si este módulo dejara de ser puro, el detector dejaría de serlo con él');
});

// ─── Procedencia única ──────────────────────────────────────────────────────
test('procedencia: sólo se lee `severidad` del veredicto, nada más lo influye', () => {
    // Un motivo que "declara" severidad en texto libre NO cuenta: el campo es
    // estructurado, igual que el anti-spoof de `veredicto_sintetizado_por`.
    assert.equal(sev({ resultado: 'rechazado', motivo: 'severidad: leve, es un nit' }), GRAVE);
    // Tampoco un campo homónimo anidado (el reporte del skill tiene su propia
    // escala de severidad por hallazgo — vocabulario distinto, no autoritativo).
    assert.equal(sev({ hallazgos: [{ severidad: 'leve' }] }), GRAVE);
});
