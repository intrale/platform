// =============================================================================
// waves-archive.test.js — Tests del archivado explícito de olas (#4378, CA-5/CA-9).
//
// Cubre:
//   - Archivado feliz de una ola ACTIVA (todos los issues completados) →
//     archived_waves[] conservando issues, sale de active, auditoría meta.
//   - Archivado feliz de una ola PLANIFICADA → archived_waves[], sale de planned.
//   - Conservación de issues (CA-5): la entrada archivada preserva el array
//     completo de issues.
//   - Idempotencia (CA-9): re-archivar = no-op seguro, sin duplicar.
//   - Política A04: rechazo de la activa con issues no cerrados sin force;
//     éxito con force.
//   - Path safety (CA-7): waveNumber inválido (float/negativo/0/NaN) → throw
//     BAD_INPUT antes de tocar nada.
//   - Fallo parcial + recovery boot-time (recoverIncompleteArchive) deja el
//     estado consistente, sin fantasma ni corrupción; NO toca .partial-pause.json.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/waves-archive.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function setupTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-archive-'));
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    // TTL bajo para tests de recovery (50ms en vez de 30s).
    process.env.WAVE_PROMOTE_RECOVERY_TTL_MS = '50';
    delete require.cache[require.resolve('../waves')];
    const waves = require('../waves');
    waves.invalidateCache();
    return { dir, waves };
}

function teardownTmp(dir) {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    delete process.env.WAVE_PROMOTE_RECOVERY_TTL_MS;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function seedWaves(dir, state) {
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(state, null, 2));
}
function readWaves(dir) {
    return JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
}

function sampleState({ activeCompleted = true } = {}) {
    return {
        version: '1.0',
        meta: {
            created_at: '2026-06-20T10:00:00.000Z',
            updated_at: '2026-06-20T10:00:00.000Z',
            updated_by: 'System',
            source: 'manual',
        },
        active_wave: {
            number: 7,
            name: 'Ola N+7',
            goal: 'objetivo activa',
            started_at: '2026-06-20T10:00:00.000Z',
            issues: [
                { number: 3451, status: activeCompleted ? 'completed' : 'in-progress' },
                { number: 3452, status: 'completed' },
            ],
        },
        planned_waves: [
            { number: 8, name: 'Ola N+8', goal: 'objetivo planificada', issues: [{ number: 3520 }, { number: 3521 }] },
        ],
        archived_waves: [],
        dependencies: [],
    };
}

// ─── CA-5 — Archivado feliz de la ACTIVA (issues completados) ───────────────

test('CA-5 — archiva la ola activa con issues completados: pasa a archived, sale de active', () => {
    const { dir, waves } = setupTmp();
    try {
        seedWaves(dir, sampleState({ activeCompleted: true }));
        const res = waves.archiveWave(7, { updated_by: 'Leo', source: 'test', note: 'cierre ola 7' });
        assert.equal(res.archived, true);
        assert.equal(res.source, 'active');
        assert.equal(res.issuesPreserved, 2);

        const state = readWaves(dir);
        assert.equal(state.active_wave, null, 'la activa quedó vacía');
        const arch = state.archived_waves.find((w) => w.number === 7);
        assert.ok(arch, 'la ola 7 está en archived_waves');
        // CA-5: conserva TODOS los issues.
        assert.equal(arch.issues.length, 2);
        assert.deepEqual(arch.issues.map((i) => i.number), [3451, 3452]);
        // Auditoría (CA-5).
        assert.equal(state.meta.updated_by, 'Leo');
        assert.equal(state.meta.source, 'test');
        assert.ok(typeof state.meta.updated_at === 'string');
        assert.equal(arch.issues_completed, 2);
    } finally {
        teardownTmp(dir);
    }
});

// ─── CA-5 — Archivado feliz de una PLANIFICADA ──────────────────────────────

test('CA-5 — archiva una ola planificada: pasa a archived, sale de planned, activa intacta', () => {
    const { dir, waves } = setupTmp();
    try {
        seedWaves(dir, sampleState());
        const res = waves.archiveWave(8, { updated_by: 'Leo' });
        assert.equal(res.archived, true);
        assert.equal(res.source, 'planned');

        const state = readWaves(dir);
        assert.equal(state.planned_waves.find((w) => w.number === 8), undefined, 'salió de planned');
        assert.ok(state.active_wave && state.active_wave.number === 7, 'activa intacta');
        const arch = state.archived_waves.find((w) => w.number === 8);
        assert.ok(arch);
        assert.deepEqual(arch.issues.map((i) => i.number), [3520, 3521]);
    } finally {
        teardownTmp(dir);
    }
});

// ─── CA-9 — Idempotencia: re-archivar = no-op sin duplicar ──────────────────

test('CA-9 — re-archivar una ola ya archivada es no-op seguro (sin duplicar)', () => {
    const { dir, waves } = setupTmp();
    try {
        seedWaves(dir, sampleState());
        waves.archiveWave(8, {});
        const res2 = waves.archiveWave(8, {});
        assert.equal(res2.archived, false);
        assert.equal(res2.reason, 'already-archived');

        const state = readWaves(dir);
        const matches = state.archived_waves.filter((w) => w.number === 8);
        assert.equal(matches.length, 1, 'no se duplicó en archived_waves');
    } finally {
        teardownTmp(dir);
    }
});

// ─── Política A04 — activa con issues no cerrados ───────────────────────────

test('A04 — rechaza archivar la activa con issues no cerrados sin force', () => {
    const { dir, waves } = setupTmp();
    try {
        seedWaves(dir, sampleState({ activeCompleted: false }));
        assert.throws(() => waves.archiveWave(7, {}), (e) => {
            assert.equal(e.code, 'ACTIVE_IN_FLIGHT');
            return true;
        });
        // No mutó el estado.
        const state = readWaves(dir);
        assert.ok(state.active_wave && state.active_wave.number === 7);
        assert.equal(state.archived_waves.length, 0);
    } finally {
        teardownTmp(dir);
    }
});

test('A04 — archiva la activa con issues no cerrados si force=true', () => {
    const { dir, waves } = setupTmp();
    try {
        seedWaves(dir, sampleState({ activeCompleted: false }));
        const res = waves.archiveWave(7, { force: true });
        assert.equal(res.archived, true);
        const state = readWaves(dir);
        assert.equal(state.active_wave, null);
        assert.ok(state.archived_waves.find((w) => w.number === 7));
    } finally {
        teardownTmp(dir);
    }
});

// ─── CA-7 — Path safety: waveNumber inválido ────────────────────────────────

test('CA-7 — waveNumber inválido (float/negativo/0/NaN/string) → BAD_INPUT sin tocar estado', () => {
    const { dir, waves } = setupTmp();
    try {
        seedWaves(dir, sampleState());
        for (const bad of [1.5, -1, 0, NaN, '7', '../etc', null, undefined]) {
            assert.throws(() => waves.archiveWave(bad, {}), (e) => {
                assert.equal(e.code, 'BAD_INPUT');
                return true;
            }, `esperaba BAD_INPUT para ${JSON.stringify(bad)}`);
        }
        // Estado inalterado.
        const state = readWaves(dir);
        assert.equal(state.archived_waves.length, 0);
    } finally {
        teardownTmp(dir);
    }
});

// ─── NOT_FOUND — ola inexistente ────────────────────────────────────────────

test('archiveWave sobre una ola inexistente → NOT_FOUND', () => {
    const { dir, waves } = setupTmp();
    try {
        seedWaves(dir, sampleState());
        assert.throws(() => waves.archiveWave(99, {}), (e) => {
            assert.equal(e.code, 'NOT_FOUND');
            return true;
        });
    } finally {
        teardownTmp(dir);
    }
});

// ─── CA-9 — Fallo parcial + recovery boot-time ──────────────────────────────

test('CA-9 — recovery: marker stale + snapshot → restaura estado pre-archive sin fantasma', () => {
    const { dir, waves } = setupTmp();
    try {
        const original = sampleState();
        seedWaves(dir, original);

        // Simular un crash mid-archive: escribir un marker + snapshot manualmente
        // (como lo dejaría archiveWave tras la fase 'snapshot'), y una mutación
        // "a medias" en waves.json (ola sacada de active pero AÚN no en archived
        // → fantasma). El recovery debe volver al snapshot íntegro.
        const p = waves._paths();
        const bakPath = path.join(p.ARCHIVED_DIR, 'waves-archive-rollback.TEST.json');
        fs.mkdirSync(p.ARCHIVED_DIR, { recursive: true });
        fs.copyFileSync(p.WAVES_FILE, bakPath);
        const crypto = require('node:crypto');
        const sha = crypto.createHash('sha256').update(fs.readFileSync(bakPath)).digest('hex');
        const marker = {
            started_at: '2026-06-20T11:00:00.000Z',
            pid: 999999,
            phase: 'writing',
            op: 'archive',
            wave_number: 7,
            source_kind: 'active',
            waves_bak_path: bakPath,
            waves_bak_sha: sha,
            waves_existed: true,
            partial_bak_path: null,
        };
        fs.writeFileSync(p.ARCHIVE_MARKER_FILE, JSON.stringify(marker, null, 2));

        // Corromper waves.json a un estado "fantasma" (activa vacía, sin archivar).
        const ghost = readWaves(dir);
        ghost.active_wave = null;
        seedWaves(dir, ghost);

        // Envejecer el marker por encima del TTL (50ms).
        const past = Date.now() / 1000 - 5;
        fs.utimesSync(p.ARCHIVE_MARKER_FILE, past, past);

        const rec = waves.recoverIncompleteArchive();
        assert.equal(rec.action, 'recovered');
        assert.equal(rec.wavesRestored, true);

        // Estado restaurado: activa 7 de vuelta, sin fantasma, sin archivar.
        waves.invalidateCache();
        const restored = readWaves(dir);
        assert.ok(restored.active_wave && restored.active_wave.number === 7, 'activa restaurada');
        assert.equal(restored.archived_waves.length, 0, 'sin archivado a medias');

        // Marker consumido.
        assert.equal(fs.existsSync(p.ARCHIVE_MARKER_FILE), false);
    } finally {
        teardownTmp(dir);
    }
});

test('CA-9 — recovery no-op cuando no hay marker; in_progress cuando el marker es fresco', () => {
    const { dir, waves } = setupTmp();
    try {
        seedWaves(dir, sampleState());
        assert.equal(waves.recoverIncompleteArchive().action, 'noop');

        // Marker fresco → in_progress.
        const p = waves._paths();
        fs.writeFileSync(p.ARCHIVE_MARKER_FILE, JSON.stringify({ phase: 'snapshot', wave_number: 7 }));
        const rec = waves.recoverIncompleteArchive();
        assert.equal(rec.action, 'in_progress');
    } finally {
        teardownTmp(dir);
    }
});

// ─── recovery NO toca .partial-pause.json (CA-6 diferido) ───────────────────

test('recovery de archive NO modifica .partial-pause.json (allowlist intacta)', () => {
    const { dir, waves } = setupTmp();
    try {
        seedWaves(dir, sampleState());
        const partialPath = path.join(dir, '.partial-pause.json');
        const partialContent = JSON.stringify({ allowed_issues: [111, 222], source: 'test' }, null, 2);
        fs.writeFileSync(partialPath, partialContent);

        const p = waves._paths();
        const bakPath = path.join(p.ARCHIVED_DIR, 'waves-archive-rollback.TEST2.json');
        fs.mkdirSync(p.ARCHIVED_DIR, { recursive: true });
        fs.copyFileSync(p.WAVES_FILE, bakPath);
        const crypto = require('node:crypto');
        const sha = crypto.createHash('sha256').update(fs.readFileSync(bakPath)).digest('hex');
        fs.writeFileSync(p.ARCHIVE_MARKER_FILE, JSON.stringify({
            started_at: '2026-06-20T11:00:00.000Z', pid: 999999, phase: 'writing', op: 'archive',
            wave_number: 7, source_kind: 'active',
            waves_bak_path: bakPath, waves_bak_sha: sha, waves_existed: true, partial_bak_path: null,
        }, null, 2));
        const past = Date.now() / 1000 - 5;
        fs.utimesSync(p.ARCHIVE_MARKER_FILE, past, past);

        const rec = waves.recoverIncompleteArchive();
        assert.equal(rec.action, 'recovered');
        // .partial-pause.json intacto (byte a byte).
        assert.equal(fs.readFileSync(partialPath, 'utf8'), partialContent);
    } finally {
        teardownTmp(dir);
    }
});

// ─── Fail-closed gate ───────────────────────────────────────────────────────

test('archiveWave bloqueado por fail-closed marker activo → ARCHIVE_BLOCKED', () => {
    const { dir, waves } = setupTmp();
    try {
        seedWaves(dir, sampleState());
        fs.writeFileSync(path.join(dir, 'wave-archive.failed.TEST.json'), JSON.stringify({ reason: 'test' }));
        assert.equal(waves.isWaveArchiveBlocked().blocked, true);
        assert.throws(() => waves.archiveWave(8, {}), (e) => {
            assert.equal(e.code, 'ARCHIVE_BLOCKED');
            return true;
        });
    } finally {
        teardownTmp(dir);
    }
});
