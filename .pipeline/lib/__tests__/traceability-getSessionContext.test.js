// Tests de getSessionContext (issue #3088 / CA-6)
// Valida lookup determinístico del audit trail multi-provider sin inferencia.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Aislar el activity-log a un tmp dir antes de cargar el módulo.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-traceability-ctx-'));
fs.mkdirSync(path.join(TMP_DIR, '.claude'), { recursive: true });
process.env.CLAUDE_PROJECT_DIR = TMP_DIR;
process.env.PIPELINE_REPO_ROOT = TMP_DIR;

delete require.cache[require.resolve('../traceability')];
const trace = require('../traceability');

const LOG_FILE = trace.LOG_FILE;

function resetLog() {
    try { fs.unlinkSync(LOG_FILE); } catch (_) {}
}

function appendStart(evt) {
    const line = JSON.stringify(Object.assign({ event: 'session:start' }, evt)) + '\n';
    fs.appendFileSync(LOG_FILE, line, 'utf8');
}

test('getSessionContext devuelve null si (issue, skill) no existe', () => {
    resetLog();
    appendStart({ skill: 'other', issue: 999, provider: 'anthropic', model: 'm', cli_version: 'v1', ts: '2026-05-13T00:00:00Z' });
    const ctx = trace.getSessionContext({ issue: 3088, skill: 'pipeline-dev' });
    assert.equal(ctx, null);
});

test('getSessionContext devuelve null si falta issue o skill', () => {
    resetLog();
    assert.equal(trace.getSessionContext({ issue: 1 }), null);
    assert.equal(trace.getSessionContext({ skill: 'x' }), null);
    assert.equal(trace.getSessionContext({}), null);
});

test('getSessionContext devuelve la ÚLTIMA sesión matching (issue, skill)', () => {
    resetLog();
    appendStart({ skill: 'qa', issue: 100, provider: 'anthropic', model: 'claude-sonnet-4-6', cli_version: '0.7.1', ts: '2026-05-01T00:00:00Z' });
    appendStart({ skill: 'qa', issue: 100, provider: 'openai', model: 'gpt-5-codex', cli_version: 'codex-cli-1.4.0', ts: '2026-05-10T00:00:00Z' });
    const ctx = trace.getSessionContext({ issue: 100, skill: 'qa' });
    assert.ok(ctx);
    assert.equal(ctx.provider, 'openai');
    assert.equal(ctx.model, 'gpt-5-codex');
    assert.equal(ctx.cli_version, 'codex-cli-1.4.0');
    assert.equal(ctx.ts_session_start, '2026-05-10T00:00:00Z');
});

test('getSessionContext cae a "unknown" cuando un campo está vacío en el log', () => {
    resetLog();
    appendStart({ skill: 's', issue: 1, provider: '', model: null, cli_version: undefined, ts: '2026-05-12T00:00:00Z' });
    const ctx = trace.getSessionContext({ issue: 1, skill: 's' });
    assert.equal(ctx.provider, 'unknown');
    assert.equal(ctx.model, 'unknown');
    assert.equal(ctx.cli_version, 'unknown');
});

test('getSessionContext.first_with_combo true cuando es la primera sesión del skill con esa combinación', () => {
    resetLog();
    appendStart({ skill: 'pipeline-dev', issue: 11, provider: 'anthropic', model: 'm1', cli_version: 'v1', ts: '2026-05-01T00:00:00Z' });
    appendStart({ skill: 'pipeline-dev', issue: 12, provider: 'anthropic', model: 'm2', cli_version: 'v2', ts: '2026-05-02T00:00:00Z' });
    appendStart({ skill: 'pipeline-dev', issue: 13, provider: 'openai', model: 'codex', cli_version: 'v3', ts: '2026-05-03T00:00:00Z' });
    const ctx = trace.getSessionContext({ issue: 13, skill: 'pipeline-dev', recentWindow: 5 });
    assert.equal(ctx.first_with_combo, true);
    assert.equal(ctx.recent_switch, true);
});

test('getSessionContext.first_with_combo false cuando la combinación ya apareció antes', () => {
    resetLog();
    appendStart({ skill: 'qa', issue: 1, provider: 'anthropic', model: 'sonnet', cli_version: 'v1', ts: '2026-05-01T00:00:00Z' });
    appendStart({ skill: 'qa', issue: 2, provider: 'anthropic', model: 'sonnet', cli_version: 'v1', ts: '2026-05-02T00:00:00Z' });
    const ctx = trace.getSessionContext({ issue: 2, skill: 'qa', recentWindow: 5 });
    assert.equal(ctx.first_with_combo, false);
});

test('getSessionContext.recent_switch false cuando todas las sesiones del skill usan la misma combinación', () => {
    resetLog();
    for (let i = 1; i <= 5; i++) {
        appendStart({ skill: 'builder', issue: i, provider: 'deterministic', model: 'deterministic', cli_version: 'n/a', ts: `2026-05-0${i}T00:00:00Z` });
    }
    const ctx = trace.getSessionContext({ issue: 5, skill: 'builder', recentWindow: 5 });
    assert.equal(ctx.recent_switch, false);
    assert.equal(ctx.first_with_combo, false);
});

test('getSessionContext ignora eventos session:end y sólo lee session:start', () => {
    resetLog();
    appendStart({ skill: 'qa', issue: 7, provider: 'anthropic', model: 'sonnet', cli_version: '0.1', ts: '2026-05-01T00:00:00Z' });
    // session:end con metadata "mentirosa" — debe ignorarse.
    fs.appendFileSync(LOG_FILE, JSON.stringify({ event: 'session:end', skill: 'qa', issue: 7, provider: 'FAKE', model: 'FAKE', cli_version: 'FAKE', ts: '2026-05-01T00:01:00Z' }) + '\n', 'utf8');
    const ctx = trace.getSessionContext({ issue: 7, skill: 'qa' });
    assert.equal(ctx.provider, 'anthropic');
    assert.equal(ctx.model, 'sonnet');
    assert.equal(ctx.cli_version, '0.1');
});

test('getSessionContext es resiliente a líneas corruptas (no throw)', () => {
    resetLog();
    fs.appendFileSync(LOG_FILE, '{"event":"session:start","this-is-not-valid-json\n', 'utf8');
    fs.appendFileSync(LOG_FILE, 'just garbage\n', 'utf8');
    appendStart({ skill: 'x', issue: 99, provider: 'anthropic', model: 'sonnet', cli_version: '0.1', ts: '2026-05-01T00:00:00Z' });
    const ctx = trace.getSessionContext({ issue: 99, skill: 'x' });
    assert.ok(ctx);
    assert.equal(ctx.provider, 'anthropic');
});

test('getSessionContext devuelve null si el log no existe', () => {
    resetLog();
    const ctx = trace.getSessionContext({ issue: 1, skill: 's' });
    assert.equal(ctx, null);
});

test('getSessionContext NO infiere provider por substring del model', () => {
    // Aún si model es "gpt-5-codex", si provider del audit dice "anthropic" lo
    // respeta. SEC-3 — prohibido inferir.
    resetLog();
    appendStart({ skill: 's', issue: 1, provider: 'anthropic', model: 'gpt-5-codex', cli_version: '0.1', ts: '2026-05-01T00:00:00Z' });
    const ctx = trace.getSessionContext({ issue: 1, skill: 's' });
    assert.equal(ctx.provider, 'anthropic'); // tal cual está, sin inferencia
    assert.equal(ctx.model, 'gpt-5-codex');
});

test('getSessionContext propaga campos opcionales (git_sha_provider_adapter)', () => {
    resetLog();
    appendStart({
        skill: 's', issue: 1,
        provider: 'anthropic', model: 'sonnet', cli_version: '0.1',
        git_sha_provider_adapter: 'a'.repeat(40),
        ts: '2026-05-01T00:00:00Z',
    });
    const ctx = trace.getSessionContext({ issue: 1, skill: 's' });
    assert.equal(ctx.git_sha_provider_adapter, 'a'.repeat(40));
    assert.equal(ctx.ts_session_start, '2026-05-01T00:00:00Z');
});
