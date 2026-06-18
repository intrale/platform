// =============================================================================
// sherlock-regression-3729.test.js — Tests E2E de regresión (#3897 CA-7,
// split 3/3 del épico #3894).
//
// Reproduce el caso real de la sesión del #3729 que motivó el épico: de 4
// contradicciones medidas, 3 eran FALSOS POSITIVOS (precisión 1/4 = 25%)
// porque Commander y Sherlock validaban contra proxies ambiguos:
//
//   FP-1 — "el entregable no está en main, hay que reentregar"
//          → la rama agent/3729-* SÍ estaba alcanzable desde origin/main.
//   FP-2 — "el PR no está mergeado"
//          → el PR #3890 estaba MERGED (mergedAt presente).
//   FP-3 — "el issue sigue abierto"
//          → el issue #3729 estaba CLOSED.
//   (la 4ta contradicción era legítima — fuera de este scope)
//
// Con la lógica canónica (#3895) cada claim se re-evalúa ejecutando su fuente
// canónica como árbitro determinístico: los 3 falsos positivos producen
// 'consistent' (NO contradicción falsa). Y si la fuente no se puede ejecutar
// (rate limit / herramienta ausente), el resultado es 'not_verifiable' —
// NUNCA una contradicción especulativa.
//
// Diseño: fakes de gitImpl/ghApi que reproducen el estado REAL observado en
// la sesión del #3729 (PR #3890 MERGED 2026-06-04, issue CLOSED, rama
// mergeada). CERO red/FS/shell.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveClaim } = require('../canonical-facts');

// -----------------------------------------------------------------------------
// Estado real del #3729 al momento del incidente, reproducido por las fuentes
// canónicas fake. Estos son los HECHOS que los proxies ambiguos contradecían.
// -----------------------------------------------------------------------------
const REAL_STATE_3729 = {
    // `git branch --all --merged origin/main --list *agent/3729-*`
    mergedBranches: '  remotes/origin/agent/3729-bloqueados-view\n',
    // `gh pr view 3890 --json state,mergedAt`
    pr3890: { state: 'MERGED', mergedAt: '2026-06-04T18:22:31Z' },
    // `gh issue view 3729 --json state,closed`
    issue3729: { state: 'CLOSED', closed: true },
};

function fakeGitImpl({ args }) {
    // Única consulta git esperada en este caso: ramas mergeadas a origin/main.
    if (args.includes('--merged')) {
        return Promise.resolve({ ok: true, stdout: REAL_STATE_3729.mergedBranches });
    }
    return Promise.resolve({ ok: true, stdout: REAL_STATE_3729.mergedBranches });
}

function fakeGhApi({ args }) {
    if (args[0] === 'pr') {
        return Promise.resolve({ ok: true, stdout: JSON.stringify(REAL_STATE_3729.pr3890) });
    }
    if (args[0] === 'issue') {
        return Promise.resolve({ ok: true, stdout: JSON.stringify(REAL_STATE_3729.issue3729) });
    }
    return Promise.resolve({ ok: false, stdout: '', stderr: 'unexpected' });
}

const IMPLS = { gitImpl: fakeGitImpl, ghApi: fakeGhApi };

// -----------------------------------------------------------------------------
// CA-7 — los 3 falsos positivos re-evaluados con canonical → ya no producen
// contradicción falsa (status 'consistent', no 'inconsistent').
// -----------------------------------------------------------------------------
test('CA-7/FP-1: "entregable no está en main" → canonical entregable_en_main = consistent (sin contradicción falsa)', async () => {
    // El claim correcto era "#3729 SÍ está entregado en main" (expected true).
    const r = await resolveClaim('entregable_en_main', { issue: 3729, expected: true }, IMPLS);
    assert.equal(r.value, true, 'la rama agent/3729-* está alcanzable desde origin/main');
    assert.equal(r.status, 'consistent', 'el árbitro canónico confirma — NO contradice');
    assert.equal(r.source, 'git');
});

test('CA-7/FP-2: "el PR no está mergeado" → canonical pr_mergeado = consistent (PR #3890 MERGED)', async () => {
    const r = await resolveClaim('pr_mergeado', { pr: 3890, expected: true }, IMPLS);
    assert.equal(r.value, true, 'mergedAt presente → mergeado');
    assert.equal(r.status, 'consistent', 'el árbitro canónico confirma — NO contradice');
    assert.equal(r.source, 'github-api');
});

test('CA-7/FP-3: "el issue sigue abierto" → canonical issue_cerrado = consistent (issue #3729 CLOSED)', async () => {
    const r = await resolveClaim('issue_cerrado', { issue: 3729, expected: true }, IMPLS);
    assert.equal(r.value, true, 'state CLOSED → cerrado');
    assert.equal(r.status, 'consistent', 'el árbitro canónico confirma — NO contradice');
    assert.equal(r.source, 'github-api');
});

// -----------------------------------------------------------------------------
// CA-7 — el patrón viejo (proxy ambiguo) ahora solo contradice cuando el hecho
// real DISCREPA. Verificamos que la inversión de lógica distingue ambos casos.
// -----------------------------------------------------------------------------
test('CA-7: si el hecho real SÍ discrepa, el árbitro contradice con fuente (inconsistent legítimo)', async () => {
    // #4074: entregable_en_main ya NO emite un `false` especulativo (el tip de la
    // rama no refuta un squash-merge). La contradicción legítima surge cuando el
    // Commander afirma lo CONTRARIO al hecho positivo: "el entregable NO está en
    // main" (expected:false) mientras la rama agent/3729-* SÍ está mergeada →
    // value=true discrepa de expected=false → inconsistent respaldado por la fuente.
    const r = await resolveClaim('entregable_en_main', { issue: 3729, expected: false }, IMPLS);
    assert.equal(r.value, true, 'la rama agent/3729-* está alcanzable desde origin/main');
    assert.equal(r.status, 'inconsistent', 'contradicción LEGÍTIMA respaldada por el hecho canónico');
});

// -----------------------------------------------------------------------------
// CA-7 — fuente canónica no ejecutable → not_verifiable, NUNCA contradicción
// especulativa (la causa raíz de los falsos positivos del patrón viejo).
// -----------------------------------------------------------------------------
test('CA-7: fuente canónica caída (rate limit) → not_verifiable, nunca contradicción especulativa', async () => {
    const impls = {
        gitImpl: () => Promise.resolve({ ok: false, stdout: '', stderr: 'fatal' }),
        ghApi: () => Promise.resolve({ ok: false, stdout: '', stderr: 'API rate limit exceeded' }),
    };
    for (const [claim, params] of [
        ['entregable_en_main', { issue: 3729 }],
        ['pr_mergeado', { pr: 3890 }],
        ['issue_cerrado', { issue: 3729 }],
    ]) {
        const r = await resolveClaim(claim, params, impls);
        assert.equal(r.status, 'not_verifiable', `${claim}: caído NO debe contradecir`);
        assert.notEqual(r.status, 'inconsistent', `${claim}: contradicción especulativa prohibida`);
    }
});

test('CA-7: stdout malformado de la fuente → not_verifiable (SEC-5, sin throw)', async () => {
    const impls = {
        gitImpl: fakeGitImpl,
        ghApi: () => Promise.resolve({ ok: true, stdout: '<<html rate limit page>>' }),
    };
    const r = await resolveClaim('pr_mergeado', { pr: 3890 }, impls);
    assert.equal(r.status, 'not_verifiable');
});

// -----------------------------------------------------------------------------
// CA-7 — precisión resultante del caso #3729 re-evaluado: las 3 validaciones
// canónicas coherentes elevan la precisión medible de 25% (1/4 histórico) a
// 100% sobre los claims verificables. Cerramos el círculo con el mismo
// criterio de "correcta" que usa el slice del dashboard (CA-4).
// -----------------------------------------------------------------------------
test('CA-7: el caso #3729 re-evaluado produce 3/3 validaciones correctas según el criterio del slice', async () => {
    const slices = require('../dashboard-slices');
    const results = await Promise.all([
        resolveClaim('entregable_en_main', { issue: 3729 }, IMPLS),
        resolveClaim('pr_mergeado', { pr: 3890 }, IMPLS),
        resolveClaim('issue_cerrado', { issue: 3729 }, IMPLS),
    ]);
    // Mapeo idéntico a `mapCanonicalStatus` del verifier (#3896 CA-6).
    const records = results.map((r) => ({
        commander_vs_sherlock: r.status,
        resolucion: r.status === 'consistent' ? 'accepted'
            : r.status === 'inconsistent' ? 'rejected' : 'escalated',
    }));
    const correctas = records.filter((rec) => slices._sherlockRecordCorrecto(rec)).length;
    assert.equal(correctas, 3, 'los 3 ex-falsos-positivos cuentan como validaciones correctas');
});
