'use strict';
// =============================================================================
// #6296 — Contrato del módulo que gobierna el desempate por gravedad.
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
test('`gravedad: grave` explícito ⇒ grave', () => {
    assert.equal(sev({ gravedad: 'grave' }), GRAVE);
});
test('`gravedad: leve` explícito ⇒ leve (único camino al carril liviano)', () => {
    assert.equal(sev({ gravedad: 'leve' }), LEVE);
});
test('normalización: mayúsculas y espacios no invalidan la declaración', () => {
    assert.equal(sev({ gravedad: 'GRAVE ' }), GRAVE);
    assert.equal(sev({ gravedad: '  Leve' }), LEVE);
    assert.equal(sev({ gravedad: 'LEVE' }), LEVE);
});

// ─── Piso A: fail-closed ante CUALQUIER otra cosa ───────────────────────────
// Un solo `!== 'leve'` implícito haría que varios de estos casos den `grave`
// "de casualidad". La regla es explícita: fuera de la whitelist ⇒ grave.
for (const [nombre, yaml] of [
    ['campo ausente', {}],
    ['null', { gravedad: null }],
    ['undefined explícito', { gravedad: undefined }],
    ['string vacío', { gravedad: '' }],
    ['sólo espacios', { gravedad: '   ' }],
    ['número 0', { gravedad: 0 }],
    ['número 1', { gravedad: 1 }],
    ['boolean', { gravedad: true }],
    ['array vacío', { gravedad: [] }],
    ['array con leve', { gravedad: ['leve'] }],
    ['objeto', { gravedad: {} }],
    ['valor desconocido', { gravedad: 'critica' }],
    ['casi-leve', { gravedad: 'Leve!' }],
    ['prefijo de leve', { gravedad: 'levemente cosmético' }],
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
    assert.equal(resolveSeverity({ skill: 'security', yaml: { gravedad: 'leve' } }), GRAVE);
});
test('piso de security: insensible a mayúsculas del nombre del skill', () => {
    assert.equal(resolveSeverity({ skill: 'SECURITY', yaml: { gravedad: 'leve' } }), GRAVE);
    assert.equal(resolveSeverity({ skill: ' Security ', yaml: { gravedad: 'leve' } }), GRAVE);
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
        assert.equal(resolveSeverity({ skill, yaml: { gravedad: 'leve' } }), LEVE);
    }
});

// ─── Agregación: un grave gana sobre N leves ────────────────────────────────
test('agregada: un solo grave gana sobre varios leves (nunca se promedia)', () => {
    assert.equal(resolveSeverityAgregada([
        { skill: 'review', yaml: { gravedad: 'leve' } },
        { skill: 'po', yaml: { gravedad: 'leve' } },
        { skill: 'tester', yaml: { gravedad: 'grave' } },
    ]), GRAVE);
});
test('agregada: todos leves ⇒ leve', () => {
    assert.equal(resolveSeverityAgregada([
        { skill: 'review', yaml: { gravedad: 'leve' } },
        { skill: 'po', yaml: { gravedad: 'leve' } },
    ]), LEVE);
});
test('agregada: lista vacía o inválida ⇒ grave (nada habilita el carril liviano)', () => {
    assert.equal(resolveSeverityAgregada([]), GRAVE);
    assert.equal(resolveSeverityAgregada(null), GRAVE);
    assert.equal(resolveSeverityAgregada('leve'), GRAVE);
});
test('agregada: un security leve declarado arrastra todo el conjunto a grave', () => {
    assert.equal(resolveSeverityAgregada([
        { skill: 'review', yaml: { gravedad: 'leve' } },
        { skill: 'security', yaml: { gravedad: 'leve' } },
    ]), GRAVE);
});

// ─── `severidad` NO es alias de `gravedad` (CA-21 / CA-UX-4) ───────────────
// El campo del veredicto es `gravedad`. `severidad` quedó descartado por
// decisión normativa (`ux` en validación + addendum de `po`): ya nombra escalas
// NO binarias en cuatro vocabularios vivos del repo (`ux/SKILL.md`
// critica|alta|media|baja, `security/SKILL.md` critical|high|medium|low,
// `review/SKILL.md`, `roles/linter.md` error). Aceptarlo como alias
// reintroduciría la colisión: un `review` que escriba `severidad: media` —su
// propio léxico— creería estar declarando el veredicto.
//
// Estos tests son la red que impide que el alias vuelva "por comodidad".
test('CA-21: `severidad: leve` NO habilita el carril leve (no hay alias)', () => {
    assert.equal(sev({ severidad: 'leve' }), GRAVE);
});
test('CA-21: `severidad` no se lee ni siquiera si es el único campo declarado', () => {
    for (const valor of ['leve', 'LEVE', ' leve ', 'grave', 'media', 'alta', 'low']) {
        assert.equal(sev({ severidad: valor }), GRAVE,
            `severidad: ${valor} no es una declaración de veredicto`);
    }
});
test('CA-21: con AMBOS campos manda `gravedad` — `severidad` nunca desempata', () => {
    // Si `severidad` tuviera cualquier peso residual, alguno de estos dos daría
    // el resultado del campo equivocado.
    assert.equal(sev({ gravedad: 'leve', severidad: 'grave' }), LEVE);
    assert.equal(sev({ gravedad: 'grave', severidad: 'leve' }), GRAVE);
});
test('CA-21: agregada — un rechazo que sólo trae `severidad: leve` fuerza grave', () => {
    assert.equal(resolveSeverityAgregada([
        { skill: 'review', yaml: { gravedad: 'leve' } },
        { skill: 'tester', yaml: { severidad: 'leve' } },
    ]), GRAVE);
});
test('CA-21: el código NO menciona yaml.severidad (guarda contra el alias)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'rejection-severity.js'), 'utf8');
    const sinComentarios = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(/yaml\.gravedad/.test(sinComentarios), 'el gate debe leer `gravedad`');
    assert.ok(!/yaml\.severidad/.test(sinComentarios),
        'leer `yaml.severidad` reabre la colisión de vocabulario que CA-21 cerró');
});

// ─── Pureza (habilita que el detector siga siendo puro, CA-8) ───────────────
test('pureza: el módulo no requiere NADA (sin fs, sin path, sin config)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'rejection-severity.js'), 'utf8');
    const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    assert.deepEqual(requires, [],
        'si este módulo dejara de ser puro, el detector dejaría de serlo con él');
});

// ─── Procedencia única ──────────────────────────────────────────────────────
test('procedencia: sólo se lee `gravedad` del veredicto, nada más lo influye', () => {
    // Un motivo que "declara" gravedad en texto libre NO cuenta: el campo es
    // estructurado, igual que el anti-spoof de `veredicto_sintetizado_por`.
    assert.equal(sev({ resultado: 'rechazado', motivo: 'gravedad: leve, es un nit' }), GRAVE);
    // Tampoco un campo homónimo anidado, se llame como se llame: el reporte del
    // skill tiene su propia escala por hallazgo — vocabulario distinto, no
    // autoritativo sobre el veredicto completo.
    assert.equal(sev({ hallazgos: [{ gravedad: 'leve' }] }), GRAVE);
    assert.equal(sev({ hallazgos: [{ severidad: 'leve' }] }), GRAVE);
});
