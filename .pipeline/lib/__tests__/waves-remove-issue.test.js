// =============================================================================
// waves-remove-issue.test.js — Tests de `removeIssueFromWave` (#4377 CA-2/7/9).
//
// Cubre:
//   (1) remove sobre planificada OK y re-normaliza (issue fuera, resto intacto).
//   (2) no-op idempotente si el issue no pertenece (sin escritura espuria).
//   (3) rechazo sobre ola ACTIVA (Política A04 / REQ-SEC-3).
//   (4) rechazo si la ola planificada no existe.
//   (5) rechazo si issueNumber es inválido.
//   (6) fallo parcial (rename falla) deja estado consistente (CA-7) + sin .tmp.
//   (7) audit trail: meta.updated_by/source/note persistidos (REQ-SEC-6).
//
// Ejecutar:  node --test .pipeline/lib/__tests__/waves-remove-issue.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let waves; // se re-requiere con PIPELINE_DIR_OVERRIDE seteado

function setupTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-remove-'));
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    delete require.cache[require.resolve('../waves')];
    waves = require('../waves');
    waves.invalidateCache();
    return dir;
}

function teardownTmp(dir) {
    if (waves) waves.invalidateCache();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    delete process.env.PIPELINE_DIR_OVERRIDE;
}

function sampleState() {
    return {
        version: '1.0',
        meta: {
            created_at: '2026-06-01T00:00:00.000Z',
            updated_at: '2026-06-01T00:00:00.000Z',
            updated_by: 'System',
            source: 'manual',
            note: 'fixture',
        },
        active_wave: {
            number: 1,
            name: 'Ola activa',
            goal: 'objetivo',
            started_at: '2026-06-01T10:00:00.000Z',
            issues: [{ number: 3451, status: 'in_progress' }],
        },
        planned_waves: [
            {
                number: 2,
                name: 'Ola planificada A',
                goal: 'g',
                issues: [{ number: 3460 }, { number: 3461 }],
            },
            {
                number: 3,
                name: 'Ola planificada B',
                issues: [{ number: 3470 }],
            },
        ],
        archived_waves: [],
        dependencies: [],
    };
}

function writeFixture(dir, state) {
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(state, null, 2));
}
function readDisk(dir) {
    return JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
}

// ─── (1) remove OK ────────────────────────────────────────────────────────

test('removeIssueFromWave: remueve de ola planificada y persiste (CA-2)', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        waves.removeIssueFromWave(2, 3460, { updated_by: 'Planner', note: 'mal asignado' });
        const fresh = readDisk(dir);
        const wave2 = fresh.planned_waves.find((w) => w.number === 2);
        const nums = wave2.issues.map((i) => i.number);
        assert.deepEqual(nums, [3461], 'solo queda 3461 en la ola 2');
        // Otras olas intactas.
        assert.deepEqual(fresh.planned_waves.find((w) => w.number === 3).issues.map((i) => i.number), [3470]);
        assert.deepEqual(fresh.active_wave.issues.map((i) => i.number), [3451]);
    } finally {
        teardownTmp(dir);
    }
});

test('removeIssueFromWave: tolera "#123" y " 123 " en issueNumber', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        waves.removeIssueFromWave(2, ' #3461 ');
        const wave2 = readDisk(dir).planned_waves.find((w) => w.number === 2);
        assert.deepEqual(wave2.issues.map((i) => i.number), [3460]);
    } finally {
        teardownTmp(dir);
    }
});

// ─── (2) no-op idempotente ────────────────────────────────────────────────

test('removeIssueFromWave: no-op idempotente si el issue no pertenece (CA-2)', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        const before = fs.readFileSync(path.join(dir, 'waves.json'), 'utf8');
        // 9999 no está en la ola 2 → no-op, sin escritura espuria.
        waves.removeIssueFromWave(2, 9999);
        const after = fs.readFileSync(path.join(dir, 'waves.json'), 'utf8');
        assert.equal(after, before, 'el archivo no debe cambiar en un no-op');
    } finally {
        teardownTmp(dir);
    }
});

// ─── (3) rechazo sobre ola activa (Política A04) ──────────────────────────

test('removeIssueFromWave: rechaza sobre la ola ACTIVA (Política A04 / REQ-SEC-3)', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        const before = fs.readFileSync(path.join(dir, 'waves.json'), 'utf8');
        assert.throws(
            () => waves.removeIssueFromWave(1, 3451),
            /no se permite desasociar sobre la ola activa/i,
        );
        const after = fs.readFileSync(path.join(dir, 'waves.json'), 'utf8');
        assert.equal(after, before, 'rechazo A04 no debe tocar el estado');
    } finally {
        teardownTmp(dir);
    }
});

// ─── (4) ola inexistente ──────────────────────────────────────────────────

test('removeIssueFromWave: rechaza si la ola planificada no existe', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        assert.throws(
            () => waves.removeIssueFromWave(99, 3460),
            /ola planificada 99 no existe/i,
        );
    } finally {
        teardownTmp(dir);
    }
});

// ─── (5) issueNumber inválido ─────────────────────────────────────────────

test('removeIssueFromWave: rechaza issueNumber inválido', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        assert.throws(() => waves.removeIssueFromWave(2, 'abc'), /inválido/i);
        assert.throws(() => waves.removeIssueFromWave(2, -5), /inválido/i);
        assert.throws(() => waves.removeIssueFromWave(2, 0), /inválido/i);
    } finally {
        teardownTmp(dir);
    }
});

// ─── (6) fallo parcial → estado consistente (CA-7) ────────────────────────

test('removeIssueFromWave: fallo de rename deja el estado original intacto (CA-7)', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        const before = fs.readFileSync(path.join(dir, 'waves.json'), 'utf8');

        // Inyectar fallo NO reintentables en el rename atómico (mid-write).
        const origRename = fs.renameSync;
        fs.renameSync = () => { const e = new Error('disco lleno simulado'); e.code = 'EIO'; throw e; };
        try {
            assert.throws(() => waves.removeIssueFromWave(2, 3460), /EIO|disco lleno/i);
        } finally {
            fs.renameSync = origRename;
        }

        const after = fs.readFileSync(path.join(dir, 'waves.json'), 'utf8');
        assert.equal(after, before, 'el archivo original debe quedar intacto ante fallo parcial');
        assert.ok(!fs.existsSync(path.join(dir, 'waves.json.tmp')), 'no debe quedar .tmp huérfano');
    } finally {
        teardownTmp(dir);
    }
});

// ─── (7) audit trail ──────────────────────────────────────────────────────

test('removeIssueFromWave: registra meta.updated_by/source/note (REQ-SEC-6)', () => {
    const dir = setupTmp();
    try {
        writeFixture(dir, sampleState());
        waves.removeIssueFromWave(2, 3460, {
            updated_by: 'Commander', source: 'test-src', note: 'nota forense',
        });
        const meta = readDisk(dir).meta;
        assert.equal(meta.updated_by, 'Commander');
        assert.equal(meta.source, 'test-src');
        assert.equal(meta.note, 'nota forense');
    } finally {
        teardownTmp(dir);
    }
});
