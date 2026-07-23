// =============================================================================
// waves-concurrency.test.js — Tests de concurrencia con N workers paralelos.
// Issue #3518 CA-8.
//
// Estrategia
// ----------
// Forkear N=10 procesos hijos (child_process.fork) que cada uno hace un
// `addIssueToWave` distinto sobre el MISMO waves.json. Después esperar
// `Promise.all` de los `exit` events y validar:
//   (a) JSON sintácticamente válido (JSON.parse no tira).
//   (b) Schema válido (validateStateStrict no devuelve errores).
//   (c) Audit log: cada exitoso dejó su entrada (meta.updated_by != 'System').
//   (d) Idempotencia: los issues aparecen una sola vez (no duplicados).
//   (e) Sin tmp files residuales (.tmp y .lock liberados).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

const WORKER_SCRIPT = path.join(__dirname, 'fixtures', 'waves-concurrency-worker.js');

function setupTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-conc-test-'));
    return dir;
}

function rmrf(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function writeBaseState(dir) {
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify({
        version: '1.0',
        meta: {
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            updated_by: 'test',
            source: 'fixture',
        },
        active_wave: {
            number: 1,
            name: 'concurrent',
            started_at: new Date().toISOString(),
            issues: [],
        },
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
    }, null, 2));
}

function forkWorker(dir, issue, wave = 1) {
    return new Promise((resolve) => {
        const env = {
            ...process.env,
            PIPELINE_DIR_OVERRIDE: dir,
            WORKER_ISSUE: String(issue),
            WORKER_WAVE: String(wave),
        };
        const child = fork(WORKER_SCRIPT, [], {
            env,
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        let stderr = '';
        child.stderr.on('data', (c) => { stderr += c.toString(); });
        child.on('exit', (code) => resolve({ code, stderr }));
    });
}

test('CA-8: N=10 workers concurrentes — JSON válido + schema válido + N entries + idempotencia', async () => {
    const dir = setupTmp();
    try {
        writeBaseState(dir);

        // 10 issues distintos, forkeados en paralelo.
        const issues = Array.from({ length: 10 }, (_, i) => 9000 + i);
        const results = await Promise.all(issues.map((i) => forkWorker(dir, i)));

        // (a) JSON sintácticamente válido.
        const raw = fs.readFileSync(path.join(dir, 'waves.json'), 'utf8');
        let parsed;
        assert.doesNotThrow(() => { parsed = JSON.parse(raw); }, 'JSON debe ser parseable');

        // (b) Schema válido (re-require para tomar override).
        delete require.cache[require.resolve('../waves')];
        process.env.PIPELINE_DIR_OVERRIDE = dir;
        const waves = require('../waves');
        const errors = waves.validateStateStrict(parsed);
        assert.equal(errors.length, 0, `schema errors: ${errors.join('; ')}`);
        delete process.env.PIPELINE_DIR_OVERRIDE;

        // (c) Audit log: el último write quedó registrado. (No podemos verificar
        //     entrada por entrada porque waves.json mantiene solo el último
        //     meta — el audit detallado por write es follow-up del security).
        assert.ok(parsed.meta.updated_by.startsWith('worker-'), 'último writer es un worker');

        // (d) Idempotencia + completitud: todos los issues que reportaron
        //     éxito están en el wave activo, una sola vez cada uno.
        const successful = results.filter((r) => r.code === 0).length;
        const wave = parsed.active_wave;
        assert.ok(Array.isArray(wave.issues), 'active_wave.issues debe ser array');
        const seen = new Set();
        for (const it of wave.issues) {
            assert.ok(!seen.has(it.number), `issue duplicado: ${it.number}`);
            seen.add(it.number);
        }
        // Todos los workers exitosos dejaron su issue.
        assert.equal(wave.issues.length, successful, `issues=${wave.issues.length}, exitosos=${successful}`);

        // (e) Sin residuos.
        assert.equal(fs.existsSync(path.join(dir, 'waves.json.tmp')), false, 'tmp file residual');
        assert.equal(fs.existsSync(path.join(dir, 'waves.json.lock')), false, 'lock residual');

        // Reportar al menos N/2 deben haber tenido éxito (los demás pueden
        // haber timeoutado el lock si el sistema está cargado, lo cual es
        // un escenario válido — pero NO deben haber corrompido el archivo).
        assert.ok(successful >= issues.length / 2,
            `solo ${successful}/${issues.length} workers exitosos — posible problema de lock contention`);
    } finally {
        delete process.env.PIPELINE_DIR_OVERRIDE;
        rmrf(dir);
    }
});

test('CA-8: workers concurrentes con el MISMO issue — solo uno gana, no duplica', async () => {
    const dir = setupTmp();
    try {
        writeBaseState(dir);

        // 5 workers intentan agregar el MISMO issue.
        const sameIssue = 8888;
        const results = await Promise.all(Array.from({ length: 5 }, () => forkWorker(dir, sameIssue)));

        // Al menos uno tuvo éxito.
        const successful = results.filter((r) => r.code === 0).length;
        assert.ok(successful >= 1, 'al menos un worker debe haber agregado el issue');

        // El JSON final tiene el issue una sola vez (idempotencia interna de addIssueToWave).
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
        const count = parsed.active_wave.issues.filter((i) => i.number === sameIssue).length;
        assert.equal(count, 1, `issue ${sameIssue} aparece ${count} veces, debe ser 1`);
    } finally { rmrf(dir); }
});
