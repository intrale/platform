// =============================================================================
// Tests android-dev-deliverable-guard.js — #4507
//
// Cubre la decisión pura de enforcement del entregable obligatorio para el
// cierre `dev`/`android-dev`:
//   - `exception` cuando el agente declara `entregable_no_aplica`.
//   - `ok` cuando hay adjunto físico o notas sustantivas (≥80 chars).
//   - `error` (cierre silencioso) cuando no hay ni adjunto, ni nota sustantiva,
//     ni motivo declarado.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const guard = require('../android-dev-deliverable-guard');

test('entregable_no_aplica declarado → action:exception con el motivo trimmeado', () => {
    const out = guard.evaluateDeliverableClosure({
        entregableNoAplica: '  Issue de solo-docs, sin cambios de app  ',
        attachments: [],
        notas: '',
    });
    assert.equal(out.action, 'exception');
    assert.equal(out.motivo, 'Issue de solo-docs, sin cambios de app');
});

test('hay adjunto físico → action:ok (has_attachment), aunque no haya notas', () => {
    const out = guard.evaluateDeliverableClosure({
        entregableNoAplica: undefined,
        attachments: [{ type: 'document', path: 'x.md' }],
        notas: '',
    });
    assert.equal(out.action, 'ok');
    assert.equal(out.reason, 'has_attachment');
});

test('notas sustantivas (≥80 chars) → action:ok (substantive_notes)', () => {
    const out = guard.evaluateDeliverableClosure({
        entregableNoAplica: undefined,
        attachments: [],
        notas: 'a'.repeat(80),
    });
    assert.equal(out.action, 'ok');
    assert.equal(out.reason, 'substantive_notes');
});

test('cierre silencioso (sin adjunto, sin nota sustantiva, sin motivo) → action:error', () => {
    const out = guard.evaluateDeliverableClosure({
        entregableNoAplica: undefined,
        attachments: [],
        notas: 'ok',
    });
    assert.equal(out.action, 'error');
    assert.equal(out.motivo, guard.SILENT_CLOSE_MOTIVO);
});

test('motivo (fallback de notas) sustantivo también cuenta como ok', () => {
    const out = guard.evaluateDeliverableClosure({
        entregableNoAplica: undefined,
        attachments: [],
        notas: '',
        motivo: 'b'.repeat(120),
    });
    assert.equal(out.action, 'ok');
    assert.equal(out.reason, 'substantive_notes');
});

test('entregable_no_aplica no-string se ignora (cae a error si nada más aplica)', () => {
    const out = guard.evaluateDeliverableClosure({
        entregableNoAplica: true,
        attachments: [],
        notas: '',
    });
    assert.equal(out.action, 'error');
});

test('la excepción declarada gana sobre notas sustantivas', () => {
    const out = guard.evaluateDeliverableClosure({
        entregableNoAplica: 'no aplica',
        attachments: [],
        notas: 'a'.repeat(200),
    });
    assert.equal(out.action, 'exception');
});

// -----------------------------------------------------------------------------
// selectClosureBranch — regla anti-clobber #4507 (CA-3)
//
// El barrido de pulpo.js usa este predicado para elegir la rama. La regla
// crítica: `entregableManejado` (el guard ya escribió el índice) bloquea AMBAS
// ramas genéricas, no sólo la del fallback `.md`. Antes del fix, la rama de
// excepción genérica sólo miraba `sinAdjuntos && !esSustantiva`, así que corría
// igual y pisaba el motivo del guard por "último-write-gana".
// -----------------------------------------------------------------------------

test('selectClosureBranch: sin manejar + notas sustantivas → fallback_md', () => {
    assert.equal(
        guard.selectClosureBranch({ sinAdjuntos: true, esSustantiva: true, entregableManejado: false }),
        'fallback_md',
    );
});

test('selectClosureBranch: sin manejar + notas no sustantivas → generic_exception', () => {
    assert.equal(
        guard.selectClosureBranch({ sinAdjuntos: true, esSustantiva: false, entregableManejado: false }),
        'generic_exception',
    );
});

test('selectClosureBranch: guard ya manejó (excepción declarada, notas cortas) → none, NO generic_exception', () => {
    // Caso típico android-dev/dev: excepción declarada con notas originales cortas
    // → esSustantiva=false. Sin el fix esto habría dado 'generic_exception' y
    // pisado el motivo del guard. Con el fix, entregableManejado bloquea la rama.
    assert.equal(
        guard.selectClosureBranch({ sinAdjuntos: true, esSustantiva: false, entregableManejado: true }),
        'none',
    );
});

test('selectClosureBranch: guard ya manejó (cierre silencioso) → none', () => {
    assert.equal(
        guard.selectClosureBranch({ sinAdjuntos: true, esSustantiva: true, entregableManejado: true }),
        'none',
    );
});

test('selectClosureBranch: hay adjuntos → none (el flujo normal cubre el entregable)', () => {
    assert.equal(
        guard.selectClosureBranch({ sinAdjuntos: false, esSustantiva: false, entregableManejado: false }),
        'none',
    );
});
