// =============================================================================
// Test de integración — interacción de ramas del barrido de cierre (#4507, CA-3)
//
// Regresión del clobber reportado en el rebote de #4507: el enforcement de
// android-dev/dev registra la excepción con el motivo correcto vía
// `upsertDeliverableException`, pero la rama genérica posterior del barrido la
// PISABA con un motivo fijo ("entregable no aplica: cierre sin nota sustantiva")
// porque su condición NO miraba `entregableManejado`. Como comparten la clave
// idempotente `agente::fase`, ganaba el último write.
//
// Los tests previos ejercitaban el guard EN AISLAMIENTO (`evaluateDeliverableClosure`)
// y el índice EN AISLAMIENTO (`upsertDeliverableException`), por eso el clobber
// pasó desapercibido. Este test modela el flujo COMPLETO del barrido usando las
// funciones reales (guard + selectClosureBranch + upsertDeliverableException +
// upsertDeliverableIndex) y asserta que el motivo final del índice es el del
// guard, no el genérico.
//
// `selectClosureBranch` es el MISMO predicado que consume `pulpo.js` para elegir
// la rama, así que este test es autoritativo: si alguien revierte la regla
// anti-clobber, el branch vuelve a 'generic_exception' y el assert falla.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const guard = require('../android-dev-deliverable-guard');
const di = require('../deliverable-index');

const PHASE_ENUM = ['dev', 'analisis', 'criterios'];
const ISSUE = '4507';
const FASE = 'dev';
const AGENTE = 'android-dev';

function mkTmpRoot() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-clobber-test-'));
    const dir = path.join(base, '.pipeline');
    fs.mkdirSync(dir, { recursive: true });
    return {
        root: dir,
        cleanup: () => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} },
    };
}

function readIndexEntries(root) {
    const file = path.join(root, 'deliverables', `${ISSUE}.json`);
    return JSON.parse(fs.readFileSync(file, 'utf8')).entries;
}

/**
 * Reproduce el bloque de enforcement del barrido de pulpo.js para android-dev/dev
 * usando las funciones REALES. Devuelve el estado observable (rama elegida,
 * motivo persistido por el guard) para poder assertar el resultado del índice.
 *
 * Espeja pulpo.js: guard → (si exception|error) upsertDeliverableException +
 * entregableManejado=true → selectClosureBranch → rama genérica sólo si aplica.
 */
function runBarridoClosure(r, root) {
    const sinAdjuntos = !Array.isArray(r.attachments) || r.attachments.length === 0;
    const notasRaw =
        (typeof r.notas === 'string' && r.notas.trim().length > 0) ? r.notas
        : (typeof r.motivo === 'string' && r.motivo.trim().length > 0) ? r.motivo
        : '';
    const esSustantiva = notasRaw.trim().length >= 80;
    let entregableManejado = false;
    let guardMotivo = null;

    const decision = guard.evaluateDeliverableClosure({
        entregableNoAplica: r.entregable_no_aplica,
        attachments: r.attachments,
        notas: r.notas,
        motivo: r.motivo,
    });
    if (decision.action === 'exception' || decision.action === 'error') {
        const rec = di.upsertDeliverableException({
            issue: ISSUE, fase: FASE, agente: AGENTE, motivo: decision.motivo,
            pipelineRoot: root, phaseEnum: PHASE_ENUM,
        });
        guardMotivo = rec.motivo;
        entregableManejado = true;
    }

    const closureBranch = guard.selectClosureBranch({ sinAdjuntos, esSustantiva, entregableManejado });
    if (closureBranch === 'generic_exception') {
        const motivo = notasRaw.trim().length > 0
            ? notasRaw.trim()
            : 'entregable no aplica: cierre sin nota sustantiva';
        di.upsertDeliverableIndex({
            issue: ISSUE, fase: FASE, agente: AGENTE,
            tipo: 'exception', motivo, pipelineRoot: root, phaseEnum: PHASE_ENUM,
        });
    }
    // Rama 'fallback_md' omitida: requiere writeDeliverable + rescan de disco,
    // fuera del scope del clobber (esa rama nunca corre con entregableManejado).

    return { closureBranch, guardMotivo };
}

test('excepción declarada con notas cortas: el motivo del agente NO se pisa por el genérico', (t) => {
    const { root, cleanup } = mkTmpRoot();
    t.after(cleanup);

    const MOTIVO_AGENTE = 'Issue de solo-docs, sin cambios de app Android';
    const { closureBranch, guardMotivo } = runBarridoClosure({
        entregable_no_aplica: MOTIVO_AGENTE,
        attachments: [],
        notas: 'ok', // nota corta → esSustantiva=false (dispara el bug pre-fix)
    }, root);

    // El guard manejó el entregable → la rama genérica NO debe correr.
    assert.equal(closureBranch, 'none');
    assert.equal(guardMotivo, MOTIVO_AGENTE);

    const entries = readIndexEntries(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].motivo, MOTIVO_AGENTE);
    assert.notEqual(entries[0].motivo, 'entregable no aplica: cierre sin nota sustantiva');
});

test('cierre silencioso: el SILENT_CLOSE_MOTIVO accionable NO se pisa por el genérico', (t) => {
    const { root, cleanup } = mkTmpRoot();
    t.after(cleanup);

    const { closureBranch, guardMotivo } = runBarridoClosure({
        entregable_no_aplica: undefined,
        attachments: [],
        notas: 'ok', // sin motivo, sin adjunto, sin nota sustantiva → action:error
    }, root);

    assert.equal(closureBranch, 'none');
    assert.equal(guardMotivo, guard.SILENT_CLOSE_MOTIVO);

    const entries = readIndexEntries(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].motivo, guard.SILENT_CLOSE_MOTIVO);
    assert.notEqual(entries[0].motivo, 'entregable no aplica: cierre sin nota sustantiva');
});

test('skill/fase distinto de android-dev/dev: la rama genérica sigue registrando la excepción', (t) => {
    // Guard-rail: el fix NO debe suprimir la excepción genérica cuando el guard
    // específico no aplica (entregableManejado nunca se setea).
    const { root, cleanup } = mkTmpRoot();
    t.after(cleanup);

    // Simula un cierre sin adjuntos ni nota sustantiva SIN pasar por el guard
    // android-dev/dev (entregableManejado=false).
    const sinAdjuntos = true;
    const esSustantiva = false;
    const closureBranch = guard.selectClosureBranch({ sinAdjuntos, esSustantiva, entregableManejado: false });
    assert.equal(closureBranch, 'generic_exception');

    di.upsertDeliverableIndex({
        issue: ISSUE, fase: FASE, agente: AGENTE,
        tipo: 'exception', motivo: 'entregable no aplica: cierre sin nota sustantiva',
        pipelineRoot: root, phaseEnum: PHASE_ENUM,
    });
    const entries = readIndexEntries(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].motivo, 'entregable no aplica: cierre sin nota sustantiva');
});
