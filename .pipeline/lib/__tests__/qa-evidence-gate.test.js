// =============================================================================
// Tests qa-evidence-gate.js — Issue #2351 (CA-1, CA-3, CA-6 + R1, R3)
//
// Cobertura:
//   CA-1 · qaMode='api' → skip evidence (whitelist explícito)
//   CA-1 · qaMode='structural' → skip evidence
//   CA-1 · qaMode='android' / 'ui' / vacío → NO skip (requiere evidencia)
//   CA-1 · modo autoritativo del preflight gana sobre el YAML del agente
//   CA-6 · issue UI sin qaMode autoritativo + yamlMode='android' → sigue exigiendo video
//   R1   · no se infiere skip por ausencia de labels (solo whitelist explícita)
//   R3   · el evento de bypass tiene la forma esperada para auditar
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeMode,
    resolveQaMode,
    shouldSkipVisualEvidence,
    buildBypassEvent,
    formatBypassLogLine,
    SKIPPABLE_QA_MODES,
} = require('../qa-evidence-gate');

// ─── normalizeMode ─────────────────────────────────────────────────────────
test('normalizeMode · trim + lowercase', () => {
    assert.equal(normalizeMode('  API '), 'api');
    assert.equal(normalizeMode('Structural'), 'structural');
});

test('normalizeMode · null/undefined → cadena vacía', () => {
    assert.equal(normalizeMode(null), '');
    assert.equal(normalizeMode(undefined), '');
    assert.equal(normalizeMode(''), '');
});

test('normalizeMode · valores no string → string lowercase', () => {
    assert.equal(normalizeMode(42), '42');
    assert.equal(normalizeMode(true), 'true');
});

// ─── resolveQaMode (R1 — whitelist + autoridad) ─────────────────────────────
test('resolveQaMode · authoritativo del preflight gana sobre YAML', () => {
    const r = resolveQaMode({ authoritative: 'android', yamlMode: 'api' });
    assert.equal(r.mode, 'android');
    assert.equal(r.source, 'preflight');
});

test('resolveQaMode · sin authoritativo usa el YAML como fallback', () => {
    const r = resolveQaMode({ authoritative: null, yamlMode: 'structural' });
    assert.equal(r.mode, 'structural');
    assert.equal(r.source, 'yaml');
});

test('resolveQaMode · sin ninguna fuente → source=none', () => {
    const r = resolveQaMode({ authoritative: null, yamlMode: null });
    assert.equal(r.mode, '');
    assert.equal(r.source, 'none');
});

test('resolveQaMode · default args (sin opts) no crashea', () => {
    const r = resolveQaMode();
    assert.equal(r.mode, '');
    assert.equal(r.source, 'none');
});

// ─── shouldSkipVisualEvidence (CA-1, CA-6, R1) ──────────────────────────────
test('CA-1 · qaMode="api" salta evidencia audiovisual', () => {
    assert.equal(shouldSkipVisualEvidence('api'), true);
});

test('CA-1 · qaMode="structural" salta evidencia audiovisual', () => {
    assert.equal(shouldSkipVisualEvidence('structural'), true);
});

test('CA-6 · qaMode="android" sigue exigiendo evidencia', () => {
    assert.equal(shouldSkipVisualEvidence('android'), false);
});

test('CA-6 · qaMode="ui" sigue exigiendo evidencia', () => {
    // 'ui' no está en la whitelist — defensivo
    assert.equal(shouldSkipVisualEvidence('ui'), false);
});

test('R1 · qaMode vacío NUNCA salta (no inferir por ausencia)', () => {
    assert.equal(shouldSkipVisualEvidence(''), false);
    assert.equal(shouldSkipVisualEvidence(null), false);
    assert.equal(shouldSkipVisualEvidence(undefined), false);
});

test('R1 · qaMode desconocido ("hotfix", "infra") NUNCA salta', () => {
    assert.equal(shouldSkipVisualEvidence('hotfix'), false);
    assert.equal(shouldSkipVisualEvidence('infra'), false);
    assert.equal(shouldSkipVisualEvidence('anything-else'), false);
});

test('R1 · whitelist es exactamente ["api", "structural"]', () => {
    assert.deepEqual([...SKIPPABLE_QA_MODES].sort(), ['api', 'structural']);
});

// ─── buildBypassEvent (R3) ─────────────────────────────────────────────────
test('R3 · buildBypassEvent tiene forma auditable para api', () => {
    const evt = buildBypassEvent({
        issue: 2023,
        qaMode: 'api',
        source: 'preflight',
        labels: ['area:backend'],
    });
    assert.equal(evt.event, 'gate-bypass');
    assert.equal(evt.issue, '2023');
    assert.equal(evt.qaMode, 'api');
    assert.equal(evt.source, 'preflight');
    assert.equal(evt.decision, 'skip-video');
    assert.match(evt.reason, /QA-API.*evidencia/i);
    assert.deepEqual(evt.labels, ['area:backend']);
});

test('R3 · buildBypassEvent tiene forma auditable para structural', () => {
    const evt = buildBypassEvent({
        issue: '1507',
        qaMode: 'structural',
        source: 'preflight',
    });
    assert.equal(evt.qaMode, 'structural');
    assert.match(evt.reason, /estructural/i);
    assert.deepEqual(evt.labels, []);
});

test('R3 · buildBypassEvent normaliza el issue a string', () => {
    const evt = buildBypassEvent({ issue: 42, qaMode: 'api', source: 'yaml' });
    assert.equal(typeof evt.issue, 'string');
    assert.equal(evt.issue, '42');
});

test('R3 · formatBypassLogLine incluye JSON parseable + prefijo legible', () => {
    const evt = buildBypassEvent({
        issue: 2023,
        qaMode: 'api',
        source: 'preflight',
        labels: ['area:backend'],
    });
    const line = formatBypassLogLine(evt);
    // El JSON debe quedar al final y ser parseable
    const jsonStart = line.indexOf('{');
    assert.ok(jsonStart > 0, 'line debe tener JSON al final');
    const parsed = JSON.parse(line.slice(jsonStart));
    assert.equal(parsed.event, 'gate-bypass');
    assert.equal(parsed.issue, '2023');
    // El prefijo legible debe tener gate-bypass, issue y qaMode
    assert.match(line, /gate-bypass/);
    assert.match(line, /#2023/);
    assert.match(line, /qaMode=api/);
});

// ─── resolveApkRequirement (Issue #4046) ────────────────────────────────────
const {
    resolveApkRequirement,
    normalizeLabels,
    normalizeRepoPath,
} = require('../qa-evidence-gate');

test('#4046 · area:pipeline + app:client con paths .pipeline/* → infra-no-apk (caso #3954)', () => {
    const r = resolveApkRequirement({
        labels: ['area:pipeline', 'app:client'],
        changedFiles: ['.pipeline/lib/qa-evidence-gate.js', '.pipeline/pulpo.js'],
    });
    assert.equal(r.requiresApk, false);
    assert.equal(r.reason, 'infra-no-apk');
    assert.deepEqual(r.flavors, []);
});

test('#4046 · area:dashboard con paths .pipeline/* → infra-no-apk', () => {
    const r = resolveApkRequirement({
        labels: [{ name: 'area:dashboard' }],
        changedFiles: ['.pipeline/dashboard-v2.js'],
    });
    assert.equal(r.requiresApk, false);
    assert.equal(r.reason, 'infra-no-apk');
});

test('#4046 · app:client con cambios en app/composeApp/ → requiere APK client', () => {
    const r = resolveApkRequirement({
        labels: ['app:client'],
        changedFiles: ['app/composeApp/src/commonMain/Foo.kt'],
    });
    assert.equal(r.requiresApk, true);
    assert.equal(r.reason, 'app-flavor');
    assert.deepEqual(r.flavors, ['client']);
});

test('#4046 · area:pipeline + app:client PERO con cambios en app/composeApp/ → NO afloja, requiere APK', () => {
    // Si el issue de pipeline igual toca la app, el binario sí se produce.
    const r = resolveApkRequirement({
        labels: ['area:pipeline', 'app:client'],
        changedFiles: ['.pipeline/pulpo.js', 'app/composeApp/src/androidMain/Bar.kt'],
    });
    assert.equal(r.requiresApk, true);
    assert.equal(r.reason, 'app-flavor');
    assert.deepEqual(r.flavors, ['client']);
});

test('#4046 · app:business y app:delivery conservan flavor correcto', () => {
    const biz = resolveApkRequirement({
        labels: ['app:business'],
        changedFiles: ['app/composeApp/src/businessMain/X.kt'],
    });
    assert.deepEqual(biz.flavors, ['business']);
    assert.equal(biz.requiresApk, true);

    const del = resolveApkRequirement({
        labels: ['app:delivery'],
        changedFiles: ['app/composeApp/src/deliveryMain/Y.kt'],
    });
    assert.deepEqual(del.flavors, ['delivery']);
    assert.equal(del.requiresApk, true);
});

test('#4046 · FAIL-CLOSED: area:pipeline + app:client SIN origen conocido → requiere APK (no relaja por ausencia de datos)', () => {
    const r = resolveApkRequirement({
        labels: ['area:pipeline', 'app:client'],
        changedFiles: [],
        changedFilesKnown: false,
    });
    assert.equal(r.requiresApk, true);
    assert.equal(r.reason, 'app-flavor');
});

test('#4046 · area:pipeline + app:client con origen conocido pero diff vacío → infra-no-apk', () => {
    const r = resolveApkRequirement({
        labels: ['area:pipeline', 'app:client'],
        changedFiles: [],
        changedFilesKnown: true,
    });
    assert.equal(r.requiresApk, false);
    assert.equal(r.reason, 'infra-no-apk');
});

test('#4046 · sin label app y sin área infra → no-app-label (no requiere APK)', () => {
    const r = resolveApkRequirement({
        labels: ['area:backend'],
        changedFiles: ['users/src/Foo.kt'],
    });
    assert.equal(r.requiresApk, false);
    assert.equal(r.reason, 'no-app-label');
    assert.deepEqual(r.flavors, []);
});

test('#4046 · path con backslashes y ./ se normaliza para el prefijo app/composeApp/', () => {
    assert.equal(normalizeRepoPath('app\\composeApp\\src\\X.kt'), 'app/composeApp/src/X.kt');
    assert.equal(normalizeRepoPath('./app/composeApp/X.kt'), 'app/composeApp/X.kt');
    const r = resolveApkRequirement({
        labels: ['app:client'],
        changedFiles: ['app\\composeApp\\src\\androidMain\\Z.kt'],
    });
    assert.equal(r.requiresApk, true);
});

test('#4046 · normalizeLabels tolera strings y objetos {name}', () => {
    assert.deepEqual(
        normalizeLabels(['App:Client', { name: 'AREA:Pipeline' }, null, 42, '  Bug ']),
        ['app:client', 'area:pipeline', 'bug'],
    );
});

// ─── hasQaSkippedLabel — bypass del gate de evidencia audiovisual (Issue #3956) ──
// El gate `validateQaEvidence` (pulpo.js) honra el label explícito `qa:skipped`
// para no rechazar issues de infra/dashboard sin video. Estos tests fijan el
// contrato del helper que ese gate consulta.
const { hasQaSkippedLabel } = require('../qa-evidence-gate');

test('#3956 · hasQaSkippedLabel detecta qa:skipped en labels reales del issue', () => {
    const labels = ['Ready', 'area:dashboard', 'app:client', 'ux', 'qa:skipped', 'size:medium'];
    assert.equal(hasQaSkippedLabel(labels), true);
});

test('#3956 · hasQaSkippedLabel tolera objetos {name} y case-insensitive', () => {
    assert.equal(hasQaSkippedLabel([{ name: 'QA:Skipped' }]), true);
    assert.equal(hasQaSkippedLabel(['QA:SKIPPED']), true);
});

test('#3956 · hasQaSkippedLabel false cuando no está el label (sigue exigiendo evidencia)', () => {
    assert.equal(hasQaSkippedLabel(['app:client', 'area:dashboard']), false);
    assert.equal(hasQaSkippedLabel([]), false);
    assert.equal(hasQaSkippedLabel(null), false);
    assert.equal(hasQaSkippedLabel(undefined), false);
});
