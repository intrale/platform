// =============================================================================
// fallback-episode-concurrency.test.js — #6179 CA-14 / SEC-6
//
// Concurrencia REAL, no secuencial: 4 procesos forkeados (3 agentes + el
// Commander, que es la topología del pipeline) invocan `recordDispatch` sobre el
// MISMO archivo de episodio, a la vez.
//
// Por qué tiene que ser con procesos de verdad
// --------------------------------------------
// `atomic-json` da atomicidad de ESCRITURA, no de read-modify-write: dos
// procesos pueden leer el mismo estado viejo, ambos concluir `changed: true` y
// ambos avisar — que es exactamente el ruido que la historia viene a sacar. Y
// `telegram-alert-dedup.createAlertDedup`, citado como precedente, es in-memory
// de un solo proceso: no cubre nada de esto. Un test secuencial pasaría con las
// dos implementaciones y no distinguiría la correcta de la rota.
//
// AISLAMIENTO: tmpdir único por test, borrado en el `finally`. Los workers no
// escriben fuera de él.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

const episodeState = require('../fallback-episode-state');

const WORKER_PATH = path.resolve(__dirname, '_fallback-episode-concurrent-worker.js');
const T0 = 1_700_000_000_000;

/** Exit code del worker cuando decidió notificar. */
const EXIT_NOTIFICO = 3;

function mkStateDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-episode-concurrent-'));
    // Snapshot de salud con causa DERIVABLE (`cuota`). Sin él la causa sería
    // `null` ("no se pudo determinar") y CA-12 obliga a notificar en cada
    // despacho — el fail-closed, que se testea aparte. Acá se mide la exclusión
    // mutua, así que la causa tiene que ser conocida y estable.
    fs.writeFileSync(path.join(dir, 'multi-provider-health.json'), JSON.stringify({
        ts: new Date(T0).toISOString(),
        providers: [
            {
                provider: 'anthropic', label: 'Anthropic', state: 'red',
                reason_code: 'quota_exhausted_real', quota: { pct: 100 },
            },
            {
                provider: 'openai', label: 'OpenAI / Codex', state: 'green',
                reason_code: 'cli_oauth_ok', quota: { pct: 5 },
            },
        ],
    }));
    return dir;
}

function rm(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ya no está */ }
}

function spawnWorker(stateDir, provider, now) {
    return new Promise((resolve, reject) => {
        const child = fork(WORKER_PATH, [stateDir, provider, String(now)], {
            env: { ...process.env },
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        let stderr = '';
        if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('exit', (code) => resolve({ code, stderr }));
        child.on('error', reject);
    });
}

test('CA-14 — 4 procesos concurrentes (3 agentes + Commander) producen UN solo aviso', async () => {
    const dir = mkStateDir();
    try {
        const resultados = await Promise.all([
            spawnWorker(dir, 'openai-codex', T0),
            spawnWorker(dir, 'openai-codex', T0 + 1),
            spawnWorker(dir, 'openai-codex', T0 + 2),
            spawnWorker(dir, 'openai-codex', T0 + 3),
        ]);

        for (const r of resultados) {
            assert.ok(
                r.code === 0 || r.code === EXIT_NOTIFICO,
                `worker terminó con code inesperado ${r.code}: ${r.stderr}`,
            );
        }

        const notificaron = resultados.filter((r) => r.code === EXIT_NOTIFICO).length;
        assert.equal(notificaron, 1,
            `exactamente un proceso debe avisar (avisaron ${notificaron})`);

        // Y el archivo quedó íntegro y con shape válido: nadie escribió encima
        // de otro a medias.
        const leido = episodeState.readEpisode({ stateDir: dir });
        assert.equal(leido.reason, null, 'el estado final es válido, no corrupto');
        assert.equal(leido.episode.mode, 'respaldo');
        assert.equal(leido.episode.tier, 'respaldo_pago');
        assert.equal(leido.episode.cause, 'cuota');
    } finally {
        rm(dir);
    }
});

test('CA-14 — 8 procesos concurrentes tampoco duplican el aviso', async () => {
    const dir = mkStateDir();
    try {
        const resultados = await Promise.all(
            Array.from({ length: 8 }, (_, i) => spawnWorker(dir, 'openai-codex', T0 + i)),
        );
        const notificaron = resultados.filter((r) => r.code === EXIT_NOTIFICO).length;
        assert.equal(notificaron, 1, `avisaron ${notificaron} de 8`);

        const leido = episodeState.readEpisode({ stateDir: dir });
        assert.equal(leido.reason, null);
    } finally {
        rm(dir);
    }
});

test('CA-14 — el lock no deja residuo: un despacho posterior sigue funcionando', async () => {
    const dir = mkStateDir();
    try {
        await Promise.all(
            Array.from({ length: 4 }, (_, i) => spawnWorker(dir, 'openai-codex', T0 + i)),
        );
        // Si algún worker se hubiera ido dejando el lock tomado, este despacho
        // colgaría hasta el timeout y volvería `lock_no_adquirido`.
        const r = episodeState.recordDispatch({
            stateDir: dir,
            provider: 'openai-codex',
            crossProvider: true,
            chain: ['anthropic', 'openai-codex'],
            models: { providers: { 'openai-codex': { billing: 'paid', supports_tool_use: true } } },
            now: T0 + 1000,
        });
        assert.equal(r.notify, false, 'el episodio sigue abierto y silencioso');
        assert.equal(r.reason, 'sin_cambio');
    } finally {
        rm(dir);
    }
});

test('CA-14 — el worker es fail-closed ante un provider fuera de la allowlist', async () => {
    const dir = mkStateDir();
    try {
        const r = await spawnWorker(dir, 'proveedor-inventado', T0);
        assert.equal(r.code, 5, 'argv sintético validado antes de tocar el módulo');
    } finally {
        rm(dir);
    }
});
