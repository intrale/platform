// =============================================================================
// quota-content-channel-5455.test.js — Propagación end-to-end del canal de
// CONTENIDO de Anthropic (#5455) por adapter y dispatcher.
//
// El matcher en sí y su matriz positiva/negativa viven en
// `lib/__tests__/quota-exhausted-content-channel-5455.test.js`; el bypass del
// veto y el clamp de TTL en `lib/__tests__/quota-exhausted-reconcile-4865.test.js`.
// Acá se cubre exclusivamente lo que esas suites no pueden ver: que el
// resultado DISCRIMINADO del detector llegue intacto hasta `setFlag`.
//
// Cobertura:
//   1. Adapter: `resetsAt` parseado del TEXTO (el frame no trae `resets_at`),
//      más `source` y `rawExcerpt` redactado.
//   2. Adapter: el contrato previo de los matches ESTRUCTURALES queda intacto.
//   3. Dispatcher: persiste vía `setFlag` con `errorType` dedicado, `resetsAt`
//      y `maxDays: 1/24` — NO degrada al "default safe" `allowlist[0]`.
//   4. Dispatcher: uso EXCLUSIVO de `setFlag`, sin escritura directa del JSON.
//   5. Dispatcher: una mención embebida no activa el tipo dedicado.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dispatcher = require('../dispatch-with-fallback');
const anthropicAdapter = require('../providers/anthropic');
const quota = require('../../quota-exhausted');

const CONTENT_TYPE = 'weekly_limit_content_channel';

// Texto REAL del incidente 2026-08-02 (frame final, sin `is_error` ni
// `error_type`: por eso el path estructural no lo ve).
const AVISO = "You've hit your weekly limit · resets 9pm (America/Buenos_Aires)";

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cc5455-'));
}

function writeLog(lines) {
    const dir = tmpDir();
    const p = path.join(dir, 'agent.log');
    fs.writeFileSync(p, lines.join('\n'));
    return p;
}

const contentFrame = (result) => JSON.stringify({ type: 'result', subtype: 'success', result });

// Envuelve el módulo real de cuota interceptando SÓLO `setFlag`. Todo lo demás
// (detector, allowlists, sanitización) es el código de producción: si el spy
// registra una llamada, el path real la produjo.
function spyQuota() {
    const calls = [];
    const spy = Object.create(quota);
    spy.setFlag = (input) => { calls.push(input); return { flagPath: '/tmp/spy', payload: {} }; };
    spy._setCalls = calls;
    return spy;
}

// -----------------------------------------------------------------------------
// 1-2. Adapter — providers/anthropic.js
// -----------------------------------------------------------------------------

test('#5455 adapter · propaga resetsAt parseado del texto, source y rawExcerpt', () => {
    const logPath = writeLog([contentFrame(AVISO)]);

    const r = anthropicAdapter.detectQuotaExhausted(logPath, null, quota);

    assert.equal(r.matched, true);
    assert.equal(r.errorType, CONTENT_TYPE);
    assert.equal(r.source, 'anthropic-result-content', 'procedencia auditable');
    assert.ok(r.rawExcerpt, 'debe propagar el excerpt redactado');

    // El frame NO trae `evt.resets_at`: si hay ISO, salió del parseo del texto.
    assert.equal(r.evt.resets_at, undefined, 'precondición: el frame no trae resets_at');
    assert.ok(r.resetsAt, 'resetsAt debe venir parseado del texto del aviso');
    assert.ok(!Number.isNaN(Date.parse(r.resetsAt)), 'resetsAt debe ser un ISO válido');
});

test('#5455 adapter · un aviso sin reset propaga resetsAt nulo, sin inventar fecha', () => {
    const logPath = writeLog([contentFrame("You've hit your weekly limit")]);

    const r = anthropicAdapter.detectQuotaExhausted(logPath, null, quota);

    assert.equal(r.matched, true);
    assert.equal(r.errorType, CONTENT_TYPE);
    // `r.resetsAt` cae a `evt.resets_at`, que no existe → undefined/null.
    assert.ok(r.resetsAt == null, 'sin reset en el texto no se inventa fecha');
});

test('#5455 adapter · el contrato de los matches ESTRUCTURALES queda intacto', () => {
    const resetsAt = '2026-08-10T12:00:00.000Z';
    const logPath = writeLog([JSON.stringify({
        type: 'result',
        is_error: true,
        error_type: 'usage_limit_error',
        resets_at: resetsAt,
    })]);

    const r = anthropicAdapter.detectQuotaExhausted(logPath, null, quota);

    assert.equal(r.matched, true);
    assert.equal(r.errorType, 'usage_limit_error');
    assert.equal(r.resetsAt, resetsAt, 'sigue viniendo de evt.resets_at');
    assert.equal(r.source, undefined, 'el path estructural no agrega procedencia');
});

// -----------------------------------------------------------------------------
// 3-5. Dispatcher — dispatch-with-fallback.js
// -----------------------------------------------------------------------------

function runExit(rawOutput, pipelineDir, quotaModule) {
    return dispatcher.onSpawnExit({
        skill: 'commander',
        issue: 5455,
        provider: 'anthropic',
        transport: 'cli',
        rawOutput,
        exitCode: 0,
        durationMs: 5000,
        firstByteAt: 100,
        pipelineDir,
        quotaModule,
    });
}

test('#5455 dispatcher · persiste el tipo dedicado con resetsAt y maxDays de 60 min', () => {
    const dir = tmpDir();
    const spy = spyQuota();

    const res = runExit(contentFrame(AVISO), dir, spy);

    assert.equal(res.errorClass, 'quota_exhausted');
    assert.equal(res.flagSet, true);
    assert.equal(spy._setCalls.length, 1, 'debe persistir exactamente una vez');

    const call = spy._setCalls[0];
    assert.equal(call.provider, 'anthropic');
    // El punto del incidente: sin el path dedicado, `_selectErrorTypeForFlag`
    // degrada al "default safe" `allowlist[0]` (`usage_limit_error`), que el
    // reconcile de #4865 VETA con el adapter sano.
    assert.equal(call.errorType, CONTENT_TYPE, 'no debe degradar a usage_limit_error');
    assert.ok(call.resetsAt, 'el reset viaja YA parseado desde el detector');
    assert.ok(!Number.isNaN(Date.parse(call.resetsAt)));
    assert.equal(call.maxDays, quota.WEEKLY_LIMIT_CONTENT_MAX_DAYS);
    assert.equal(call.maxDays, 1 / 24, 'TTL de 60 minutos');
    assert.ok(call.rawExcerpt, 'excerpt redactado presente');
});

test('#5455 dispatcher · NO escribe quota-exhausted.json fuera de setFlag', () => {
    const dir = tmpDir();
    const spy = spyQuota();

    runExit(contentFrame(AVISO), dir, spy);

    // `setFlag` está interceptado (no escribe). Si apareciera el archivo, algún
    // path lo habría escrito a mano — prohibido por el CA.
    assert.equal(fs.existsSync(path.join(dir, 'quota-exhausted.json')), false,
        'setFlag debe ser el ÚNICO escritor del flag');
});

test('#5455 dispatcher · una mención embebida NO activa el tipo dedicado', () => {
    const dir = tmpDir();
    const spy = spyQuota();

    // Respuesta larga que MENCIONA el aviso: es contenido controlable por el
    // modelo y no debe poder inducir el gate global de Anthropic.
    const largo = 'Analicé el incidente y encontré que el CLI emite el texto '
        + `"${AVISO}" como frame final. Propongo detectarlo con un matcher anclado.`;
    const res = runExit(contentFrame(largo), dir, spy);

    const dedicado = spy._setCalls.filter((c) => c.errorType === CONTENT_TYPE);
    assert.equal(dedicado.length, 0, 'la mención embebida no debe persistir el tipo dedicado');
    assert.equal(res.errorClass !== 'quota_exhausted' || spy._setCalls.length === 0
        || spy._setCalls[0].errorType !== CONTENT_TYPE, true);
});

test('#5455 dispatcher · el frame estructural conserva el selector genérico', () => {
    const dir = tmpDir();
    const spy = spyQuota();

    runExit(JSON.stringify({
        type: 'result',
        is_error: true,
        error_type: 'usage_limit_error',
    }), dir, spy);

    assert.equal(spy._setCalls.length, 1);
    const call = spy._setCalls[0];
    assert.equal(call.errorType, 'usage_limit_error');
    assert.equal(call.maxDays, undefined, 'el clamp de 60 min es exclusivo del canal de contenido');
});
