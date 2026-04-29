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
