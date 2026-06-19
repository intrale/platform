// =============================================================================
// canonical-delivery-state.test.js — Suite del compositor `resolveDeliveryState`
// (#4090). Da al Commander la fuente ÚNICA determinística de "¿entregado =
// mergeado en main?" colapsando 4 hechos canónicos en 3 estados mutuamente
// excluyentes + `not_verifiable`.
//
// Cubre (CA-1 / CA-2):
//   - precedencia: pr_mergeado=true → mergeado_en_main (aunque la rama no esté
//     mergeada localmente).
//   - precedencia: entregable_en_main=true sin PR → mergeado_en_main.
//   - no mergeado + rama_contiene_commits=true → pusheado_sin_merge.
//   - ni merge ni rama + estado_fase_issue resoluble → en_pipeline (con fase).
//   - todos los hechos not_verifiable → state 'not_verifiable' (NO colapsa a
//     "no entregado", SEC-5).
//   - inyección de impls (gitImpl/ghApi/fsImpl fake) → cero red/shell.
//   - grep estático: el compositor NO contiene execFile/spawnSync/--jq.
//
// Diseño: fakes inyectables. CERO red/FS-de-prod/shell.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const canonical = require('../canonical-facts');
const { resolveDeliveryState } = canonical;

// -----------------------------------------------------------------------------
// Fakes de git/gh/fs inyectables. El fake git inspecciona `args` para distinguir
// las consultas que hace el resolve() de entregable_en_main (#4074) y el hecho
// rama_contiene_commits.
// -----------------------------------------------------------------------------
function mkGit({ merged = false, exists = false } = {}) {
    return async ({ args }) => {
        const a = Array.isArray(args) ? args : [];
        // `git branch --all --merged origin/main --list *agent/<n>-*`
        if (a.includes('--merged')) {
            return { ok: true, stdout: merged ? '  remotes/origin/agent/4090-x\n' : '' };
        }
        // `git branch --all --list *agent/<n>-*` (existencia, sin --merged)
        if (a[0] === 'branch' && a.includes('--list')) {
            return { ok: true, stdout: exists ? '  remotes/origin/agent/4090-x\n' : '' };
        }
        // `git log origin/main ...` (confirmación squash) — no usado en estos casos.
        if (a[0] === 'log') return { ok: true, stdout: '' };
        return { ok: false, stdout: '' };
    };
}

// gh que deja todo en not_verifiable (issue abierto / sin PR mergeado).
const ghNotVerifiable = async () => ({ ok: true, stdout: JSON.stringify({ state: 'OPEN', closed: false }) });

// -----------------------------------------------------------------------------
// CA-2 — precedencia determinística.
// -----------------------------------------------------------------------------
test('precedencia: pr_mergeado=true → mergeado_en_main (aunque la rama no esté mergeada)', async () => {
    const gitImpl = mkGit({ merged: false, exists: true }); // rama existe, NO mergeada
    const ghApi = async ({ args }) => {
        if (args[0] === 'pr' && args[1] === 'view') {
            return { ok: true, stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-06-19T10:00:00Z' }) };
        }
        return ghNotVerifiable();
    };
    const out = await resolveDeliveryState(4090, { pr: 4091 }, { gitImpl, ghApi });
    assert.equal(out.state, 'mergeado_en_main');
});

test('precedencia: entregable_en_main=true sin PR → mergeado_en_main', async () => {
    const gitImpl = mkGit({ merged: true });
    const out = await resolveDeliveryState(4090, {}, { gitImpl, ghApi: ghNotVerifiable });
    assert.equal(out.state, 'mergeado_en_main');
});

test('no mergeado + rama_contiene_commits=true → pusheado_sin_merge', async () => {
    // --merged vacío + --list con rama → enMain=false (negativo real); rama existe.
    const gitImpl = mkGit({ merged: false, exists: true });
    const out = await resolveDeliveryState(4090, {}, { gitImpl, ghApi: ghNotVerifiable });
    assert.equal(out.state, 'pusheado_sin_merge');
});

test('ni merge ni rama + estado_fase_issue resoluble → en_pipeline (con fase)', async () => {
    // --merged vacío + --list vacío → entregable_en_main cae al path gh; con issue
    // abierto → not_verifiable. rama_contiene_commits=false. fase resuelta vía fsImpl.
    const gitImpl = mkGit({ merged: false, exists: false });
    const fsImpl = { readFileSync: () => 'issue: 4090\nfase: dev\n' };
    const out = await resolveDeliveryState(
        4090,
        { pipeline: 'desarrollo', fase: 'dev', estado: 'trabajando', skill: 'pipeline-dev' },
        { gitImpl, ghApi: ghNotVerifiable, fsImpl }
    );
    assert.equal(out.state, 'en_pipeline');
    assert.equal(out.fase, 'dev');
});

test('todos los hechos not_verifiable → state not_verifiable (NO colapsa a "no entregado")', async () => {
    const gitImpl = async () => ({ ok: false, stdout: '' }); // git no ejecutable
    const ghApi = async () => ({ ok: false, stdout: '' });
    const out = await resolveDeliveryState(4090, {}, { gitImpl, ghApi });
    assert.equal(out.state, 'not_verifiable');
    // El antipatrón a erradicar: jamás afirmar "no entregado" sin evidencia.
    assert.notEqual(out.state, 'pusheado_sin_merge');
    assert.notEqual(out.state, 'mergeado_en_main');
});

// -----------------------------------------------------------------------------
// CA-5 — determinismo: dos consultas idénticas dan el mismo estado.
// -----------------------------------------------------------------------------
test('determinismo: dos consultas consecutivas con las mismas impls → mismo estado', async () => {
    const gitImpl = mkGit({ merged: true });
    const a = await resolveDeliveryState(4090, {}, { gitImpl, ghApi: ghNotVerifiable });
    const b = await resolveDeliveryState(4090, {}, { gitImpl, ghApi: ghNotVerifiable });
    assert.equal(a.state, b.state);
});

// -----------------------------------------------------------------------------
// CA-3 / Riesgo — grep estático: el compositor NO arma gh/git a mano.
// -----------------------------------------------------------------------------
test('grep estático: resolveDeliveryState no contiene execFile/spawn/--jq (solo resolveClaim)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'canonical-facts.js'), 'utf8');
    const start = src.indexOf('async function resolveDeliveryState');
    assert.ok(start > 0, 'no se encontró la función resolveDeliveryState');
    // Hasta el module.exports posterior.
    const end = src.indexOf('module.exports', start);
    const body = src.slice(start, end > start ? end : undefined);
    assert.ok(!/execFile|spawnSync|spawn\(|\bexec\(/.test(body), 'el compositor NO debe ejecutar comandos directos');
    assert.ok(!/--jq/.test(body), 'el compositor NO debe usar --jq derivado del input');
    assert.ok(/resolveClaim\(/.test(body), 'el compositor debe componer vía resolveClaim');
});
