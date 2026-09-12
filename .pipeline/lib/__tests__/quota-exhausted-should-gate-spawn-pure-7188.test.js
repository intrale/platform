// =============================================================================
// quota-exhausted-should-gate-spawn-pure-7188.test.js — `shouldGateSpawn` es un
// PREDICADO: decide, no escribe.
//
// QUÉ FIJA ESTA SUITE
// -------------------
// #7181 metió dentro de `shouldGateSpawn` una llamada a
// `quota-reset-reconcile.reconcileCodexReset`, que persiste su throttle en
// `state/quota-reset-reconcile.json`. El predicado lo consultan caminos que se
// declaran de sólo lectura (`isCommanderChainGated`, `isLlmGated`, el
// `failover-probe`, todos con `recordEpisode: false`), y #4565 protege ese
// contrato con test: una sonda que escribe disco es una sonda que deja rastro
// en cada tick del commander. #7188 movió el reconcile al único sitio de spawn
// real (`pulpo.js`, antes de `resolveSpawnWithFallback`).
//
// El fixture de #4565 usa un flag de `anthropic`; acá el flag es de
// `openai-codex` a propósito: es el único provider que el reconcile sabe
// acortar, así que es el caso en que un reconcile mal ubicado SÍ escribiría.
// La Capa 1 (reordenar `writeState`) sola no alcanza para este test; sólo pasa
// si el predicado dejó de invocar al reconcile (Capa 2, REQ-SEC-1).
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { seedPipelineConfig } = require('./_test-helpers');
const { withEnv } = require('../test-helpers/with-env');

const AHORA = Date.parse('2026-09-10T16:00:00Z');
const DETECTADO_ISO = '2026-09-10T14:54:20.552Z';
const RESET_FUTURO_ISO = '2026-09-11T14:54:20.552Z';

// Adapter fake sin dato fresco: `reconcileWithCanonicalSource` (#4865) queda
// fail-closed y NO audita (`gate_vetoed` sólo se escribe con veto). Así el
// único escritor posible en el camino es el reconcile de #7181.
const SIN_DATO = { adapterStatus: 'unknown', pct: null, status: 'unknown' };
const adaptersSinDato = {
    ALLOWED_PROVIDERS: ['anthropic', 'openai-codex', 'gemini-google', 'cerebras'],
    quotaUsage: () => SIN_DATO,
};

function escribirFlagCodex(pipelineDir) {
    const slot = {
        exhausted: true,
        resets_at: RESET_FUTURO_ISO,
        detected_at: DETECTADO_ISO,
        pattern_matched: 'insufficient_quota',
    };
    fs.writeFileSync(path.join(pipelineDir, 'quota-exhausted.json'), JSON.stringify({
        exhausted: true,
        provider: 'openai-codex',
        ...slot,
        providers: { 'openai-codex': slot },
    }, null, 2), 'utf8');
}

/** Listado recursivo y ordenado: detecta archivos nuevos en cualquier nivel. */
function listarRecursivo(dir, prefijo = '') {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const rel = path.posix.join(prefijo, entry.name);
        out.push(rel);
        if (entry.isDirectory()) out.push(...listarRecursivo(path.join(dir, entry.name), rel));
    }
    return out;
}

function conEntornoAislado(fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-quota-7188-'));
    seedPipelineConfig(tmp);
    // Sesiones vacías: si el reconcile llegara a correr, barrería acá y no los
    // rollouts reales de la máquina.
    const sesiones = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-7188-sessions-'));
    const quotaPath = require.resolve('../quota-exhausted');
    const reconcilePath = require.resolve('../quota-reset-reconcile');
    try {
        return withEnv({ PIPELINE_DIR_OVERRIDE: tmp, CODEX_SESSIONS_DIR: sesiones }, () => {
            delete require.cache[quotaPath];
            delete require.cache[reconcilePath];
            const quota = require('../quota-exhausted');
            return fn({ quota, pipelineDir: tmp });
        });
    } finally {
        delete require.cache[quotaPath];
        delete require.cache[reconcilePath];
        fs.rmSync(sesiones, { recursive: true, force: true });
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

test('#7188 · shouldGateSpawn con flag de codex activo gatea y NO escribe nada en pipelineDir', () => {
    conEntornoAislado(({ quota, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        const antes = listarRecursivo(pipelineDir);
        assert.ok(antes.includes('quota-exhausted.json'), 'precondición: flag sembrado');
        assert.ok(!antes.includes('state'), 'precondición: sin state/ previo');

        const gated = quota.shouldGateSpawn('guru', {
            provider: 'openai-codex',
            now: AHORA,
            _quotaAdapters: adaptersSinDato,
        });

        assert.equal(gated, true, 'con slot de codex vigente y sin dato fresco, el flag manda (fail-closed)');
        const despues = listarRecursivo(pipelineDir);
        assert.deepEqual(despues, antes,
            'el predicado no puede dejar rastro: ni state/ ni ningún otro archivo nuevo');
        assert.ok(!fs.existsSync(path.join(pipelineDir, 'state')), 'state/ no debe existir');
    });
});

test('#7188 · shouldGateSpawn repetido (como una sonda por tick) sigue sin escribir', () => {
    conEntornoAislado(({ quota, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        const antes = listarRecursivo(pipelineDir);
        // Varias consultas en el mismo instante y pasado el throttle del
        // reconcile (5 min): si el reconcile siguiera dentro del predicado, la
        // segunda tanda ya no estaría throttleada y escribiría.
        for (const delta of [0, 1_000, 6 * 60 * 1000, 12 * 60 * 1000]) {
            quota.shouldGateSpawn('guru', {
                provider: 'openai-codex',
                now: AHORA + delta,
                _quotaAdapters: adaptersSinDato,
            });
        }
        assert.deepEqual(listarRecursivo(pipelineDir), antes);
    });
});

test('#7188 · shouldGateSpawn sin provider en opts (camino legacy) tampoco escribe', () => {
    conEntornoAislado(({ quota, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        const antes = listarRecursivo(pipelineDir);
        const gated = quota.shouldGateSpawn('guru', { now: AHORA });
        assert.equal(gated, true, 'legacy: cualquier flag activo bloquea');
        assert.deepEqual(listarRecursivo(pipelineDir), antes);
    });
});

test('#7188 · el fuente de shouldGateSpawn no invoca al reconcile (canario estático)', () => {
    const src = fs.readFileSync(require.resolve('../quota-exhausted'), 'utf8');
    assert.ok(!/reconcileCodexReset/.test(src),
        'quota-exhausted.js no debe nombrar reconcileCodexReset: el reconcile vive en el sitio de spawn (pulpo.js)');
});
