// =============================================================================
// smoke-test.test.js — tests del módulo lib/multi-provider/smoke-test.js (#3680)
//
// Cobertura mínima esperada (CA-A23):
//   - buildMatrixFromAgentModels: deriva dinámicamente N skills LLM, excluye
//     deterministic, marca refinar × non-anthropic como N/A · single-provider.
//   - classify: tabla de verdad PASS/WARN/FAIL/SKIPPED/N/A.
//   - bucketize: jamás devuelve ms absolutos.
//   - preCheckCoordinationWindow: pausa total, allowed_skills matching,
//     ningún marker.
//   - preCheckProviderCredentials: credencial placeholder/ausente.
//   - enforceCap: spawns_per_run, per_combination.
//   - summarizeMatrix: cuenta correctamente cada bucket.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const smoke = require('../smoke-test');

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function fixtureAgentModels() {
    return {
        default_provider: 'anthropic',
        providers: {
            anthropic:       { launcher: 'claude', model: 'claude-opus-4-7', credentials_env: ['ANTHROPIC_API_KEY'] },
            'openai-codex':  { launcher: 'codex',  model: 'gpt-5-codex',     credentials_env: ['OPENAI_API_KEY'] },
            'gemini-google': { launcher: 'gemini', model: 'gemini-2.0-flash',credentials_env: ['GEMINI_API_KEY'] },
            'cerebras':      { launcher: 'cerebras',model:'llama-3.3-70b',  credentials_env: ['CEREBRAS_API_KEY'] },
            'nvidia-nim':    { launcher: 'nvidia', model:'deepseek-v4',     credentials_env: ['NVIDIA_NIM_API_KEY'] },
            deterministic:   { launcher: 'node',   model: 'deterministic' },
        },
        skills: {
            'backend-dev': {
                provider: 'anthropic',
                fallbacks: [{ provider: 'openai-codex' }, { provider: 'cerebras' }],
            },
            'refinar': { provider: 'anthropic' },     // sin fallbacks → single-provider
            'qa': {
                provider: 'anthropic',
                fallbacks: [{ provider: 'openai-codex' }, { provider: 'gemini-google' }, { provider: 'cerebras' }],
            },
            'build': { provider: 'deterministic' },   // excluido
            'security': {
                provider: 'anthropic',
                fallbacks: [{ provider: 'openai-codex' }, { provider: 'cerebras' }],
            },
        },
    };
}

// -----------------------------------------------------------------------------
// buildMatrixFromAgentModels — CA-A1
// -----------------------------------------------------------------------------
test('buildMatrixFromAgentModels excluye skills con provider=deterministic', () => {
    const models = fixtureAgentModels();
    const matrix = smoke.buildMatrixFromAgentModels(models);
    const skillsInMatrix = [...new Set(matrix.map(c => c.skill))];
    assert.ok(!skillsInMatrix.includes('build'), 'build (deterministic) NO debe estar en la matriz');
});

test('buildMatrixFromAgentModels deriva N skills LLM dinámicamente (no hardcodea 15)', () => {
    const models = fixtureAgentModels();
    const matrix = smoke.buildMatrixFromAgentModels(models);
    const skillsInMatrix = [...new Set(matrix.map(c => c.skill))];
    // Fixture tiene 4 skills LLM (backend-dev, refinar, qa, security) + 1 deterministic.
    assert.equal(skillsInMatrix.length, 4);
    assert.deepEqual(skillsInMatrix.sort(), ['backend-dev', 'qa', 'refinar', 'security']);
});

test('buildMatrixFromAgentModels marca refinar × non-anthropic como N/A · single-provider por diseño', () => {
    const models = fixtureAgentModels();
    const matrix = smoke.buildMatrixFromAgentModels(models);
    const refinarCells = matrix.filter(c => c.skill === 'refinar');
    // refinar tiene un cell por provider LLM (anthropic, openai-codex, gemini-google, cerebras, nvidia-nim)
    assert.equal(refinarCells.length, 5);
    const anthropicCell = refinarCells.find(c => c.provider === 'anthropic');
    const cerebrasCell = refinarCells.find(c => c.provider === 'cerebras');
    assert.equal(anthropicCell.eligible, true);
    assert.equal(anthropicCell.na_reason, null);
    assert.equal(cerebrasCell.eligible, false);
    assert.match(cerebrasCell.na_reason, /single-provider/);
});

test('buildMatrixFromAgentModels usa model_override del fallback cuando está pin-eado', () => {
    const models = fixtureAgentModels();
    // Pin-ear model_override en el fallback openai-codex de qa.
    models.skills.qa.fallbacks = [{ provider: 'openai-codex', model_override: 'gpt-5' }];
    const matrix = smoke.buildMatrixFromAgentModels(models);
    const qaOpenai = matrix.find(c => c.skill === 'qa' && c.provider === 'openai-codex');
    assert.equal(qaOpenai.model, 'gpt-5');
});

test('buildMatrixFromAgentModels throw si agent-models.json sin "skills"', () => {
    assert.throws(() => smoke.buildMatrixFromAgentModels({ providers: {} }), /sin sección "skills"/);
});

test('buildMatrixFromAgentModels throw si agent-models.json sin "providers"', () => {
    assert.throws(() => smoke.buildMatrixFromAgentModels({ skills: {} }), /sin sección "providers"/);
});

// -----------------------------------------------------------------------------
// bucketize — CA-A7
// -----------------------------------------------------------------------------
test('bucketize NUNCA devuelve ms absolutos — sólo strings de bucket discreto', () => {
    assert.equal(smoke.bucketize(0), '<=100ms');
    assert.equal(smoke.bucketize(100), '<=100ms');
    assert.equal(smoke.bucketize(101), '<=500ms');
    assert.equal(smoke.bucketize(500), '<=500ms');
    assert.equal(smoke.bucketize(501), '<=2s');
    assert.equal(smoke.bucketize(2000), '<=2s');
    assert.equal(smoke.bucketize(2001), '<=10s');
    assert.equal(smoke.bucketize(10000), '<=10s');
    assert.equal(smoke.bucketize(10001), '>10s');
    assert.equal(smoke.bucketize(60000), '>10s');
});

test('bucketize devuelve N/A para valores no numéricos o negativos', () => {
    assert.equal(smoke.bucketize(NaN), 'N/A');
    assert.equal(smoke.bucketize(undefined), 'N/A');
    assert.equal(smoke.bucketize(null), 'N/A');
    assert.equal(smoke.bucketize(-1), 'N/A');
});

// -----------------------------------------------------------------------------
// classify — CA-A6
// -----------------------------------------------------------------------------
test('classify PASS cuando exit=0 + bucket rápido + sin warnings + sin divergencia', () => {
    const r = smoke.classify({
        exit_code: 0,
        latency_bucket: '<=500ms',
        stderr_lines: [],
        parser_output: { errorClass: null },
    });
    assert.equal(r.status, 'PASS');
    assert.equal(r.error_class, null);
});

test('classify FAIL cuando exit != 0', () => {
    const r = smoke.classify({
        exit_code: 1,
        latency_bucket: '<=500ms',
        stderr_lines: [],
        parser_output: { errorClass: 'permanent_failure' },
    });
    assert.equal(r.status, 'FAIL');
    assert.equal(r.error_class, 'permanent_failure');
});

test('classify FAIL en timeout (timed_out=true)', () => {
    const r = smoke.classify({
        exit_code: 0,
        latency_bucket: '>10s',
        timed_out: true,
    });
    assert.equal(r.status, 'FAIL');
    assert.equal(r.error_class, 'timeout');
});

test('classify FAIL en quota_exhausted detectado por parser aunque exit=0', () => {
    const r = smoke.classify({
        exit_code: 0,
        latency_bucket: '<=500ms',
        parser_output: { errorClass: 'quota_exhausted' },
    });
    assert.equal(r.status, 'FAIL');
    assert.equal(r.error_class, 'quota_exhausted');
});

test('classify FAIL en auth error detectado por parser', () => {
    const r = smoke.classify({
        exit_code: 0,
        latency_bucket: '<=500ms',
        parser_output: { errorClass: 'auth' },
    });
    assert.equal(r.status, 'FAIL');
    assert.equal(r.error_class, 'auth');
});

test('classify WARN cuando exit=0 pero bucket lento (<=10s)', () => {
    const r = smoke.classify({
        exit_code: 0,
        latency_bucket: '<=10s',
        stderr_lines: [],
    });
    assert.equal(r.status, 'WARN');
    assert.equal(r.error_class, 'baseline_divergence');
});

test('classify WARN cuando exit=0 pero bucket más lento (>10s)', () => {
    const r = smoke.classify({
        exit_code: 0,
        latency_bucket: '>10s',
    });
    assert.equal(r.status, 'WARN');
});

test('classify WARN cuando stderr tiene "warning"/"deprecat"', () => {
    const r = smoke.classify({
        exit_code: 0,
        latency_bucket: '<=500ms',
        stderr_lines: ['note: this option is deprecated'],
    });
    assert.equal(r.status, 'WARN');
});

test('classify WARN para errorClass=unknown (R5: no FAIL — diagnóstico)', () => {
    const r = smoke.classify({
        exit_code: 0,
        latency_bucket: '<=500ms',
        parser_output: { errorClass: 'unknown' },
    });
    assert.equal(r.status, 'WARN');
    assert.equal(r.error_class, 'unknown');
});

test('classify WARN cuando baseline_divergence=true (opción B de criterios)', () => {
    const r = smoke.classify({
        exit_code: 0,
        latency_bucket: '<=500ms',
        baseline_divergence: true,
    });
    assert.equal(r.status, 'WARN');
});

// -----------------------------------------------------------------------------
// preCheckCoordinationWindow — CA-A15
// -----------------------------------------------------------------------------
test('preCheckCoordinationWindow OK cuando mode=paused (halt total)', () => {
    const r = smoke.preCheckCoordinationWindow({ mode: 'paused' });
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'paused');
});

test('preCheckCoordinationWindow OK cuando partial_pause + allowedSkills contiene multi-provider-smoke-test', () => {
    const r = smoke.preCheckCoordinationWindow({
        mode: 'partial_pause',
        allowedSkills: ['multi-provider-smoke-test'],
    });
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'partial_pause');
});

test('preCheckCoordinationWindow RECHAZA cuando mode=running (pipeline productivo)', () => {
    const r = smoke.preCheckCoordinationWindow({ mode: 'running' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_safe_window');
    assert.match(r.msg, /partial-pause/);
    assert.match(r.msg, /multi-provider-smoke-test/);
});

test('preCheckCoordinationWindow RECHAZA cuando partial_pause SIN allowed_skills matching', () => {
    const r = smoke.preCheckCoordinationWindow({
        mode: 'partial_pause',
        allowedSkills: ['otro-skill'],
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_safe_window');
});

test('preCheckCoordinationWindow RECHAZA cuando state es null/undefined', () => {
    assert.equal(smoke.preCheckCoordinationWindow(null).ok, false);
    assert.equal(smoke.preCheckCoordinationWindow(undefined).ok, false);
});

// -----------------------------------------------------------------------------
// preCheckProviderCredentials — CA-A13
// -----------------------------------------------------------------------------
test('preCheckProviderCredentials marca anthropic como disponible (launcher=claude, OAuth)', () => {
    const models = fixtureAgentModels();
    const r = smoke.preCheckProviderCredentials(['anthropic'], {}, models);
    assert.equal(r.perProvider.anthropic.available, true);
    assert.match(r.perProvider.anthropic.note, /oauth/);
});

test('preCheckProviderCredentials SKIPPED cuando env var falta', () => {
    const models = fixtureAgentModels();
    const r = smoke.preCheckProviderCredentials(['cerebras'], {}, models);
    assert.equal(r.perProvider.cerebras.available, false);
    assert.deepEqual(r.perProvider.cerebras.missing, ['CEREBRAS_API_KEY']);
});

test('preCheckProviderCredentials SKIPPED cuando env var es placeholder', () => {
    const models = fixtureAgentModels();
    const r = smoke.preCheckProviderCredentials(
        ['cerebras'],
        { CEREBRAS_API_KEY: 'REVOKED_PLACEHOLDER_2026' },
        models
    );
    assert.equal(r.perProvider.cerebras.available, false);
});

test('preCheckProviderCredentials OK cuando env var presente y no placeholder', () => {
    const models = fixtureAgentModels();
    const r = smoke.preCheckProviderCredentials(
        ['cerebras'],
        { CEREBRAS_API_KEY: 'sk-real-key-abc123' },
        models
    );
    assert.equal(r.perProvider.cerebras.available, true);
});

// -----------------------------------------------------------------------------
// enforceCap — CA-A14
// -----------------------------------------------------------------------------
test('enforceCap throw cuando se alcanza MAX_SPAWNS_PER_RUN', () => {
    const state = { spawns_total: smoke.MAX_SPAWNS_PER_RUN, per_combo: {} };
    assert.throws(() => smoke.enforceCap(state, 'spawns_per_run'), (err) => {
        assert.equal(err.code, 'cap_exceeded');
        assert.equal(err.cap, 'spawns_per_run');
        return true;
    });
});

test('enforceCap throw cuando se alcanza MAX_PER_COMBINATION para una combo', () => {
    const state = { spawns_total: 0, per_combo: { 'guru::cerebras': smoke.MAX_PER_COMBINATION } };
    assert.throws(() => smoke.enforceCap(state, 'per_combination', 'guru::cerebras'), (err) => {
        assert.equal(err.code, 'cap_exceeded');
        assert.equal(err.cap, 'per_combination');
        assert.equal(err.combo, 'guru::cerebras');
        return true;
    });
});

test('enforceCap permite cuando estado por debajo del cap', () => {
    const state = { spawns_total: 0, per_combo: {} };
    assert.doesNotThrow(() => smoke.enforceCap(state, 'spawns_per_run'));
    assert.doesNotThrow(() => smoke.enforceCap(state, 'per_combination', 'guru::cerebras'));
});

test('enforceCap throw para kind desconocido', () => {
    assert.throws(() => smoke.enforceCap({}, 'desconocido'), /kind desconocido/);
});

// -----------------------------------------------------------------------------
// summarizeMatrix
// -----------------------------------------------------------------------------
test('summarizeMatrix cuenta correctamente cada bucket', () => {
    const entries = [
        { skill: 'a', provider: 'p1', status: 'PASS' },
        { skill: 'a', provider: 'p2', status: 'PASS' },
        { skill: 'b', provider: 'p1', status: 'WARN' },
        { skill: 'b', provider: 'p2', status: 'FAIL' },
        { skill: 'c', provider: 'p1', status: 'SKIPPED' },
        { skill: 'c', provider: 'p2', status: 'N/A' },
    ];
    const s = smoke.summarizeMatrix(entries);
    assert.equal(s.pass, 2);
    assert.equal(s.warn, 1);
    assert.equal(s.fail, 1);
    assert.equal(s.skipped, 1);
    assert.equal(s.na, 1);
    assert.equal(s.total_combinations, 6);
    assert.equal(s.skills_llm_count, 3);
    assert.equal(s.providers_llm_count, 2);
});

// -----------------------------------------------------------------------------
// preCheckDummyIssues — CA-A12 (R6 mitigación)
// -----------------------------------------------------------------------------
test('preCheckDummyIssues OK cuando los dummy issues no existen', () => {
    const ghCallFn = (n) => ({ exists: false, errorReason: 'not_found' });
    const r = smoke.preCheckDummyIssues({ ghCallFn });
    assert.equal(r.ok, true);
});

test('preCheckDummyIssues RECHAZA cuando un dummy issue existe (collision)', () => {
    const ghCallFn = (n) => (n === 9999 ? { exists: true, errorReason: null } : { exists: false, errorReason: 'not_found' });
    const r = smoke.preCheckDummyIssues({ ghCallFn });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'dummy_issue_numbers_taken');
});

test('preCheckDummyIssues RECHAZA cuando hay network error (mitigación R6: NO degradar)', () => {
    const ghCallFn = (n) => ({ exists: false, errorReason: 'dns_timeout' });
    const r = smoke.preCheckDummyIssues({ ghCallFn });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'network_or_unknown_error');
});

test('preCheckDummyIssues skipped cuando no se inyecta ghCallFn (dry-run)', () => {
    const r = smoke.preCheckDummyIssues({});
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
});

// -----------------------------------------------------------------------------
// makeRunId — formato estable
// -----------------------------------------------------------------------------
test('makeRunId produce string único con timestamp embedded', () => {
    const id1 = smoke.makeRunId(1700000000000);
    const id2 = smoke.makeRunId(1700000000000);
    assert.match(id1, /^run-1700000000000-[a-f0-9]{8}$/);
    assert.notEqual(id1, id2, 'nonce debe diferenciar runs con mismo timestamp');
});

// -----------------------------------------------------------------------------
// auditLogFilePath — formato estable
// -----------------------------------------------------------------------------
test('auditLogFilePath formato canónico YYYY-MM-DD', () => {
    const p = smoke.auditLogFilePath('/repo/.pipeline', new Date(Date.UTC(2026, 4, 30, 12, 0, 0)));
    assert.equal(path.basename(p), 'multi-provider-smoke-test-2026-05-30.jsonl');
});

// -----------------------------------------------------------------------------
// HARNESS_SKILL_NAME es el string usado por dispatch-with-fallback (CA-A10)
// -----------------------------------------------------------------------------
test('HARNESS_SKILL_NAME coincide con allowlist hardcoded de dispatch-with-fallback', () => {
    // Defense in depth contra drift entre el harness y el dispatcher.
    const dispatch = require('../../agent-launcher/dispatch-with-fallback');
    assert.ok(dispatch.FORCED_OVERRIDE_ALLOWED_SKILLS.includes(smoke.HARNESS_SKILL_NAME),
        `${smoke.HARNESS_SKILL_NAME} debe estar en FORCED_OVERRIDE_ALLOWED_SKILLS`);
});

// -----------------------------------------------------------------------------
// buildSyntheticPayload — CA-A4
// -----------------------------------------------------------------------------
test('buildSyntheticPayload usa los issues dummy 9999/10000 sintéticamente', () => {
    const p = smoke.buildSyntheticPayload();
    assert.equal(p.meta.synthetic, true);
    assert.equal(p.meta.issue_primary, 9999);
    assert.equal(p.meta.issue_secondary, 10000);
    assert.match(p.prompt, /#9999/);
    assert.match(p.prompt, /#10000/);
    // Paths sintéticos también, no del repo real.
    assert.ok(p.paths.every(pp => pp.includes('smoke-test-fake-')));
});
