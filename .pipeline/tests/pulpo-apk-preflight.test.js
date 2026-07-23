// =============================================================================
// Tests pulpo-apk-preflight — Issue #4046
//
// Smoke determinístico de `preflightQaChecks`: el gate de APK debe decidir por
// el flavor REAL del trabajo (paths tocados), no por la mera presencia del
// label `app:client`.
//
//   - Issue pipeline/dashboard SIN cambios en app/composeApp/ (caso #3954):
//     retorna ok:true, qaMode:'structural', reason:'infra-no-apk' — sin exigir
//     APK ni rebotar.
//   - Issue con cambios reales en app/composeApp/ + app:client: sigue
//     retornando apk_missing si no existe el APK (no se afloja el gate legítimo).
//   - El guard de `reboteVerificacionABuild` hace fail-open para infra-no-apk
//     (no cuenta contra el circuit breaker).
//
// Se inyectan `getLabels`, `getChangedFiles` y `qaArtifactsDir` para que el
// smoke sea hermético (sin gh, sin worktree, sin emulador, sin backend).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PULPO_NO_AUTOSTART = '1';
const pulpo = require('../pulpo.js');

function tmpEmptyArtifactsDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-preflight-'));
    return dir;
}

// ─── Caso #3954: pipeline-only sin APK ──────────────────────────────────────
test('#4046 · issue area:pipeline + app:client con paths .pipeline/* → ok, structural, infra-no-apk', () => {
    const res = pulpo.preflightQaChecks(3954, {
        getLabels: () => ['area:pipeline', 'app:client', 'Ready'],
        getChangedFiles: () => ({ files: ['.pipeline/lib/qa-evidence-gate.js', '.pipeline/pulpo.js'], known: true }),
        qaArtifactsDir: tmpEmptyArtifactsDir(),
    });
    assert.equal(res.ok, true);
    assert.equal(res.result, 'pass');
    assert.equal(res.reason, 'infra-no-apk');
    assert.equal(res.qaMode, 'structural');
    assert.equal(res.requiresEmulator, false);
    assert.deepEqual(res.flavors, []);
});

test('#4046 · issue area:dashboard sin app label con paths .pipeline/* → infra-no-apk', () => {
    const res = pulpo.preflightQaChecks(4001, {
        getLabels: () => ['area:dashboard'],
        getChangedFiles: () => ({ files: ['.pipeline/dashboard-v2.js'], known: true }),
        qaArtifactsDir: tmpEmptyArtifactsDir(),
    });
    assert.equal(res.ok, true);
    assert.equal(res.reason, 'infra-no-apk');
    assert.equal(res.requiresEmulator, false);
});

// ─── Issue de app real sigue exigiendo APK ──────────────────────────────────
test('#4046 · issue app:client con cambios en app/composeApp/ y sin APK → apk_missing', () => {
    const res = pulpo.preflightQaChecks(4002, {
        getLabels: () => ['app:client'],
        getChangedFiles: () => ({ files: ['app/composeApp/src/androidMain/Foo.kt'], known: true }),
        qaArtifactsDir: tmpEmptyArtifactsDir(), // vacío → APK no existe
    });
    assert.equal(res.ok, false);
    assert.equal(res.result, 'apk_missing');
    assert.equal(res.requiresEmulator, true);
    assert.deepEqual(res.flavors, ['client']);
});

test('#4046 · FAIL-CLOSED: app:client + area:pipeline sin origen conocido → sigue exigiendo APK', () => {
    const res = pulpo.preflightQaChecks(4003, {
        getLabels: () => ['area:pipeline', 'app:client'],
        getChangedFiles: () => ({ files: [], known: false }),
        qaArtifactsDir: tmpEmptyArtifactsDir(),
    });
    // Sin evidencia positiva del origen, no se relaja: cae al gate por label.
    assert.equal(res.ok, false);
    assert.equal(res.result, 'apk_missing');
    assert.equal(res.requiresEmulator, true);
});

// ─── reboteVerificacionABuild fail-open ─────────────────────────────────────
test('#4046 · reboteVerificacionABuild fail-open para reason=infra-no-apk → false, sin rebote', () => {
    const out = pulpo.reboteVerificacionABuild(3954, 'desarrollo', {
        reason: 'infra-no-apk',
        requiresEmulator: false,
    });
    assert.equal(out, false);
});

test('#4046 · reboteVerificacionABuild fail-open para requiresEmulator=false → false', () => {
    const out = pulpo.reboteVerificacionABuild(4004, 'desarrollo', {
        reason: 'pass',
        requiresEmulator: false,
    });
    assert.equal(out, false);
});
