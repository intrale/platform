// =============================================================================
// wave-promote-rollback-5113.test.js — Regresión del camino de rollback
// transaccional de `/wave promote` (#5113 rev-7).
//
// Los dos defectos que cubren estos tests son los que confirmó el PO sobre
// `f4e347016`, ambos introducidos al mover el snapshot desde `existsSync +
// copyFileSync` (bytes crudos, en `origin/main`) a la capa de storage:
//
//  R1  Un `waves.json` ILEGIBLE se sellaba como "no existía" (`readKey()`
//      colapsa ausente / ilegible / degradado en `null`) y el rollback lo
//      BORRABA reportando `ok:true`. Regresión con el flag de cutover APAGADO.
//  R2  `promoteWaveAtomic` invocaba `setPartialPauseAtomic` y DESCARTABA su
//      retorno. Como esa función ya no lanza sino que devuelve `{ok:false}`,
//      la promoción sellaba `phase=done` con `waves.json` en la ola nueva y la
//      allowlist todavía en la vieja: dos fuentes de verdad desincronizadas.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/wave-promote-rollback-5113.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withEnv } = require('../test-helpers/with-env');

/**
 * Corre `fn({dir, waves, pp})` con un tmpdir propio y el entorno AISLADO por
 * `withEnv` (#6258): las variables se restauran pase lo que pase, así que el
 * resultado no depende del orden en que corrió el test ni del entorno del
 * proceso que lo lanza. El TTL del recovery baja a 1 ms para que un marker
 * envejecido a mano cuente como stale sin dormir.
 */
function enTmp(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-rollback-5113-'));
    try {
        return withEnv({
            PIPELINE_DIR_OVERRIDE: dir,
            WAVE_PROMOTE_RECOVERY_TTL_MS: '1',
        }, () => {
            delete require.cache[require.resolve('../waves')];
            delete require.cache[require.resolve('../partial-pause')];
            delete require.cache[require.resolve('../operational-state-backend')];
            const waves = require('../waves');
            const pp = require('../partial-pause');
            waves.invalidateCache();
            return fn({ dir, waves, pp });
        });
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

const wavesFile = (dir) => path.join(dir, 'waves.json');
const partialFile = (dir) => path.join(dir, '.partial-pause.json');
const markerFile = (dir) => path.join(dir, 'wave-promote.in-progress.json');

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
            { number: 8, name: 'Ola N+8', issues: [{ number: 5113 }, { number: 5114 }] },
        ],
        archived_waves: [],
        dependencies: [],
    };
}

// Marker de una transacción interrumpida que selló "waves.json no existía".
function seedStaleMarker(dir, overrides = {}) {
    const payload = {
        started_at: '2026-04-20T10:00:00.000Z',
        pid: process.pid,
        phase: 'writing',
        wave_number_from: 7,
        wave_number_to: 8,
        waves_bak_path: null,
        waves_bak_sha: null,
        waves_existed: false,
        partial_bak_path: null,
        partial_bak_sha: null,
        partial_existed: null,   // sin evidencia → restoreFromSnapshots no toca la allowlist
        ...overrides,
    };
    fs.writeFileSync(markerFile(dir), JSON.stringify(payload, null, 2));
    // Envejecer el marker para que el recovery lo tome como stale.
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(markerFile(dir), old, old);
    return payload;
}

// ─── R1 — el rollback NUNCA borra lo que no pudo leer ───────────────────────

test('R1 — el rollback no borra un waves.json ilegible sellado como inexistente', () => {
    enTmp(({ dir, waves }) => {
        // `waves.json` presente pero ILEGIBLE (JSON corrupto). En el sustrato es
        // indistinguible de "ausente" para `readKey()`: ambos dan `null`.
        const corrupto = '{ "active_wave": { esto no parsea';
        fs.writeFileSync(wavesFile(dir), corrupto);
        seedStaleMarker(dir);

        const res = waves.recoverIncompletePromote();

        // Lo que importa: el archivo SIGUE AHÍ, byte a byte.
        assert.equal(
            fs.existsSync(wavesFile(dir)), true,
            'REGRESIÓN #5113: el rollback borró un waves.json que sólo estaba ilegible',
        );
        assert.equal(fs.readFileSync(wavesFile(dir), 'utf8'), corrupto);
        // Y el recovery lo reporta como fallado (fail-closed), no como éxito.
        assert.equal(res.action, 'failed');
        assert.match(String(res.reason), /no se borra nada|fail-closed/i);
    });
});

test('R1 — el rollback sí borra waves.json cuando la ausencia previa está confirmada', () => {
    enTmp(({ dir, waves }) => {
        // Control positivo: el estado actual es LEGIBLE, así que el `false` del
        // marker es confiable y el rollback a pre-existencia debe eliminarlo.
        fs.writeFileSync(wavesFile(dir), JSON.stringify(sampleWaves(), null, 2));
        seedStaleMarker(dir);

        const res = waves.recoverIncompletePromote();

        assert.equal(res.action, 'recovered');
        assert.equal(
            fs.existsSync(wavesFile(dir)), false,
            'el rollback a pre-existencia dejó de borrar cuando sí correspondía',
        );
    });
});

test('R1 — la promoción no arranca si el snapshot no puede leer la allowlist', () => {
    enTmp(({ dir, waves }) => {
        // `waves.json` sano (la ola 8 existe y es promovible) pero la allowlist
        // ilegible: el snapshot no puede distinguir "no había allowlist" de "no
        // la pude leer", así que la transacción no debe arrancar.
        const antes = JSON.stringify(sampleWaves(), null, 2);
        fs.writeFileSync(wavesFile(dir), antes);
        const allowlistCorrupta = '{ allowed_issues: [999';
        fs.writeFileSync(partialFile(dir), allowlistCorrupta);

        assert.throws(
            () => waves.promoteWaveAtomic(8, { updated_by: 'test' }),
            (err) => err && err.code === 'STATE_UNREADABLE',
            'la promoción avanzó con un snapshot que no pudo leer la allowlist',
        );

        // Nada tocado: ni producción ni marker.
        assert.equal(fs.readFileSync(partialFile(dir), 'utf8'), allowlistCorrupta);
        assert.equal(fs.readFileSync(wavesFile(dir), 'utf8'), antes);
        assert.equal(fs.existsSync(markerFile(dir)), false, 'quedó un marker in-progress huérfano');
    });
});

// ─── R2 — el fallo de la allowlist dispara el rollback ──────────────────────

test('R2 — promoteWaveAtomic revierte si setPartialPauseAtomic devuelve ok:false', () => {
    enTmp(({ dir, waves, pp }) => {
        const original = pp.setPartialPauseAtomic;
        try {
            fs.writeFileSync(wavesFile(dir), JSON.stringify(sampleWaves(), null, 2));
            fs.writeFileSync(partialFile(dir), JSON.stringify({
                allowed_issues: [3451],
                created_at: '2026-04-20T10:00:00.000Z',
                source: 'test-seed',
            }, null, 2));
            const allowlistAntes = fs.readFileSync(partialFile(dir), 'utf8');

            // El gate de autoría rechaza (o el CAS pierde): NO lanza, devuelve ok:false.
            pp.setPartialPauseAtomic = () => ({
                ok: false,
                rejected: true,
                allowedIssues: [3451],
                msg: 'Mutación rechazada por gate: removals sin authorizedBy válido',
                prevBuffer: null,
                prevSha: null,
                existedBefore: true,
            });

            let capturado = null;
            assert.throws(
                () => waves.promoteWaveAtomic(8, { updated_by: 'test' }),
                (err) => { capturado = err; return true; },
                'la promoción reportó éxito con la allowlist sin aplicar',
            );
            // Shape homogéneo con los callers que miran `rejected` sobre partial-pause.
            assert.equal(capturado.code, 'PARTIAL_PAUSE_WRITE_REJECTED');
            assert.equal(capturado.rejected, true);

            // Rollback efectivo: waves.json volvió a la ola 7 activa y la 8 planificada.
            waves.invalidateCache();
            const after = JSON.parse(fs.readFileSync(wavesFile(dir), 'utf8'));
            assert.equal(after.active_wave.number, 7, 'waves.json quedó en la ola nueva sin allowlist aplicada');
            assert.deepEqual(after.planned_waves.map((w) => w.number), [8]);
            // La allowlist quedó exactamente como estaba.
            assert.equal(fs.readFileSync(partialFile(dir), 'utf8'), allowlistAntes);
            // Sin marker in-progress colgado (el rollback limpió).
            assert.equal(fs.existsSync(markerFile(dir)), false);
        } finally {
            pp.setPartialPauseAtomic = original;
        }
    });
});

test('R2 — promoteWaveAtomic promueve normalmente cuando la allowlist se aplica', () => {
    enTmp(({ dir, waves }) => {
        fs.writeFileSync(wavesFile(dir), JSON.stringify(sampleWaves(), null, 2));

        const res = waves.promoteWaveAtomic(8, { updated_by: 'test' });

        assert.equal(res.newWaveNumber, 8);
        waves.invalidateCache();
        const after = JSON.parse(fs.readFileSync(wavesFile(dir), 'utf8'));
        assert.equal(after.active_wave.number, 8);
        const allowlist = JSON.parse(fs.readFileSync(partialFile(dir), 'utf8'));
        assert.deepEqual(allowlist.allowed_issues, [5113, 5114]);
        assert.equal(fs.existsSync(markerFile(dir)), false);
    });
});

// ─── R3 (rev-8) — el rollback con el STORE degradado, no con un JSON corrupto ─
//
// Los tests R1 de arriba alcanzan la rama fail-closed de `restoreKey` por un
// único camino: `waves.json` ilegible en modo FILESYSTEM. Pero el comentario que
// justifica esa rama cita el escenario REMOTO ("el sustrato responde"), y ese
// camino no estaba ejercitado por ningún test: la suite entera corría contra
// filesystem. Un cambio en la resolución del driver, en el manejo del timeout o
// en el mapeo de errores del store podía romper el fail-closed del rollback sin
// poner nada en rojo.
//
// Acá la degradación ocurre DONDE de verdad ocurre en producción: el store deja
// de responder a mitad de la transacción, con el marker ya sellado en disco.

const { createFakeSyncDynamoDriver } = require('./fixtures/fake-sync-dynamo-driver');

const PROJECT_ID_REMOTO = 'intrale-platform';

/**
 * Escribe un backup de rollback en `archived/` y devuelve su sha. El marker
 * lleva el sha justamente para que el rollback no restaure un backup alterado:
 * omitirlo hace que el recovery aborte por `SHA mismatch` antes de tocar el
 * store, y el test estaría pasando por el chequeo equivocado.
 */
function escribirBackup(dir, estado) {
    const file = path.join(dir, 'archived', 'waves-rollback.test.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const contenido = JSON.stringify(estado, null, 2);
    fs.writeFileSync(file, contenido);
    const sha = require('node:crypto').createHash('sha256').update(contenido).digest('hex');
    return { path: file, sha };
}

/**
 * Igual que `enTmp` pero con el backend en modo REMOTO contra un driver fake.
 * `caerDespuesDe` deja pasar N operaciones sanas y a partir de ahí el store
 * falla: es como se simula "se cayó a mitad de la transacción" sin red.
 */
function enTmpRemoto(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-rollback-remoto-5113-'));
    try {
        return withEnv({
            PIPELINE_DIR_OVERRIDE: dir,
            WAVE_PROMOTE_RECOVERY_TTL_MS: '1',
            PIPELINE_OPSTATE_DURABLE: '1',
        }, () => {
            delete require.cache[require.resolve('../waves')];
            delete require.cache[require.resolve('../partial-pause')];
            delete require.cache[require.resolve('../operational-state-backend')];
            const backend = require('../operational-state-backend');
            const waves = require('../waves');
            const pp = require('../partial-pause');
            const driver = createFakeSyncDynamoDriver();
            backend.setDegradationSink({ onDegraded: () => {} });
            backend._setDriverForTests({
                driver,
                spec: { type: 'dynamodb_table', tableName: 'tabla-fake', keys: [] },
                projectId: PROJECT_ID_REMOTO,
                instanceId: PROJECT_ID_REMOTO,
                atomicUpdate: true,
            });
            // El store se cae para TODAS las operaciones a partir del llamado.
            //
            // Se invalida además la memoización de lectura (2 s, rev-6): el
            // setup del test acaba de leer el estado sano y ese hit vivo haría
            // que la sonda del rollback resolviera contra el caché en vez de
            // contra el store caído. En producción la caída dura bastante más
            // que el TTL; acá hay que forzarlo para no probar el caché.
            const tumbarStore = () => {
                const caida = () => {
                    throw new Error('ETIMEDOUT: la tabla de coordinación dejó de responder');
                };
                driver.getItem = caida;
                driver.putItem = caida;
                driver.deleteItem = caida;
                backend.invalidateReadCache();
            };
            waves.invalidateCache();
            return fn({ dir, waves, pp, backend, driver, tumbarStore });
        });
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

test('R3 — con el STORE caído el rollback a pre-existencia NO borra (fail-closed remoto)', () => {
    enTmpRemoto(({ dir, waves, backend, tumbarStore }) => {
        // Estado remoto real: la clave EXISTE en el store.
        backend.writeKey(backend.KEYS.WAVES, sampleWaves(), 0);
        assert.ok(backend.readKey(backend.KEYS.WAVES), 'premisa: el estado está en el store');

        // Marker de una transacción interrumpida que selló "no existía". El
        // rollback tendría que borrar la clave... salvo que no pueda confirmar
        // nada porque el store dejó de responder.
        seedStaleMarker(dir);
        tumbarStore();

        const res = waves.recoverIncompletePromote();

        assert.equal(res.action, 'failed', 'el rollback siguió adelante sin poder consultar el store');
        assert.match(String(res.reason), /no se borra nada|fail-closed|no pude confirmar/i);
    });
});

test('R3 — con el STORE caído la restauración desde backup falla explícitamente', () => {
    enTmpRemoto(({ dir, waves, backend, tumbarStore }) => {
        backend.writeKey(backend.KEYS.WAVES, sampleWaves(), 0);

        // Marker que SÍ tiene backup: el rollback debe reescribir la clave. Con
        // el store caído el `writeKey` no puede aplicarse, y eso tiene que
        // reportarse como fallo — no como "revertido".
        const bak = escribirBackup(dir, sampleWaves());
        seedStaleMarker(dir, {
            waves_bak_path: bak.path, waves_bak_sha: bak.sha, waves_existed: true,
        });

        tumbarStore();
        const res = waves.recoverIncompletePromote();

        assert.equal(res.action, 'failed',
            'el rollback reportó éxito sin haber podido escribir el estado restaurado');
        assert.match(String(res.reason), /restaurando|write|rechazado|ETIMEDOUT/i);
    });
});

test('R3 — control positivo: con el store SANO el mismo rollback sí revierte', () => {
    enTmpRemoto(({ dir, waves, backend }) => {
        // Sin `tumbarStore()`: demuestra que los dos tests de arriba fallan por
        // la degradación y no porque el camino remoto esté roto de entrada.
        const estado = sampleWaves();
        estado.active_wave.number = 8;   // el estado "a medio promover"
        backend.writeKey(backend.KEYS.WAVES, estado, 0);

        const bak = escribirBackup(dir, sampleWaves());   // ola 7
        seedStaleMarker(dir, {
            waves_bak_path: bak.path, waves_bak_sha: bak.sha, waves_existed: true,
        });

        const res = waves.recoverIncompletePromote();

        assert.equal(res.action, 'recovered');
        assert.equal(backend.readKey(backend.KEYS.WAVES).active_wave.number, 7,
            'el estado remoto no volvió a la ola previa');
    });
});
