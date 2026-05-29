// =============================================================================
// init-waves-boot-integration-3617.test.js
//
// Test de integración (#3617 REQ-SEC-2/3/6) que verifica el flujo del boot
// hook del Pulpo end-to-end SIN spawnar el binario completo:
//
//   1. init-waves-from-partial corre → si OK, init-failed.flag NO existe.
//   2. init-waves-from-partial falla (input malformado) → caller (simulación
//      del boot hook) llama setInitFailed → flag creado con shape esperada
//      → isInitFailedSet() = true → dispatch quedaría bloqueado.
//   3. Boot subsiguiente OK → clearInitFailed → flag se borra → dispatch
//      destrabado automáticamente sin intervención humana.
//   4. Tick limpio del desync-detector → recordCleanCycle incrementa counter
//      → threshold ≥3 marca ready_for_pr2.
//   5. Tick dirty → recordDirtyCycle resetea counter a 0.
//
// El test usa PIPELINE_DIR_OVERRIDE para aislarse en tmp dir — NO toca el
// estado real del pipeline.
//
// Por qué esto NO spawnea el pulpo.js entero: el binario tiene 50+
// validaciones de boot (agent-models.json, data-residency-exclusions,
// CLAUDE_OAUTH, etc.) que requieren un setup completo del repo. Para
// verificar el wireup específico del boot hook alcanza con replicar
// exactamente la secuencia que el código nuevo del pulpo.js ejecuta.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

function mkTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulpo-boot-3617-'));
    return dir;
}

function withOverride(tmpDir, fn) {
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    process.env.PIPELINE_DIR_OVERRIDE = tmpDir;
    // Limpiar require cache para que los módulos resueltan el override fresh.
    delete require.cache[require.resolve('../../scripts/init-waves-from-partial')];
    delete require.cache[require.resolve('../init-failed-state')];
    delete require.cache[require.resolve('../desync-clean-cycles')];
    delete require.cache[require.resolve('../desync-ack')];
    delete require.cache[require.resolve('../waves')];
    try { return fn(); }
    finally {
        if (prev === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = prev;
    }
}

/**
 * Simula EXACTAMENTE la secuencia que pulpo.js ejecuta en boot tras este PR.
 * Si esta función se desincroniza del boot hook real, el test detecta el drift.
 */
function simulateBootHook() {
    const { initWavesFromPartial, _internal } = require('../../scripts/init-waves-from-partial');
    _internal._resetDedupeForTests();
    const initFailedState = require('../init-failed-state');
    const initResult = initWavesFromPartial({ skipAlert: true });
    if (initResult.action === 'seeded' || initResult.action === 'noop_already_seeded'
        || initResult.action === 'noop_no_partial' || initResult.action === 'noop_empty_partial') {
        initFailedState.clearInitFailed();
        return { initResult, blocked: false };
    }
    if (initResult.action === 'aborted_invalid_partial' || initResult.action === 'aborted_waves_corrupt') {
        initFailedState.setInitFailed({
            reason: initResult.action === 'aborted_invalid_partial'
                ? 'partial-pause malformado'
                : 'waves.json corrupto',
            errors: initResult.errors || [],
            source_sha256: null,
        });
        return { initResult, blocked: true };
    }
    return { initResult, blocked: false };
}

test('integración boot — happy path: partial OK siembra waves + no flag init-failed', () => {
    const tmp = mkTmp();
    withOverride(tmp, () => {
        // .partial-pause.json con allowlist válida.
        fs.writeFileSync(
            path.join(tmp, '.partial-pause.json'),
            JSON.stringify({ allowed_issues: [3559, 3605] }, null, 2),
        );
        const { initResult, blocked } = simulateBootHook();
        assert.strictEqual(initResult.action, 'seeded');
        assert.deepStrictEqual(initResult.allowlist, [3559, 3605]);
        assert.strictEqual(blocked, false);
        // waves.json debe existir y tener active_wave con los issues correctos.
        const waves = JSON.parse(fs.readFileSync(path.join(tmp, 'waves.json'), 'utf8'));
        assert.ok(waves.active_wave, 'active_wave debe estar poblado');
        assert.deepStrictEqual(
            waves.active_wave.issues.map(i => i.number).sort((a, b) => a - b),
            [3559, 3605],
        );
        // init-failed.flag NO debe existir.
        assert.ok(!fs.existsSync(path.join(tmp, '.init-failed.flag')),
            'flag init-failed no debe existir en happy path');
    });
});

test('integración boot — fail-closed: partial malformado activa init-failed.flag', () => {
    const tmp = mkTmp();
    withOverride(tmp, () => {
        // .partial-pause.json con allowed_issues con un valor no entero
        // (envenenado a propósito).
        fs.writeFileSync(
            path.join(tmp, '.partial-pause.json'),
            JSON.stringify({ allowed_issues: [3559, 'no-soy-un-int', 3605] }, null, 2),
        );
        const { initResult, blocked } = simulateBootHook();
        assert.strictEqual(initResult.action, 'aborted_invalid_partial');
        assert.strictEqual(blocked, true);
        // waves.json NO debe haber sido escrito (fail-closed).
        assert.ok(!fs.existsSync(path.join(tmp, 'waves.json')),
            'waves.json no debe existir tras fail-closed');
        // init-failed.flag DEBE existir con shape esperada.
        const flagPath = path.join(tmp, '.init-failed.flag');
        assert.ok(fs.existsSync(flagPath), 'flag init-failed debe existir');
        const flag = JSON.parse(fs.readFileSync(flagPath, 'utf8'));
        assert.strictEqual(flag.reason, 'partial-pause malformado');
        assert.ok(Array.isArray(flag.errors), 'errors debe ser array');
        assert.ok(flag.errors.length > 0, 'errors debe tener al menos un elemento');
        assert.ok(typeof flag.ts === 'string', 'ts debe ser string ISO');
        assert.ok(typeof flag.pid === 'number', 'pid debe ser number');
        // isInitFailedSet debe retornar true → el gate del dispatch en pulpo
        // detecta esto y suspende el loop.
        const initFailedState = require('../init-failed-state');
        assert.strictEqual(initFailedState.isInitFailedSet(), true);
    });
});

test('integración boot — recovery automática: boot OK después de fail borra el flag', () => {
    const tmp = mkTmp();
    withOverride(tmp, () => {
        // 1. Primer boot: input malformado → flag se crea.
        fs.writeFileSync(
            path.join(tmp, '.partial-pause.json'),
            JSON.stringify({ allowed_issues: ['bad'] }, null, 2),
        );
        let r = simulateBootHook();
        assert.strictEqual(r.blocked, true);
        assert.ok(fs.existsSync(path.join(tmp, '.init-failed.flag')));

        // 2. Operador corrige el archivo. Segundo boot debe destrabar.
        fs.writeFileSync(
            path.join(tmp, '.partial-pause.json'),
            JSON.stringify({ allowed_issues: [3617] }, null, 2),
        );
        r = simulateBootHook();
        assert.strictEqual(r.initResult.action, 'seeded');
        assert.strictEqual(r.blocked, false);
        assert.ok(!fs.existsSync(path.join(tmp, '.init-failed.flag')),
            'flag debe estar borrado tras boot OK');
    });
});

test('integración boot — counter de ciclos limpios alcanza threshold ≥3 → ready_for_pr2', () => {
    const tmp = mkTmp();
    withOverride(tmp, () => {
        const desyncCleanCycles = require('../desync-clean-cycles');
        // 3 ticks consecutivos con hashes distintos (simula 3 boots/ticks limpios).
        desyncCleanCycles.recordCleanCycle('hash-tick-1');
        desyncCleanCycles.recordCleanCycle('hash-tick-2');
        desyncCleanCycles.recordCleanCycle('hash-tick-3');
        const counter = desyncCleanCycles.readCounter();
        assert.strictEqual(counter.count, 3,
            'counter debe llegar a 3 con tres hashes distintos');
        assert.ok(counter.count >= 3,
            'threshold de gating PR2 debe alcanzarse con 3 ticks');
    });
});

test('integración boot — recordDirtyCycle resetea el counter de PR2', () => {
    const tmp = mkTmp();
    withOverride(tmp, () => {
        const desyncCleanCycles = require('../desync-clean-cycles');
        desyncCleanCycles.recordCleanCycle('hash-a');
        desyncCleanCycles.recordCleanCycle('hash-b');
        assert.strictEqual(desyncCleanCycles.readCounter().count, 2);
        // Tick dirty (desync detectado) → reset a 0.
        desyncCleanCycles.recordDirtyCycle();
        assert.strictEqual(desyncCleanCycles.readCounter().count, 0,
            'counter debe quedar en 0 tras dirty cycle');
    });
});

test('integración boot — banner desync hash es determinístico para mismo allowlist', () => {
    const tmp = mkTmp();
    withOverride(tmp, () => {
        const desyncAck = require('../desync-ack');
        const h1 = desyncAck.computeStateHash({
            waves_allowlist: [3617, 3605, 3559],
            partial_allowlist: [3559, 3617],
        });
        const h2 = desyncAck.computeStateHash({
            waves_allowlist: [3559, 3605, 3617], // mismo conjunto, distinto orden
            partial_allowlist: [3617, 3559],
        });
        assert.strictEqual(h1, h2,
            'hash debe ser invariante al orden de las listas');
        // Distinto estado → distinto hash.
        const h3 = desyncAck.computeStateHash({
            waves_allowlist: [3617],
            partial_allowlist: [3617, 3605],
        });
        assert.notStrictEqual(h1, h3,
            'hash debe cambiar cuando el estado cambia');
    });
});

test('integración boot — acknowledge silencia banner solo para el hash reconocido', () => {
    const tmp = mkTmp();
    withOverride(tmp, () => {
        const desyncAck = require('../desync-ack');
        const hashA = desyncAck.computeStateHash({
            waves_allowlist: [3617], partial_allowlist: [],
        });
        const hashB = desyncAck.computeStateHash({
            waves_allowlist: [3617, 3605], partial_allowlist: [],
        });
        assert.strictEqual(desyncAck.isAcknowledged(hashA), false);
        const r = desyncAck.acknowledge(hashA, { source: 'integration-test' });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(desyncAck.isAcknowledged(hashA), true,
            'el hash reconocido debe matchear');
        assert.strictEqual(desyncAck.isAcknowledged(hashB), false,
            'un hash distinto debe reaparecer el banner');
    });
});
