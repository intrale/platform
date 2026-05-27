// =============================================================================
// wave-promote-atomic.test.js — Tests de la transacción multi-archivo de
// /wave promote (#3520). Cubre CA-F1..F8 del issue.
//
// CA-F1  Test E2E con child_process.fork + SIGKILL inyectado entre los dos
//        writes → al boot, ambos archivos vuelven al estado pre-promote.
// CA-F2  Crash post-snapshot pre-apply (marker existe, pero waves.json/partial
//        sin tocar todavía) → recovery limpia marker sin romper estado.
// CA-F3  Marker fresco (< TTL) → recovery NO actúa (in_progress).
// CA-F4  Marker stale (> TTL) sin proceso vivo → rollback completo.
// CA-F5  Doble llamada al recovery (idempotente).
// CA-F6  SHA mismatch del .bak → recovery NO restaura, escribe .failed.<ts>.json.
// CA-F7  /wave promote (gate isWavePromoteBlocked) se bloquea cuando existe
//        wave-promote.failed.*.json activo.
// CA-F8  setPartialPauseAtomic ahora atómico (verificación de tmp+rename).
//
// Ejecutar:  node --test .pipeline/lib/__tests__/wave-promote-atomic.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

// Helper de aislamiento — cada test arranca con su propio PIPELINE_DIR.
function setupTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-promote-atomic-'));
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    // TTL bajo para tests (50ms en vez de 30s).
    process.env.WAVE_PROMOTE_RECOVERY_TTL_MS = '50';
    delete require.cache[require.resolve('../waves')];
    delete require.cache[require.resolve('../partial-pause')];
    const waves = require('../waves');
    const pp = require('../partial-pause');
    waves.invalidateCache();
    return { dir, waves, pp };
}

function teardownTmp(dir) {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    delete process.env.WAVE_PROMOTE_RECOVERY_TTL_MS;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function seedWaves(dir, state) {
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(state, null, 2));
}

function seedPartial(dir, allowed) {
    fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify({
        allowed_issues: allowed,
        created_at: '2026-05-01T00:00:00.000Z',
        source: 'test-seed',
    }, null, 2));
}

function readWaves(dir) {
    return JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
}
function readPartial(dir) {
    return JSON.parse(fs.readFileSync(path.join(dir, '.partial-pause.json'), 'utf8'));
}

function sampleWaves() {
    return {
        version: '1.0',
        meta: {
            created_at: '2026-04-20T10:00:00.000Z',
            updated_at: '2026-04-20T10:00:00.000Z',
            updated_by: 'System',
            source: 'manual',
        },
        active_wave: {
            number: 7,
            name: 'Ola N+7',
            started_at: '2026-04-20T10:00:00.000Z',
            issues: [{ number: 3451, status: 'in_progress' }],
        },
        planned_waves: [
            {
                number: 8,
                name: 'Ola N+8',
                issues: [{ number: 3520 }, { number: 3521 }],
            },
        ],
        archived_waves: [],
        dependencies: [],
    };
}

// ─── CA-F8 — setPartialPauseAtomic atómico + devuelve snapshot previo ──────

test('CA-F8 — setPartialPauseAtomic devuelve buffer y SHA del estado previo', () => {
    const { dir, pp } = setupTmp();
    try {
        seedPartial(dir, [100, 200, 300]);
        const prevContent = fs.readFileSync(path.join(dir, '.partial-pause.json'));

        const result = pp.setPartialPauseAtomic([3520, 3521], { source: 'test' });

        assert.equal(result.ok, true);
        assert.equal(result.existedBefore, true);
        assert.ok(Buffer.isBuffer(result.prevBuffer));
        assert.equal(result.prevBuffer.equals(prevContent), true);
        assert.equal(typeof result.prevSha, 'string');
        assert.equal(result.prevSha.length, 64); // SHA-256 hex
        assert.deepEqual(result.allowedIssues, [3520, 3521]);

        // Verificar que el archivo nuevo está escrito correctamente.
        const after = readPartial(dir);
        assert.deepEqual(after.allowed_issues, [3520, 3521]);
    } finally {
        teardownTmp(dir);
    }
});

test('CA-F8 — setPartialPauseAtomic con archivo ausente retorna prevBuffer=null', () => {
    const { dir, pp } = setupTmp();
    try {
        const result = pp.setPartialPauseAtomic([42], { source: 'test' });
        assert.equal(result.existedBefore, false);
        assert.equal(result.prevBuffer, null);
        assert.equal(result.prevSha, null);
        assert.deepEqual(result.allowedIssues, [42]);
    } finally {
        teardownTmp(dir);
    }
});

test('CA-F8 — setPartialPauseAtomic usa tmp+rename (no deja .tmp huérfano en éxito)', () => {
    const { dir, pp } = setupTmp();
    try {
        pp.setPartialPauseAtomic([1, 2, 3], { source: 'test' });
        const files = fs.readdirSync(dir);
        const tmpFiles = files.filter((f) => f.includes('.tmp.'));
        assert.equal(tmpFiles.length, 0, `tmp files huérfanos: ${tmpFiles.join(', ')}`);
    } finally {
        teardownTmp(dir);
    }
});

// ─── CA-F4 — Marker stale (> TTL) → rollback completo ──────────────────────

test('CA-F4 — recoverIncompletePromote con marker stale restaura ambos archivos', () => {
    const { dir, waves } = setupTmp();
    try {
        // 1) Estado inicial pre-promote.
        const initialWaves = sampleWaves();
        seedWaves(dir, initialWaves);
        seedPartial(dir, [3451]);

        // 2) Snapshot manual + marker (simulamos transacción en curso).
        const snap = waves._internal.snapshotForTransaction('2026-05-26T10-00-00-000Z');
        const markerPayload = {
            started_at: '2026-05-26T10:00:00.000Z',
            pid: 99999,
            phase: 'writing',
            wave_number_from: 7,
            wave_number_to: 8,
            waves_bak_path: snap.wavesBakPath,
            waves_bak_sha: snap.wavesBakSha,
            waves_existed: snap.wavesExisted,
            partial_bak_path: snap.partialBakPath,
            partial_bak_sha: snap.partialBakSha,
            partial_existed: snap.partialExisted,
        };
        waves._internal.writeMarkerFsync(waves._paths().PROMOTE_MARKER_FILE, markerPayload);

        // 3) Simular crash: aplicamos un cambio "a medias" (waves.json movió a ola 8
        //    pero .partial-pause.json sigue con la allowlist vieja).
        const broken = { ...initialWaves, active_wave: { number: 8, name: 'Ola N+8', issues: [{ number: 3520 }] }, planned_waves: [] };
        fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(broken, null, 2));

        // 4) Esperar TTL.
        const ttl = Number(process.env.WAVE_PROMOTE_RECOVERY_TTL_MS);
        const wait = ttl + 30;
        const start = Date.now();
        while (Date.now() - start < wait) { /* busy wait corto */ }

        // 5) Boot hook.
        const recovery = waves.recoverIncompletePromote();

        assert.equal(recovery.action, 'recovered', `esperaba 'recovered', vino '${recovery.action}' (${recovery.reason || ''})`);
        assert.equal(recovery.wavesRestored, true);
        assert.equal(recovery.partialRestored, true);

        // 6) Verificar que ambos archivos volvieron al estado pre-promote.
        const restoredWaves = readWaves(dir);
        assert.equal(restoredWaves.active_wave.number, 7);
        assert.equal(restoredWaves.planned_waves.length, 1);
        assert.equal(restoredWaves.planned_waves[0].number, 8);

        const restoredPartial = readPartial(dir);
        assert.deepEqual(restoredPartial.allowed_issues, [3451]);

        // 7) Marker debe estar borrado, .bak renombrado a .recovered.
        assert.equal(fs.existsSync(waves._paths().PROMOTE_MARKER_FILE), false);
        const archivedFiles = fs.readdirSync(path.join(dir, 'archived'));
        const recoveredFiles = archivedFiles.filter((f) => f.includes('.recovered.'));
        assert.ok(recoveredFiles.length >= 2, `esperaba 2 .recovered files, vi: ${archivedFiles.join(', ')}`);
    } finally {
        teardownTmp(dir);
    }
});

// ─── CA-F3 — Marker fresco (< TTL) → no actúa ───────────────────────────────

test('CA-F3 — recoverIncompletePromote con marker fresco no actúa', () => {
    const { dir, waves } = setupTmp();
    try {
        seedWaves(dir, sampleWaves());
        seedPartial(dir, [3451]);
        const snap = waves._internal.snapshotForTransaction('2026-05-26T10-00-00-001Z');
        waves._internal.writeMarkerFsync(waves._paths().PROMOTE_MARKER_FILE, {
            started_at: new Date().toISOString(),
            pid: process.pid,
            phase: 'writing',
            waves_bak_path: snap.wavesBakPath,
            waves_bak_sha: snap.wavesBakSha,
            waves_existed: snap.wavesExisted,
            partial_bak_path: snap.partialBakPath,
            partial_bak_sha: snap.partialBakSha,
            partial_existed: snap.partialExisted,
        });

        // Llamamos recovery INMEDIATAMENTE — marker es fresco.
        const recovery = waves.recoverIncompletePromote();
        assert.equal(recovery.action, 'in_progress');
        assert.ok(/fresco/.test(recovery.reason));

        // Marker debe seguir en su lugar (sin renombrar a recovering).
        assert.equal(fs.existsSync(waves._paths().PROMOTE_MARKER_FILE), true);
    } finally {
        teardownTmp(dir);
    }
});

// ─── CA-F5 — Idempotencia: N llamadas == 1 llamada ──────────────────────────

test('CA-F5 — recoverIncompletePromote es idempotente (N llamadas == 1)', () => {
    const { dir, waves } = setupTmp();
    try {
        seedWaves(dir, sampleWaves());
        seedPartial(dir, [3451]);

        // Sin marker → siempre 'noop'.
        const r1 = waves.recoverIncompletePromote();
        const r2 = waves.recoverIncompletePromote();
        const r3 = waves.recoverIncompletePromote();
        assert.equal(r1.action, 'noop');
        assert.equal(r2.action, 'noop');
        assert.equal(r3.action, 'noop');
        // Estado intacto.
        assert.deepEqual(readWaves(dir).planned_waves.length, 1);
        assert.deepEqual(readPartial(dir).allowed_issues, [3451]);
    } finally {
        teardownTmp(dir);
    }
});

// ─── CA-F6 — SHA mismatch del .bak → fail-closed ────────────────────────────

test('CA-F6 — SHA mismatch del backup escribe wave-promote.failed.<ts>.json', () => {
    const { dir, waves } = setupTmp();
    try {
        seedWaves(dir, sampleWaves());
        seedPartial(dir, [3451]);
        const snap = waves._internal.snapshotForTransaction('2026-05-26T10-00-00-002Z');
        // Marker con SHA INCORRECTO a propósito (simulamos corrupción del .bak post-snapshot).
        waves._internal.writeMarkerFsync(waves._paths().PROMOTE_MARKER_FILE, {
            started_at: '2026-05-26T10:00:00.000Z',
            pid: 99999,
            phase: 'writing',
            waves_bak_path: snap.wavesBakPath,
            waves_bak_sha: 'sha_corrupto_diferente',
            waves_existed: snap.wavesExisted,
            partial_bak_path: snap.partialBakPath,
            partial_bak_sha: snap.partialBakSha,
            partial_existed: snap.partialExisted,
        });

        // Esperar TTL.
        const ttl = Number(process.env.WAVE_PROMOTE_RECOVERY_TTL_MS);
        const start = Date.now();
        while (Date.now() - start < ttl + 30) {}

        const recovery = waves.recoverIncompletePromote();
        assert.equal(recovery.action, 'failed');
        assert.ok(/SHA mismatch/.test(recovery.reason));
        assert.ok(recovery.failedMarkerPath);
        assert.equal(fs.existsSync(recovery.failedMarkerPath), true);

        // Marker recovering DEBE quedar para forensics, .bak intactos.
        assert.equal(fs.existsSync(recovery.markerPath), true);
        assert.equal(fs.existsSync(snap.wavesBakPath), true);
    } finally {
        teardownTmp(dir);
    }
});

// ─── CA-F7 — Gate fail-closed bloquea futuras promociones ───────────────────

test('CA-F7 — isWavePromoteBlocked y promoteWaveAtomic bloquean si hay .failed.*', () => {
    const { dir, waves } = setupTmp();
    try {
        seedWaves(dir, sampleWaves());
        seedPartial(dir, [3451]);

        // Crear un .failed.<ts>.json manualmente.
        const failedPath = path.join(dir, 'wave-promote.failed.2026-05-26T10-00-00-000Z.json');
        fs.writeFileSync(failedPath, JSON.stringify({
            failed_at: '2026-05-26T10:00:00.000Z',
            reason: 'test',
        }, null, 2));

        const blocked = waves.isWavePromoteBlocked();
        assert.equal(blocked.blocked, true);
        assert.equal(blocked.markers.length, 1);

        // promoteWaveAtomic debe lanzar excepción con mensaje accionable.
        assert.throws(
            () => waves.promoteWaveAtomic(8, { updated_by: 'test' }),
            /bloqueado por fail-closed marker/,
        );

        // Tras borrar el .failed, vuelve a permitir.
        fs.unlinkSync(failedPath);
        assert.equal(waves.isWavePromoteBlocked().blocked, false);
    } finally {
        teardownTmp(dir);
    }
});

// ─── CA-F2 — Crash post-snapshot pre-apply: estado sin cambios + cleanup ────

test('CA-F2 — crash post-snapshot pre-apply: recovery restaura (no-op estado) y limpia marker', () => {
    const { dir, waves } = setupTmp();
    try {
        seedWaves(dir, sampleWaves());
        seedPartial(dir, [3451]);
        // Snapshot creado, marker escrito, pero NUNCA aplicamos nada.
        const snap = waves._internal.snapshotForTransaction('2026-05-26T10-00-00-003Z');
        waves._internal.writeMarkerFsync(waves._paths().PROMOTE_MARKER_FILE, {
            started_at: '2026-05-26T10:00:00.000Z',
            pid: 99999,
            phase: 'snapshot',
            wave_number_from: 7,
            wave_number_to: 8,
            waves_bak_path: snap.wavesBakPath,
            waves_bak_sha: snap.wavesBakSha,
            waves_existed: snap.wavesExisted,
            partial_bak_path: snap.partialBakPath,
            partial_bak_sha: snap.partialBakSha,
            partial_existed: snap.partialExisted,
        });

        const ttl = Number(process.env.WAVE_PROMOTE_RECOVERY_TTL_MS);
        const start = Date.now();
        while (Date.now() - start < ttl + 30) {}

        const recovery = waves.recoverIncompletePromote();
        assert.equal(recovery.action, 'recovered');
        // Estado original intacto (la "restauración" reescribe los mismos bytes).
        assert.deepEqual(readWaves(dir).active_wave.number, 7);
        assert.deepEqual(readPartial(dir).allowed_issues, [3451]);
        // Marker borrado.
        assert.equal(fs.existsSync(waves._paths().PROMOTE_MARKER_FILE), false);
    } finally {
        teardownTmp(dir);
    }
});

// ─── promoteWaveAtomic happy path ──────────────────────────────────────────

test('promoteWaveAtomic happy path: ambos archivos actualizados + sin marker residual', () => {
    const { dir, waves } = setupTmp();
    try {
        seedWaves(dir, sampleWaves());
        seedPartial(dir, [3451]);

        const result = waves.promoteWaveAtomic(8, {
            updated_by: 'test',
            source: 'test-suite',
        });

        assert.equal(result.oldWaveNumber, 7);
        assert.equal(result.newWaveNumber, 8);
        assert.equal(result.newWaveName, 'Ola N+8');
        assert.deepEqual(result.newAllowlist.sort(), [3520, 3521]);
        assert.deepEqual(result.removed.sort(), [3451]);
        assert.deepEqual(result.added.sort(), [3520, 3521]);

        const updatedWaves = readWaves(dir);
        assert.equal(updatedWaves.active_wave.number, 8);
        assert.equal(updatedWaves.planned_waves.length, 0);
        const updatedPartial = readPartial(dir);
        assert.deepEqual(updatedPartial.allowed_issues.sort(), [3520, 3521]);

        // No debe quedar marker.
        assert.equal(fs.existsSync(waves._paths().PROMOTE_MARKER_FILE), false);
        // No debe quedar wave-promote.failed.*.
        const failedMarkers = waves._internal.listPromoteFailedMarkers();
        assert.deepEqual(failedMarkers, []);
    } finally {
        teardownTmp(dir);
    }
});

test('promoteWaveAtomic falla si ya existe marker in-progress', () => {
    const { dir, waves } = setupTmp();
    try {
        seedWaves(dir, sampleWaves());
        seedPartial(dir, [3451]);
        // Crear marker manual.
        fs.writeFileSync(waves._paths().PROMOTE_MARKER_FILE, '{}');

        assert.throws(
            () => waves.promoteWaveAtomic(8, { updated_by: 'test' }),
            /transacción en curso/,
        );
    } finally {
        teardownTmp(dir);
    }
});

// ─── CA-F1 — kill -9 inyectado via child_process.fork ──────────────────────

test('CA-F1 — child fork con SIGKILL mid-transaction → boot recovery restaura', async () => {
    const { dir } = setupTmp();
    // OJO: en este test usamos await + estructura async, así garantizamos que
    // PIPELINE_DIR_OVERRIDE sigue seteado hasta que el child y el boot recovery
    // hayan terminado (el `finally` se ejecuta DESPUÉS del await).
    try {
        seedWaves(dir, sampleWaves());
        seedPartial(dir, [3451]);

        // El child:
        //   1. Carga waves con el override hardcoded en su env.
        //   2. Ejecuta snapshot + marker (TTL chiquito).
        //   3. Modifica waves.json al estado "post-promote-parcial".
        //   4. Avisa al padre 'ready_to_die' → padre mata con SIGKILL.
        const childScript = `
            'use strict';
            const fs = require('fs');
            const path = require('path');
            const dir = process.env.PIPELINE_DIR_OVERRIDE;
            const waves = require(${JSON.stringify(path.resolve(__dirname, '..', 'waves.js'))});

            const snap = waves._internal.snapshotForTransaction('2026-05-26T10-00-00-004Z');
            waves._internal.writeMarkerFsync(waves._paths().PROMOTE_MARKER_FILE, {
                started_at: '2026-05-26T10:00:00.000Z',
                pid: process.pid,
                phase: 'writing',
                wave_number_from: 7,
                wave_number_to: 8,
                waves_bak_path: snap.wavesBakPath,
                waves_bak_sha: snap.wavesBakSha,
                waves_existed: snap.wavesExisted,
                partial_bak_path: snap.partialBakPath,
                partial_bak_sha: snap.partialBakSha,
                partial_existed: snap.partialExisted,
            });

            // Simular el primer write: waves.json a "post-promote".
            const broken = {
                version: '1.0',
                meta: { updated_at: new Date().toISOString() },
                active_wave: { number: 8, name: 'Ola N+8', issues: [{ number: 3520 }, { number: 3521 }] },
                planned_waves: [],
                archived_waves: [{ number: 7, closed_at: new Date().toISOString() }],
                dependencies: [],
            };
            fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(broken, null, 2));

            // Avisar al padre que estamos listos para morir.
            process.send && process.send({ status: 'ready_to_die' });

            // Loop infinito hasta SIGKILL.
            setInterval(() => {}, 1000);
        `;
        const childFile = path.join(dir, '_child.js');
        fs.writeFileSync(childFile, childScript);

        const child = fork(childFile, [], {
            env: { ...process.env, PIPELINE_DIR_OVERRIDE: dir, WAVE_PROMOTE_RECOVERY_TTL_MS: '50' },
            silent: true,
        });

        // Esperar a que el child esté listo + matarlo + esperar exit.
        await new Promise((resolve, reject) => {
            child.on('message', (msg) => {
                if (msg && msg.status === 'ready_to_die') {
                    child.kill('SIGKILL');
                }
            });
            child.on('exit', resolve);
            child.on('error', reject);
        });

        // Verificación de pre-condición: el marker quedó escrito + waves.json roto.
        const markerFile = path.join(dir, 'wave-promote.in-progress.json');
        assert.equal(fs.existsSync(markerFile), true, 'pre-cond: marker debe existir tras kill');
        const broken = readWaves(dir);
        assert.equal(broken.active_wave.number, 8, 'pre-cond: waves.json post-promote-parcial');

        // Esperar > TTL para que el marker sea stale.
        await new Promise((r) => setTimeout(r, 100));

        // Boot hook en el padre — aquí PIPELINE_DIR_OVERRIDE sigue seteado.
        delete require.cache[require.resolve('../waves')];
        const w2 = require('../waves');
        const recovery = w2.recoverIncompletePromote();

        assert.equal(recovery.action, 'recovered', `acción: ${recovery.action} (${recovery.reason || ''})`);

        // Post-condición: ambos archivos vuelven a estado pre-promote.
        const restored = readWaves(dir);
        assert.equal(restored.active_wave.number, 7);
        assert.equal(restored.planned_waves.length, 1);
        assert.equal(restored.planned_waves[0].number, 8);

        const restoredPP = readPartial(dir);
        assert.deepEqual(restoredPP.allowed_issues, [3451]);
    } finally {
        teardownTmp(dir);
    }
});

// ─── Bonus: rollback inline si setPartialPauseAtomic falla mid-write ────────

test('promoteWaveAtomic rollback inline cuando segundo write tira excepción', () => {
    const { dir, waves } = setupTmp();
    try {
        seedWaves(dir, sampleWaves());
        seedPartial(dir, [3451]);

        // Monkey-patch para forzar fallo del segundo write.
        const partialPause = require('../partial-pause');
        const origSetAtomic = partialPause.setPartialPauseAtomic;
        partialPause.setPartialPauseAtomic = () => {
            throw new Error('simulado: disco lleno mid-write');
        };

        try {
            assert.throws(
                () => waves.promoteWaveAtomic(8, { updated_by: 'test' }),
                /simulado/,
            );

            // Estado debe estar restaurado.
            const restored = readWaves(dir);
            assert.equal(restored.active_wave.number, 7, 'waves.json restaurado');
            assert.equal(restored.planned_waves[0].number, 8, 'planificada vuelve a estar');

            // Marker borrado.
            assert.equal(fs.existsSync(waves._paths().PROMOTE_MARKER_FILE), false);
        } finally {
            partialPause.setPartialPauseAtomic = origSetAtomic;
        }
    } finally {
        teardownTmp(dir);
    }
});
