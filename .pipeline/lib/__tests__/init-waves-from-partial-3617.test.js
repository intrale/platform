// =============================================================================
// init-waves-from-partial-3617.test.js — Tests del bootstrap one-shot de
// waves.json (#3617).
//
// Cubre REQ-SEC-1..7 + CA-PO-2..7:
//   - Bootstrap happy path con shape válida
//   - Idempotencia: re-correr con active_wave seteado → no-op
//   - REQ-SEC-1: shape inválida → abort + entrada error en audit
//                * allowed_issues ausente
//                * elemento no-numérico
//                * clave desconocida (whitelist)
//                * payload > 10MB
//                * JSON inválido
//                * top-level array (no objeto)
//   - REQ-SEC-2: fail-closed → ok=false + audit con outcome=error
//   - REQ-SEC-4: audit jsonl con SHA-256 source/result + hostname + pid + ts
//   - Edge: .partial-pause.json no existe → noop ok=true
//   - Edge: allowed_issues=[] → noop ok=true
//   - Edge: duplicados en allowed_issues → deduplicados preservando orden
//   - Edge: issues como strings "123" / "#123" → normalizados a int
//   - Edge: tolerancia a meta keys conocidas (restored_at, reason, source, ...)
//
// Ejecutar:
//   node --test .pipeline/lib/__tests__/init-waves-from-partial-3617.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function setupTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-waves-3617-'));
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    delete require.cache[require.resolve('../init-waves-from-partial')];
    delete require.cache[require.resolve('../waves')];
    delete require.cache[require.resolve('../file-lock')];
    delete require.cache[require.resolve('../notify-telegram')];
    delete require.cache[require.resolve('../audit-log')];
    delete require.cache[require.resolve('../init-failed-state')];
    const mod = require('../init-waves-from-partial');
    return { dir, mod };
}

function teardownTmp(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    delete process.env.PIPELINE_DIR_OVERRIDE;
}

function writePartial(dir, content) {
    fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify(content));
}

function writeWavesRaw(dir, content) {
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(content, null, 2));
}

function readAuditLast(dir) {
    const auditPath = path.join(dir, 'audit', 'waves-bootstrap.jsonl');
    if (!fs.existsSync(auditPath)) return null;
    const content = fs.readFileSync(auditPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) return null;
    return JSON.parse(lines[lines.length - 1]);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test('#3617 happy path: bootstrapped con Wave 1 sintética', () => {
    const { dir, mod } = setupTmp();
    try {
        writePartial(dir, { allowed_issues: [3559, 3605, 3613] });
        const res = mod.initWavesFromPartial({ skipNotify: true });
        assert.equal(res.ok, true);
        assert.equal(res.action, 'bootstrapped');
        assert.deepEqual(res.issues, [3559, 3605, 3613]);
        assert.equal(typeof res.source_sha256, 'string');
        assert.equal(res.source_sha256.length, 64);
        assert.equal(typeof res.result_sha256, 'string');
        const waves = JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
        assert.equal(waves.version, '1.0');
        assert.equal(waves.active_wave.number, 1);
        assert.equal(waves.active_wave.name, 'Bootstrap from .partial-pause.json');
        assert.deepEqual(waves.active_wave.issues.map(i => i.number), [3559, 3605, 3613]);
        assert.equal(waves.meta.source, 'auto-bootstrap');
        assert.ok(waves.meta.note.includes('bootstrap automatic from .partial-pause.json on'));
        assert.ok(waves.meta.note.includes('source_sha256='));
    } finally { teardownTmp(dir); }
});

test('#3617 idempotente: active_wave ya seteado → no-op', () => {
    const { dir, mod } = setupTmp();
    try {
        writePartial(dir, { allowed_issues: [3559, 3605] });
        writeWavesRaw(dir, {
            version: '1.0',
            meta: { updated_at: new Date().toISOString(), updated_by: 'test', source: 'manual' },
            active_wave: { number: 5, name: 'Ya estaba', issues: [{ number: 999 }] },
            planned_waves: [],
            archived_waves: [],
            dependencies: [],
        });
        const res = mod.initWavesFromPartial({ skipNotify: true });
        assert.equal(res.ok, true);
        assert.equal(res.action, 'noop');
        assert.equal(res.reason, 'active_wave_already_set');
        const waves = JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
        assert.equal(waves.active_wave.number, 5);
        assert.equal(waves.active_wave.name, 'Ya estaba');
    } finally { teardownTmp(dir); }
});

test('#3617 edge: .partial-pause.json no existe → noop ok', () => {
    const { dir, mod } = setupTmp();
    try {
        const res = mod.initWavesFromPartial({ skipNotify: true });
        assert.equal(res.ok, true);
        assert.equal(res.action, 'noop');
        assert.equal(res.reason, 'partial_pause_empty');
    } finally { teardownTmp(dir); }
});

test('#3617 edge: allowed_issues=[] → noop ok', () => {
    const { dir, mod } = setupTmp();
    try {
        writePartial(dir, { allowed_issues: [] });
        const res = mod.initWavesFromPartial({ skipNotify: true });
        assert.equal(res.ok, true);
        assert.equal(res.action, 'noop');
        assert.equal(res.reason, 'partial_pause_empty');
        const audit = readAuditLast(dir);
        assert.equal(audit.outcome, 'noop');
        assert.equal(audit.imported_count, 0);
    } finally { teardownTmp(dir); }
});

test('#3617 REQ-SEC-1: allowed_issues ausente → abort error', () => {
    const { dir, mod } = setupTmp();
    try {
        writePartial(dir, { created_at: '2026-05-29' });
        const res = mod.initWavesFromPartial({ skipNotify: true });
        assert.equal(res.ok, false);
        assert.equal(res.action, 'error');
        assert.ok(res.reason.includes('allowed_issues'));
        assert.equal(fs.existsSync(path.join(dir, 'waves.json')), false);
        const audit = readAuditLast(dir);
        assert.equal(audit.outcome, 'error');
    } finally { teardownTmp(dir); }
});

test('#3617 REQ-SEC-1: elemento no-numérico → abort error', () => {
    const { dir, mod } = setupTmp();
    try {
        writePartial(dir, { allowed_issues: [3559, 'foo-bar', 3605] });
        const res = mod.initWavesFromPartial({ skipNotify: true });
        assert.equal(res.ok, false);
        assert.equal(res.action, 'error');
        assert.ok(res.errors.some(e => /elemento inválido/i.test(e)));
        assert.equal(fs.existsSync(path.join(dir, 'waves.json')), false);
    } finally { teardownTmp(dir); }
});

test('#3617 REQ-SEC-1: clave desconocida no admitida → abort error', () => {
    const { dir, mod } = setupTmp();
    try {
        writePartial(dir, { allowed_issues: [3559], foo: 'bar', evil_field: 42 });
        const res = mod.initWavesFromPartial({ skipNotify: true });
        assert.equal(res.ok, false);
        assert.equal(res.action, 'error');
        assert.ok(res.errors.some(e => e.includes('foo')));
        assert.ok(res.errors.some(e => e.includes('evil_field')));
        assert.equal(fs.existsSync(path.join(dir, 'waves.json')), false);
    } finally { teardownTmp(dir); }
});

test('#3617 REQ-SEC-1: payload > 10MB → abort error', () => {
    const { dir, mod } = setupTmp();
    try {
        const giantArr = new Array(500000).fill(3559);
        writePartial(dir, { allowed_issues: giantArr, padding: 'x'.repeat(11 * 1024 * 1024) });
        const res = mod.initWavesFromPartial({ skipNotify: true });
        assert.equal(res.ok, false);
        assert.equal(res.action, 'error');
        const errStr = (res.reason || '') + ' ' + (res.errors || []).join('; ');
        assert.ok(errStr.includes('máximo permitido'));
        assert.equal(fs.existsSync(path.join(dir, 'waves.json')), false);
    } finally { teardownTmp(dir); }
});

test('#3617 REQ-SEC-1: JSON inválido → abort error', () => {
    const { dir, mod } = setupTmp();
    try {
        fs.writeFileSync(path.join(dir, '.partial-pause.json'), '{ not valid json ');
        const res = mod.initWavesFromPartial({ skipNotify: true });
        assert.equal(res.ok, false);
        assert.equal(res.action, 'error');
        assert.ok(res.errors.some(e => e.includes('JSON inválido')));
    } finally { teardownTmp(dir); }
});

test('#3617 REQ-SEC-1: top-level array → abort error', () => {
    const { dir, mod } = setupTmp();
    try {
        fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify([3559, 3605]));
        const res = mod.initWavesFromPartial({ skipNotify: true });
        assert.equal(res.ok, false);
        assert.equal(res.action, 'error');
        assert.ok(res.errors.some(e => e.includes('top-level')));
    } finally { teardownTmp(dir); }
});

test('#3617 REQ-SEC-2: fail-closed sin escribir waves.json', () => {
    const { dir, mod } = setupTmp();
    try {
        writePartial(dir, { allowed_issues: [3559], unknown_key: 'rejected' });
        const res = mod.initWavesFromPartial({ skipNotify: true });
        assert.equal(res.ok, false);
        assert.equal(fs.existsSync(path.join(dir, 'waves.json')), false);
        const audit = readAuditLast(dir);
        assert.equal(audit.outcome, 'error');
        assert.ok(Array.isArray(audit.errors));
        assert.ok(audit.errors.length > 0);
    } finally { teardownTmp(dir); }
});

test('#3617 REQ-SEC-4: audit entry con SHA-256 source/result + hostname + pid + ts', () => {
    const { dir, mod } = setupTmp();
    try {
        writePartial(dir, { allowed_issues: [3559, 3605] });
        const res = mod.initWavesFromPartial({ skipNotify: true });
        assert.equal(res.ok, true);
        const audit = readAuditLast(dir);
        assert.ok(audit);
        assert.equal(audit.outcome, 'ok');
        assert.equal(audit.imported_count, 2);
        assert.deepEqual(audit.imported_issues, [3559, 3605]);
        assert.equal(typeof audit.source_sha256, 'string');
        assert.equal(audit.source_sha256.length, 64);
        assert.equal(typeof audit.result_sha256, 'string');
        assert.equal(audit.result_sha256.length, 64);
        assert.equal(typeof audit.pid, 'number');
        assert.equal(typeof audit.hostname, 'string');
        assert.ok(audit.ts && /^\d{4}-\d{2}-\d{2}T/.test(audit.ts));
        assert.equal(audit.source, 'auto-bootstrap');
    } finally { teardownTmp(dir); }
});

test('#3617 edge: duplicados → deduplicados preservando orden', () => {
    const { dir, mod } = setupTmp();
    try {
        writePartial(dir, { allowed_issues: [3605, 3559, 3559, 3605, 3613] });
        const res = mod.initWavesFromPartial({ skipNotify: true });
        assert.equal(res.ok, true);
        assert.deepEqual(res.issues, [3605, 3559, 3613]);
    } finally { teardownTmp(dir); }
});

test('#3617 edge: strings "123" / "#123" → normalizados a int', () => {
    const { dir, mod } = setupTmp();
    try {
        writePartial(dir, { allowed_issues: ['3559', '#3605', 3613] });
        const res = mod.initWavesFromPartial({ skipNotify: true });
        assert.equal(res.ok, true);
        assert.deepEqual(res.issues, [3559, 3605, 3613]);
    } finally { teardownTmp(dir); }
});

test('#3617 edge: tolerancia a meta keys conocidas', () => {
    const { dir, mod } = setupTmp();
    try {
        writePartial(dir, {
            allowed_issues: [3559],
            restored_at: '2026-05-29T10:00:00Z',
            reason: 'Leo authorized manual',
            source: 'telegram',
            created_at: '2026-05-28T00:00:00Z',
        });
        const res = mod.initWavesFromPartial({ skipNotify: true });
        assert.equal(res.ok, true);
        assert.equal(res.action, 'bootstrapped');
    } finally { teardownTmp(dir); }
});
