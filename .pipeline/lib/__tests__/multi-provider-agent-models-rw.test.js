// =============================================================================
// multi-provider-agent-models-rw.test.js — Tests del módulo agent-models-rw (#3177).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const rw = require('../multi-provider/agent-models-rw');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mp-amrw-')); }

function validConfig(overrides = {}) {
    return {
        default_provider: 'anthropic',
        providers: {
            anthropic: {
                launcher: 'claude',
                model: 'claude-opus-4-7',
                spawn_args_template: ['-p', '{user_prompt}'],
                output_parser: 'anthropic-stream-json',
                quota_error_types: ['usage_limit_error'],
                supports_tool_use: true,
                prompt_caching: { supported: true, ttl_seconds_default: 300 },
                credentials_env: ['ANTHROPIC_API_KEY'],
            },
            deterministic: {
                launcher: 'node',
                model: 'deterministic',
                spawn_args_template: ['{script_path}', '{issue}', '--trabajando={trabajando_path}'],
                output_parser: 'none',
                quota_error_types: [],
                supports_tool_use: false,
                prompt_caching: { supported: false },
            },
        },
        skills: {
            'pipeline-dev': { provider: 'anthropic' },
            build: { provider: 'deterministic' },
        },
        ...overrides,
    };
}

test('readConfig devuelve el contenido parseado del archivo', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'agent-models.json');
    fs.writeFileSync(file, JSON.stringify(validConfig()));
    const got = rw.readConfig({ jsonPath: file });
    assert.equal(got.default_provider, 'anthropic');
    assert.deepEqual(Object.keys(got.skills), ['pipeline-dev', 'build']);
});

test('computeDiff detecta default_provider change', () => {
    const cur = validConfig();
    const next = validConfig({ default_provider: 'deterministic' });
    const diff = rw.computeDiff(cur, next);
    assert.deepEqual(diff.defaultProviderChanged, { before: 'anthropic', after: 'deterministic' });
});

test('computeDiff detecta skill provider change', () => {
    const cur = validConfig();
    const next = JSON.parse(JSON.stringify(cur));
    next.skills['pipeline-dev'].provider = 'deterministic';
    const diff = rw.computeDiff(cur, next);
    assert.equal(diff.skillsChanged.length, 1);
    assert.equal(diff.skillsChanged[0].name, 'pipeline-dev');
    assert.deepEqual(diff.skillsChanged[0].diff.provider, { before: 'anthropic', after: 'deterministic' });
});

test('computeDiff detecta fallbacks agregados', () => {
    const cur = validConfig();
    const next = JSON.parse(JSON.stringify(cur));
    next.skills['pipeline-dev'].fallbacks = ['deterministic'];
    const diff = rw.computeDiff(cur, next);
    assert.equal(diff.skillsChanged.length, 1);
    assert.deepEqual(diff.skillsChanged[0].diff.fallbacks, { before: [], after: ['deterministic'] });
});

test('computeDiff detecta skills added/removed', () => {
    const cur = validConfig();
    const next = JSON.parse(JSON.stringify(cur));
    next.skills['nuevo-skill'] = { provider: 'anthropic' };
    delete next.skills.build;
    const diff = rw.computeDiff(cur, next);
    assert.equal(diff.skillsAdded.length, 1);
    assert.equal(diff.skillsAdded[0].name, 'nuevo-skill');
    assert.equal(diff.skillsRemoved.length, 1);
    assert.equal(diff.skillsRemoved[0].name, 'build');
});

test('summarizeDiff produce lineas legibles', () => {
    const cur = validConfig();
    const next = JSON.parse(JSON.stringify(cur));
    next.default_provider = 'deterministic';
    next.skills['pipeline-dev'].provider = 'deterministic';
    const diff = rw.computeDiff(cur, next);
    const lines = rw.summarizeDiff(diff);
    assert.ok(lines.some(l => l.includes('Default provider:')));
    assert.ok(lines.some(l => l.startsWith('~ skill pipeline-dev')));
});

test('summarizeDiff devuelve "(sin cambios)" cuando no hay diff', () => {
    const cfg = validConfig();
    const diff = rw.computeDiff(cfg, cfg);
    assert.deepEqual(rw.summarizeDiff(diff), ['(sin cambios)']);
});

test('acquireLock crea archivo y release lo borra', () => {
    const dir = tmpDir();
    const lockPath = path.join(dir, 'test.lock');
    const release = rw.acquireLock({ lockPath });
    assert.ok(fs.existsSync(lockPath));
    release();
    assert.ok(!fs.existsSync(lockPath));
});

test('acquireLock rechaza si el lock está ocupado por proceso vivo no stale', () => {
    const dir = tmpDir();
    const lockPath = path.join(dir, 'test.lock');
    const parentPid = process.ppid;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: parentPid, started_at: Date.now() }));
    assert.throws(() => rw.acquireLock({ lockPath }), /lock ocupado|ELOCKED/);
});

test('acquireLock roba lock stale', () => {
    const dir = tmpDir();
    const lockPath = path.join(dir, 'test.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, started_at: 0 }));
    const release = rw.acquireLock({ lockPath });
    const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(holder.pid, process.pid);
    release();
});

test('writeConfig falla con errors[] si el config nuevo es inválido (schema)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'agent-models.json');
    fs.writeFileSync(file, JSON.stringify(validConfig()));
    const lockPath = path.join(dir, 'test.lock');
    const backupDir = path.join(dir, 'backups');
    const bad = validConfig({ default_provider: 'no-existe' });
    assert.throws(
        () => rw.writeConfig({
            newConfig: bad,
            jsonPath: file,
            backupDir,
            lockPath,
        }),
        (err) => err.errors && err.errors.length > 0
    );
});

test('writeConfig escribe atómicamente y crea backup', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'agent-models.json');
    const backupDir = path.join(dir, 'backups');
    const lockPath = path.join(dir, 'test.lock');
    fs.writeFileSync(file, JSON.stringify(validConfig(), null, 2));

    const next = validConfig();
    next.skills['pipeline-dev'].fallbacks = ['deterministic'];

    const result = rw.writeConfig({
        newConfig: next,
        jsonPath: file,
        backupDir,
        lockPath,
        now: 1000,
    });
    assert.equal(result.ok, true);
    assert.ok(result.backupPath);
    assert.ok(fs.existsSync(result.backupPath), 'backup debe existir');
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(written.skills['pipeline-dev'].fallbacks, ['deterministic']);
});

test('applyBackupRetention conserva sólo los últimos N backups (orden ISO)', () => {
    const dir = tmpDir();
    const backupDir = path.join(dir, 'b');
    fs.mkdirSync(backupDir);
    const stamps = ['2026-01-01T00-00-00.000Z', '2026-02-01T00-00-00.000Z', '2026-03-01T00-00-00.000Z'];
    for (const ts of stamps) {
        fs.writeFileSync(path.join(backupDir, `agent-models.${ts}.json`), '{}');
    }
    rw.applyBackupRetention({ backupDir, retention: 2, fsImpl: fs });
    const remaining = fs.readdirSync(backupDir).sort();
    assert.equal(remaining.length, 2);
    assert.ok(remaining[0].includes('2026-02-01'), 'el más viejo debe haberse borrado');
    assert.ok(remaining[1].includes('2026-03-01'));
});
