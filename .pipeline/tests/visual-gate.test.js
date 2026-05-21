// Tests del módulo visual-gate (issue #3383):
//   - Feature flag PIPELINE_VISUAL_GATE_ENABLED (CA-4)
//   - shouldEvaluateVisualGate aplica sólo en desarrollo/build→verificacion con app:*
//   - bypass qa:skipped (CA-3)
//   - copy del comment con marker para idempotencia (CA-UX-2)
//   - commentMarkerPresent detecta posteos previos
//
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    VISUAL_GATE_ENV,
    COMMENT_MARKER,
    NEEDS_VISUAL_BASELINE_LABEL,
    isGateEnabled,
    hasVisualTargetLabel,
    shouldEvaluateVisualGate,
    evaluateVisualGate,
    buildBlockComment,
    commentMarkerPresent,
    buildGateBlockEvent,
} = require('../lib/visual-gate');

// ----- Feature flag (CA-4) -------------------------------------------------

test('isGateEnabled retorna false por default (CA-4 — kill-switch)', () => {
    assert.equal(isGateEnabled({}), false);
    assert.equal(isGateEnabled({ [VISUAL_GATE_ENV]: '0' }), false);
    assert.equal(isGateEnabled({ [VISUAL_GATE_ENV]: '' }), false);
});

test('isGateEnabled retorna true con flag=1', () => {
    assert.equal(isGateEnabled({ [VISUAL_GATE_ENV]: '1' }), true);
});

// ----- hasVisualTargetLabel ------------------------------------------------

test('hasVisualTargetLabel reconoce app:client | app:business | app:delivery', () => {
    assert.equal(hasVisualTargetLabel(['app:client']), true);
    assert.equal(hasVisualTargetLabel(['enhancement', 'app:business']), true);
    assert.equal(hasVisualTargetLabel([{ name: 'app:delivery' }]), true);
});

test('hasVisualTargetLabel ignora labels no-visuales', () => {
    assert.equal(hasVisualTargetLabel(['area:infra']), false);
    assert.equal(hasVisualTargetLabel(['docs', 'area:pipeline']), false);
    assert.equal(hasVisualTargetLabel([]), false);
    assert.equal(hasVisualTargetLabel(null), false);
});

test('hasVisualTargetLabel matchea case-insensitive', () => {
    assert.equal(hasVisualTargetLabel(['APP:Client']), true);
});

// ----- shouldEvaluateVisualGate -------------------------------------------

test('shouldEvaluateVisualGate false cuando flag está apagado', () => {
    assert.equal(
        shouldEvaluateVisualGate({
            pipelineName: 'desarrollo',
            fromFase: 'build',
            toFase: 'verificacion',
            labels: ['app:client'],
            env: {},
        }),
        false,
    );
});

test('shouldEvaluateVisualGate true cuando todas las condiciones se cumplen', () => {
    assert.equal(
        shouldEvaluateVisualGate({
            pipelineName: 'desarrollo',
            fromFase: 'build',
            toFase: 'verificacion',
            labels: ['app:client'],
            env: { [VISUAL_GATE_ENV]: '1' },
        }),
        true,
    );
});

test('shouldEvaluateVisualGate false en pipeline definicion', () => {
    assert.equal(
        shouldEvaluateVisualGate({
            pipelineName: 'definicion',
            fromFase: 'build',
            toFase: 'verificacion',
            labels: ['app:client'],
            env: { [VISUAL_GATE_ENV]: '1' },
        }),
        false,
    );
});

test('shouldEvaluateVisualGate false en transición dev→build', () => {
    assert.equal(
        shouldEvaluateVisualGate({
            pipelineName: 'desarrollo',
            fromFase: 'dev',
            toFase: 'build',
            labels: ['app:client'],
            env: { [VISUAL_GATE_ENV]: '1' },
        }),
        false,
    );
});

test('shouldEvaluateVisualGate false sin label app:*', () => {
    assert.equal(
        shouldEvaluateVisualGate({
            pipelineName: 'desarrollo',
            fromFase: 'build',
            toFase: 'verificacion',
            labels: ['area:pipeline'],
            env: { [VISUAL_GATE_ENV]: '1' },
        }),
        false,
    );
});

// ----- evaluateVisualGate (passthrough a hasVisualReference) ---------------

test('evaluateVisualGate delega a hasVisualReference + retorna su shape', () => {
    const okBody = '## Screenshots & Mockups\n![m](x://1.png)\n![e](x://2.png)\n';
    const r = evaluateVisualGate({ body: okBody, labels: ['app:client'] });
    assert.equal(r.ok, true);
});

test('evaluateVisualGate bypassa qa:skipped (CA-3)', () => {
    const r = evaluateVisualGate({ body: '', labels: ['qa:skipped'] });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'qa-skipped');
});

// ----- buildBlockComment ---------------------------------------------------

test('buildBlockComment incluye el marker para idempotencia (CA-UX-2)', () => {
    const c = buildBlockComment();
    assert.ok(c.includes(COMMENT_MARKER));
});

test('buildBlockComment incluye instrucciones de desbloqueo y qa:skipped', () => {
    const c = buildBlockComment();
    assert.ok(c.includes('Screenshots & Mockups'));
    assert.ok(c.includes('Cómo desbloquear'));
    assert.ok(c.includes('qa:skipped'));
    assert.ok(c.includes('needs:visual-baseline'));
});

test('buildBlockComment no usa tablas (Telegram las rompe — CA-UX §3.2)', () => {
    const c = buildBlockComment();
    // Las tablas markdown usan '|' al inicio de líneas y `---|---` separadores.
    assert.ok(!/^\s*\|/m.test(c), 'no debe haber líneas que empiecen con |');
    assert.ok(!/\|---/.test(c), 'no debe haber separadores de tabla');
});

// ----- commentMarkerPresent -----------------------------------------------

test('commentMarkerPresent detecta el marker en cualquier comment previo', () => {
    assert.equal(
        commentMarkerPresent([
            { body: 'sin marker' },
            { body: `cualquier cosa\n${COMMENT_MARKER}\nmás cosa` },
        ]),
        true,
    );
});

test('commentMarkerPresent retorna false si no hay marker', () => {
    assert.equal(commentMarkerPresent([]), false);
    assert.equal(commentMarkerPresent(null), false);
    assert.equal(commentMarkerPresent([{ body: 'nada relevante' }]), false);
});

// ----- buildGateBlockEvent ------------------------------------------------

test('buildGateBlockEvent emite shape estable para audit log', () => {
    const ev = buildGateBlockEvent({ issue: 1234, reason: 'section-missing', images: 0 });
    assert.equal(ev.event, 'visual-gate-block');
    assert.equal(ev.issue, '1234');
    assert.equal(ev.reason, 'section-missing');
    assert.equal(ev.images, 0);
    assert.equal(ev.decision, 'do-not-promote');
    assert.ok(Array.isArray(ev.action));
});

test('exports estables del módulo (contrato pulpo)', () => {
    assert.equal(NEEDS_VISUAL_BASELINE_LABEL, 'needs:visual-baseline');
    assert.equal(VISUAL_GATE_ENV, 'PIPELINE_VISUAL_GATE_ENABLED');
    assert.ok(typeof COMMENT_MARKER === 'string' && COMMENT_MARKER.includes('visual-gate-block'));
});
