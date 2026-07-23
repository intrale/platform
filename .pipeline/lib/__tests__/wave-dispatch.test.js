// =============================================================================
// wave-dispatch.test.js — #4436.
//
// Módulo extraído de pulpo.js:realignAllowlistToActiveWave. Verifica que la
// realineación reductiva a la ola activa:
//   - re-materializa la allowlist a los issues ABIERTOS de la ola (excluye
//     completados);
//   - pasa por el gate auditado de partial-pause con el authorizedBy recibido;
//   - fail-safe: sin ola activa → no_active_wave; expansión vacía → empty_expansion
//     (nunca vacía la allowlist).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-wave-dispatch-'));
process.env.PIPELINE_DIR_OVERRIDE = TMP_DIR;

try { delete require.cache[require.resolve('../waves')]; } catch {}

const waves = require('../waves');
const dispatch = require('../wave-dispatch');

const PARTIAL_FILE = path.join(TMP_DIR, '.partial-pause.json');
const AUDIT_FILE = path.join(TMP_DIR, 'audit', 'partial-pause-mutations.jsonl');

function seed(active, deps = []) {
    fs.writeFileSync(path.join(TMP_DIR, 'waves.json'), JSON.stringify({
        version: '1.0',
        meta: { created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z', updated_by: 'System', source: 'manual' },
        active_wave: active,
        planned_waves: [],
        archived_waves: [],
        dependencies: deps,
    }, null, 2));
    waves.invalidateCache();
}
function cleanup() {
    try { fs.unlinkSync(PARTIAL_FILE); } catch {}
}

test('re-materializa la allowlist a los issues abiertos (excluye completados)', () => {
    seed({ number: 8, name: 'Ola 8', issues: [{ number: 100, status: 'in-progress' }, { number: 101, status: 'completed' }, { number: 102, status: 'pending' }] });
    cleanup();
    const res = dispatch.realignActiveWaveDispatch({ authorizedBy: 'dispatch:dashboard', source: 'dashboard/wave-dispatch' });
    assert.equal(res.ok, true);
    assert.equal(res.activeWave, 8);
    assert.deepEqual(res.allowlist.sort((a, b) => a - b), [100, 102]);
    const partial = JSON.parse(fs.readFileSync(PARTIAL_FILE, 'utf8'));
    assert.deepEqual(partial.allowed_issues.sort((a, b) => a - b), [100, 102]);
});

test('audita con el authorizedBy recibido (dispatch:dashboard)', () => {
    seed({ number: 8, name: 'Ola 8', issues: [{ number: 100, status: 'in-progress' }] });
    cleanup();
    dispatch.realignActiveWaveDispatch({ authorizedBy: 'dispatch:dashboard', source: 'dashboard/wave-dispatch' });
    const audit = fs.readFileSync(AUDIT_FILE, 'utf8');
    assert.ok(audit.includes('"authorized_by":"dispatch:dashboard"'));
});

test('sin ola activa → no_active_wave (no muta)', () => {
    seed(null);
    cleanup();
    const res = dispatch.realignActiveWaveDispatch({ authorizedBy: 'dispatch:dashboard' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'no_active_wave');
    assert.equal(fs.existsSync(PARTIAL_FILE), false);
});

test('ola sin issues abiertos → empty_expansion (fail-safe, no vacía la allowlist)', () => {
    seed({ number: 8, name: 'Ola 8', issues: [{ number: 101, status: 'completed' }] });
    cleanup();
    const res = dispatch.realignActiveWaveDispatch({ authorizedBy: 'dispatch:dashboard' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'empty_expansion');
});

test('default authorizedBy = wave-promote (compat con el uso del Pulpo)', () => {
    seed({ number: 8, name: 'Ola 8', issues: [{ number: 100, status: 'in-progress' }] });
    cleanup();
    const res = dispatch.realignActiveWaveDispatch({});
    assert.equal(res.ok, true);
    const audit = fs.readFileSync(AUDIT_FILE, 'utf8');
    assert.ok(audit.trim().split('\n').some((l) => l.includes('"authorized_by":"wave-promote"')));
});

test('cleanup', () => {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});
