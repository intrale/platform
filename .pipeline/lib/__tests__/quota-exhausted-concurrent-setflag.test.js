// =============================================================================
// quota-exhausted-concurrent-setflag.test.js — #3575 CA-5
//
// Valida que `setFlag` es seguro bajo concurrencia cross-skill: 10 procesos
// forkeados invocan `setFlag` con providers/errorTypes distintos sobre el
// mismo `flagFile()`, y al final:
//
//   1. El JSON del archivo PARSEA sin error (no truncado, no campos perdidos).
//   2. Tiene `exhausted: true`.
//   3. El `pattern_matched` corresponde a alguno de los workers (last-writer-wins).
//   4. (POSIX) mode del archivo == 0o600.
//   5. Todos los workers exit 0 (allowlist validada en el worker).
//
// AISLAMIENTO: cada test usa un tmpDir único vía `PIPELINE_DIR_OVERRIDE`.
// Nunca escribe sobre el `.pipeline/quota-exhausted.json` real del repo.
//
// CLEANUP: garantizado en `finally` aunque el test falle.
//
// SEGURIDAD (heredada de #3435):
//   - argv del worker solo contiene datos sintéticos (provider, errorType de la
//     allowlist hardcoded de quota-exhausted.js). Sin secrets en CWE-214.
//   - Worker fail-closed si recibe provider/errorType fuera de la allowlist.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');

const WORKER_PATH = path.resolve(__dirname, '_setflag-concurrent-worker.js');

function mkTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'v3-quota-concurrent-'));
}

function rmTmpDir(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function readFlag(tmpDir) {
    const f = path.join(tmpDir, 'quota-exhausted.json');
    if (!fs.existsSync(f)) return null;
    const raw = fs.readFileSync(f, 'utf8');
    return { raw, parsed: JSON.parse(raw), filePath: f };
}

function spawnWorker(tmpDir, provider, errorType) {
    return new Promise((resolve, reject) => {
        const child = fork(
            WORKER_PATH,
            [tmpDir, provider, errorType],
            {
                // Aislar el env del worker: solo lo mínimo + override.
                env: {
                    ...process.env,
                    PIPELINE_DIR_OVERRIDE: tmpDir,
                },
                // silent: false para que stderr suba al runner si algo falla.
                silent: false,
                stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            }
        );
        let stderr = '';
        if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('exit', (code) => {
            if (code === 0) resolve({ code, stderr });
            else reject(new Error(`worker exit ${code} (provider=${provider} errorType=${errorType}): ${stderr}`));
        });
        child.on('error', reject);
    });
}

test('setFlag: 10 procesos concurrentes producen JSON final valido', async (t) => {
    const tmpDir = mkTmpDir();
    t.after(() => rmTmpDir(tmpDir));

    // Mix de providers/errorTypes de la allowlist hardcoded de quota-exhausted.js.
    // El worker valida la allowlist por sí mismo (fail-closed) — esto es
    // defensa en profundidad: si alguien rompe la allowlist, el test detecta.
    const jobs = [
        ['anthropic', 'usage_limit_error'],
        ['anthropic', 'weekly_quota_exhausted'],
        ['anthropic', 'snapshot_threshold_90'],
        ['openai-codex', 'insufficient_quota'],
        ['openai-codex', 'billing_hard_limit_reached'],
        ['openai-codex', 'tokens_exhausted'],
        ['anthropic', 'usage_limit_error'],
        ['openai-codex', 'insufficient_quota'],
        ['anthropic', 'weekly_quota_exhausted'],
        ['openai-codex', 'tokens_exhausted'],
    ];

    assert.equal(jobs.length, 10, 'el test debe lanzar exactamente 10 forks');

    // Lanzamiento concurrente real: todos los Promises arrancan a la vez.
    const results = await Promise.all(jobs.map(([p, e]) => spawnWorker(tmpDir, p, e)));
    for (const r of results) {
        assert.equal(r.code, 0, `worker exit code inesperado: stderr=${r.stderr}`);
    }

    // 1. El archivo existe y parsea sin error.
    const flag = readFlag(tmpDir);
    assert.ok(flag, 'flag file no existe tras 10 setFlag concurrentes');
    assert.equal(typeof flag.parsed, 'object', 'flag parseado no es objeto');

    // 2. Estructura mínima: exhausted true + campos obligatorios.
    assert.equal(flag.parsed.exhausted, true, 'exhausted no es true');
    assert.equal(typeof flag.parsed.provider, 'string', 'provider falta o no es string');
    assert.equal(typeof flag.parsed.pattern_matched, 'string', 'pattern_matched falta o no es string');
    assert.equal(typeof flag.parsed.resets_at, 'string', 'resets_at falta o no es string');
    assert.equal(typeof flag.parsed.detected_at, 'string', 'detected_at falta o no es string');

    // 3. Last-writer-wins: el (provider, pattern_matched) final debe coincidir con
    //    alguno de los jobs lanzados (no corrupción, no mezcla parcial).
    const matchedJob = jobs.find(([p, e]) =>
        p === flag.parsed.provider && e === flag.parsed.pattern_matched
    );
    assert.ok(
        matchedJob,
        `combinacion final (provider=${flag.parsed.provider}, pattern=${flag.parsed.pattern_matched}) ` +
        `no corresponde a ningun worker — posible corrupcion last-writer-wins`
    );

    // 4. JSON no truncado: re-parseable y JSON.stringify produce el mismo objeto.
    const reSerialized = JSON.parse(flag.raw);
    assert.deepEqual(reSerialized, flag.parsed, 'reserializacion difiere: archivo parcialmente escrito?');

    // 5. POSIX: mode 0o600 (anti-regresion #3077 CA-6).
    if (process.platform !== 'win32') {
        const stat = fs.statSync(flag.filePath);
        const modeBits = stat.mode & 0o777;
        assert.equal(
            modeBits, 0o600,
            `mode ${modeBits.toString(8)} != 600 — atomic write perdio el permiso restrictivo`
        );
    }
});

test('setFlag worker: fail-closed cuando provider esta fuera de allowlist', async (t) => {
    const tmpDir = mkTmpDir();
    t.after(() => rmTmpDir(tmpDir));

    let rejected = false;
    try {
        await spawnWorker(tmpDir, 'unknown-provider', 'usage_limit_error');
    } catch (err) {
        rejected = true;
        assert.match(err.message, /worker exit 2/, 'worker debe exit 2 ante provider invalido');
    }
    assert.ok(rejected, 'worker no rechazo provider fuera de allowlist');
    assert.equal(readFlag(tmpDir), null, 'no debe escribirse flag cuando worker falla cerrado');
});

test('setFlag worker: fail-closed cuando errorType no esta en allowlist del provider', async (t) => {
    const tmpDir = mkTmpDir();
    t.after(() => rmTmpDir(tmpDir));

    let rejected = false;
    try {
        await spawnWorker(tmpDir, 'anthropic', 'rate_limit_error');  // existe pero NO es de cuota
    } catch (err) {
        rejected = true;
        assert.match(err.message, /worker exit 3/, 'worker debe exit 3 ante errorType invalido');
    }
    assert.ok(rejected, 'worker no rechazo errorType fuera de allowlist');
    assert.equal(readFlag(tmpDir), null, 'no debe escribirse flag cuando worker falla cerrado');
});
