// =============================================================================
// screenshots-mockup-gate.test.js — Tests del hook (#3381 · CA-9/10/11/12/17)
//
// Cobertura crítica:
//   - Flag OFF (default): siempre disabled.
//   - Scope: app:* y area:pipeline con archivos dashboard.
//   - Exención: ux:no-visual + area:pipeline sin dashboard.
//   - Sección válida: ambos requeridos (actual o sin-baseline) + esperado.
//   - Anti-ReDoS: body sintético de 65k chars termina en <100ms.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const gate = require('../screenshots-mockup-gate');

// -----------------------------------------------------------------------------
// Flag OFF — default
// -----------------------------------------------------------------------------

test('flag OFF (undefined): evaluate devuelve disabled', () => {
    const result = gate.evaluate({ labels: [{ name: 'app:client' }], body: '' }, { flag: undefined });
    assert.equal(result.gate, 'disabled');
});

test('flag OFF (explicit 0): disabled', () => {
    const result = gate.evaluate({ labels: [{ name: 'app:client' }], body: '' }, { flag: '0' });
    assert.equal(result.gate, 'disabled');
});

// -----------------------------------------------------------------------------
// Scope (CA-9 / CA-11)
// -----------------------------------------------------------------------------

test('scope: issue sin labels → out-of-scope', () => {
    const r = gate.evaluate({ labels: [], body: 'cualquier cosa' }, { flag: '1' });
    assert.equal(r.gate, 'out-of-scope');
});

test('scope: app:client en scope', () => {
    const r = gate.evaluate({ labels: [{ name: 'app:client' }], body: '' }, { flag: '1' });
    assert.equal(r.gate, 'block'); // sin sección → block
});

test('scope: app:business en scope', () => {
    const r = gate.evaluate({ labels: [{ name: 'app:business' }], body: '' }, { flag: '1' });
    assert.equal(r.gate, 'block');
});

test('scope: app:delivery en scope', () => {
    const r = gate.evaluate({ labels: [{ name: 'app:delivery' }], body: '' }, { flag: '1' });
    assert.equal(r.gate, 'block');
});

test('scope CA-11: area:pipeline SIN dashboard archivos → out-of-scope', () => {
    const r = gate.evaluate({
        labels: [{ name: 'area:pipeline' }],
        body: 'Cambio en .pipeline/lib/foo.js sin UI',
    }, { flag: '1' });
    assert.equal(r.gate, 'out-of-scope');
});

test('scope CA-11: area:pipeline CON dashboard-v2.js → en scope', () => {
    const r = gate.evaluate({
        labels: [{ name: 'area:pipeline' }],
        body: 'Cambio en dashboard-v2.js que afecta la UI',
    }, { flag: '1' });
    assert.equal(r.gate, 'block');
});

// -----------------------------------------------------------------------------
// Scope por mockup versionado (issue #4568 · CA-1/CA-2) — cierra escape #4531
// -----------------------------------------------------------------------------

test('mockup versionado: issue area:dashboard SIN app:* con imagen de mockup → en scope', () => {
    // Reproduce el escape #4531: label de área interna, sin app:*, pero con
    // un mockup PNG versionado en el body. Antes quedaba out-of-scope.
    const body = [
        '## Comparativa (actual vs propuesta)',
        '![Propuesta](https://raw.githubusercontent.com/intrale/platform/dc0e7f6/.pipeline/assets/mockups/header-mizpa/propuesta.png)',
    ].join('\n');
    const r = gate.evaluate({
        labels: [{ name: 'area:dashboard' }, { name: 'area:pipeline' }],
        body,
    }, { flag: '1' });
    assert.equal(r.gate, 'block'); // en scope pero sin sección → block
    assert.equal(r.scope, 'versioned-mockup');
});

test('mockup versionado: ruta relativa .pipeline/assets/mockups/*.svg → en scope', () => {
    const body = 'Mockup versionado en `.pipeline/assets/mockups/sysstatus/propuesta-compacta.svg`.';
    const r = gate.evaluate({ labels: [{ name: 'bug' }], body }, { flag: '1' });
    assert.equal(r.gate, 'block');
    assert.equal(r.scope, 'versioned-mockup');
});

test('mockup versionado: dir de proceso mockups/<n>/ SIN imagen → NO dispara (guru riesgo #2)', () => {
    // Los dirs mockups/4502/ son entregables UX de proceso/backend, no rediseños
    // de UI. Referenciar el dir (sin archivo de imagen) NO debe activar el gate.
    const body = 'Entregables UX en `.pipeline/assets/mockups/4502/` (definición de proceso).';
    const r = gate.evaluate({ labels: [{ name: 'area:infra' }], body }, { flag: '1' });
    assert.equal(r.gate, 'out-of-scope');
});

test('mockup versionado: .md narrativo bajo mockups/ NO dispara (no es imagen)', () => {
    const body = 'Ver `.pipeline/assets/mockups/narrativa-roadmap-olas.md`.';
    const r = gate.evaluate({ labels: [{ name: 'area:pipeline' }], body }, { flag: '1' });
    assert.equal(r.gate, 'out-of-scope');
});

test('mockup versionado: sección completa con mockup → ok con scope versioned-mockup', () => {
    const body = [
        '![propuesta](https://raw.githubusercontent.com/intrale/platform/abc/.pipeline/assets/mockups/header-mizpa/propuesta.png)',
        '## Screenshots & Mockups',
        '- estado actual: ![actual](url)',
        '- estado esperado (mockup): ![mockup](url)',
    ].join('\n');
    const r = gate.evaluate({ labels: [{ name: 'area:dashboard' }], body }, { flag: '1' });
    assert.equal(r.gate, 'ok');
    assert.equal(r.scope, 'versioned-mockup');
});

test('mockup versionado: opt-out ux:no-visual sigue teniendo prioridad', () => {
    const body = '![m](https://x/.pipeline/assets/mockups/foo/bar.png)';
    const r = gate.evaluate({
        labels: [{ name: 'area:dashboard' }, { name: 'ux:no-visual' }],
        body,
    }, { flag: '1' });
    assert.equal(r.gate, 'opted-out');
});

test('hasVersionedMockup: helper aislado', () => {
    assert.equal(gate.hasVersionedMockup('foo mockups/x/y.png bar'), true);
    assert.equal(gate.hasVersionedMockup('foo mockups/x/y.PNG bar'), true);
    assert.equal(gate.hasVersionedMockup('foo mockups/4502/ dir'), false);
    assert.equal(gate.hasVersionedMockup('foo mockups/x/y.md'), false);
    assert.equal(gate.hasVersionedMockup('sin mockup'), false);
    assert.equal(gate.hasVersionedMockup(''), false);
    assert.equal(gate.hasVersionedMockup(null), false);
});

test('scopeReason: prioridad versioned-mockup sobre app/pipeline', () => {
    const r = gate.scopeReason({
        labels: [{ name: 'app:client' }],
        body: '![m](mockups/x/y.png)',
    });
    assert.equal(r, 'versioned-mockup');
});

test('mockup versionado formatBlockComment menciona exención NO aplica', () => {
    const text = gate.formatBlockComment({
        gate: 'block', scope: 'versioned-mockup',
        reason: 'missing-section', missing: ['## Screenshots & Mockups header'],
    });
    assert.match(text, /mockup versionado/i);
    assert.match(text, /tooling interno/i);
    assert.match(text, /render real/i);
});

// -----------------------------------------------------------------------------
// Opt-out (CA-12)
// -----------------------------------------------------------------------------

test('opt-out: ux:no-visual aún sin sección → opted-out', () => {
    const r = gate.evaluate({
        labels: [{ name: 'app:client' }, { name: 'ux:no-visual' }],
        body: '',
    }, { flag: '1' });
    assert.equal(r.gate, 'opted-out');
});

// -----------------------------------------------------------------------------
// Sección válida vs incompleta
// -----------------------------------------------------------------------------

test('sección completa: actual + esperado → ok', () => {
    const body = [
        '## Algo previo',
        'X',
        '## Screenshots & Mockups',
        '- estado actual: ![actual](url)',
        '- estado esperado: ![mockup](url)',
        '## Otra sección',
    ].join('\n');
    const r = gate.evaluate({
        labels: [{ name: 'app:client' }],
        body,
    }, { flag: '1' });
    assert.equal(r.gate, 'ok');
});

test('sección con sin-baseline warning + esperado → ok', () => {
    const body = [
        '## Screenshots & Mockups',
        '- Sin baseline visual disponible (primera implementación)',
        '- Mockup esperado: ![mockup](url)',
    ].join('\n');
    const r = gate.evaluate({
        labels: [{ name: 'app:business' }],
        body,
    }, { flag: '1' });
    assert.equal(r.gate, 'ok');
});

test('sección sin "esperado" → block missing expected', () => {
    const body = [
        '## Screenshots & Mockups',
        '- estado actual: ![actual](url)',
    ].join('\n');
    const r = gate.evaluate({
        labels: [{ name: 'app:client' }],
        body,
    }, { flag: '1' });
    assert.equal(r.gate, 'block');
    assert.ok(r.missing.includes('expected'));
});

test('sección sin "actual" ni "sin-baseline" → block missing actual', () => {
    const body = [
        '## Screenshots & Mockups',
        '- estado esperado: ![mockup](url)',
    ].join('\n');
    const r = gate.evaluate({
        labels: [{ name: 'app:client' }],
        body,
    }, { flag: '1' });
    assert.equal(r.gate, 'block');
    assert.ok(r.missing.includes('actual-or-sin-baseline'));
});

test('body sin sección → block missing-section', () => {
    const r = gate.evaluate({
        labels: [{ name: 'app:client' }],
        body: 'cuerpo sin la sección requerida',
    }, { flag: '1' });
    assert.equal(r.gate, 'block');
    assert.equal(r.reason, 'missing-section');
});

test('subheader ### no cierra la sección', () => {
    const body = [
        '## Screenshots & Mockups',
        '### Estado actual',
        '![](url)',
        '### Estado esperado',
        '![mockup](url)',
    ].join('\n');
    const r = gate.evaluate({
        labels: [{ name: 'app:client' }],
        body,
    }, { flag: '1' });
    assert.equal(r.gate, 'ok');
});

// -----------------------------------------------------------------------------
// Anti-ReDoS (CA-10/17) — body de 65k chars debe procesarse en <100ms
// -----------------------------------------------------------------------------

test('anti-ReDoS: body de 65k chars termina en <100ms', () => {
    // Body que intenta forzar backtracking: muchas líneas con "actual"
    // ambiguo + sin sección requerida.
    const bigLine = 'actual baseline esperado mockup '.repeat(50);
    const lines = [];
    for (let i = 0; i < 800; i++) lines.push(bigLine);
    const body = lines.join('\n');
    assert.ok(body.length > 65000, 'body debe superar 65k chars');

    const t0 = Date.now();
    const r = gate.evaluate({
        labels: [{ name: 'app:client' }],
        body,
    }, { flag: '1' });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 100, `evaluate tomó ${elapsed}ms, esperado <100ms`);
    // Resultado funcional: sin header explícito → block missing-section.
    assert.equal(r.gate, 'block');
});

test('anti-ReDoS: hasVersionedMockup con línea de 20k chars "mockups/aaaa…" no congela', () => {
    // Intenta forzar backtracking del cuantificador acotado del regex.
    const line = 'mockups/' + 'a'.repeat(20000) + 'no-ext';
    const t0 = Date.now();
    const r = gate.hasVersionedMockup(line);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 100, `hasVersionedMockup tomó ${elapsed}ms`);
    assert.equal(r, false); // sin extensión de imagen → no matchea
});

test('anti-ReDoS: línea individual de 10k chars no congela', () => {
    const longLine = 'a'.repeat(10000) + ' actual';
    const body = [
        '## Screenshots & Mockups',
        longLine,
        'esperado: foo',
    ].join('\n');
    const t0 = Date.now();
    gate.evaluate({ labels: [{ name: 'app:client' }], body }, { flag: '1' });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 100, `evaluate tomó ${elapsed}ms`);
});

// -----------------------------------------------------------------------------
// formatBlockComment
// -----------------------------------------------------------------------------

test('formatBlockComment: devuelve null si no hay block', () => {
    assert.equal(gate.formatBlockComment({ gate: 'ok' }), null);
    assert.equal(gate.formatBlockComment({ gate: 'disabled' }), null);
});

test('formatBlockComment: incluye prefijo + faltantes + opt-out hint', () => {
    const text = gate.formatBlockComment({
        gate: 'block',
        reason: 'incomplete-section',
        missing: ['actual-or-sin-baseline', 'expected'],
    });
    assert.match(text, /Screenshots & Mockups/);
    assert.match(text, /actual-or-sin-baseline, expected/);
    assert.match(text, /ux:no-visual/);
});

// -----------------------------------------------------------------------------
// Defensa contra inputs malformados
// -----------------------------------------------------------------------------

test('input null → out-of-scope (defensivo)', () => {
    const r = gate.evaluate(null, { flag: '1' });
    assert.equal(r.gate, 'out-of-scope');
});

test('labels malformados se tolera', () => {
    const r = gate.evaluate({
        labels: [null, undefined, 42, { foo: 'bar' }, 'app:client'],
        body: '',
    }, { flag: '1' });
    // 'app:client' como string suelto cuenta como label válido
    assert.equal(r.gate, 'block');
});
