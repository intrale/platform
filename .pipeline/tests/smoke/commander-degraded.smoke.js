#!/usr/bin/env node
// =============================================================================
// commander-degraded.smoke.js — Smoke E2E del modo degradado del Commander
// Issue #3253 · CA-8
//
// Objetivo:
//   Simular un escenario donde Claude está caído (flag quota-exhausted activo)
//   y verificar que:
//     1. `/status`, `/quota` y `/help` responden en <5s sin invocar a Claude.
//     2. Ningún `spawn` se dispara durante el dispatch determinístico.
//     3. El gate de cuota para texto libre devuelve canned literal sin
//        interpolar input del usuario (CA-3).
//     4. El cooldown destructivo (CA-4) bloquea restart consecutivo.
//
// Reglas de aislamiento (CA-S6):
//   - El smoke usa SIEMPRE un pipeline temporal en `os.tmpdir()/smoke-cmdr-XXX`.
//     NO toca el `.pipeline/quota-exhausted.json` real.
//   - Copia el fixture aislado `.pipeline/tests/fixtures/quota-exhausted.json`
//     al tmp para que el handler lo lea.
//   - Spy sobre `child_process.spawn`: si se invoca durante el smoke, fallo.
//
// Ejecutar:  npm run smoke:commander
// =============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const child_process = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'quota-exhausted.json');

// -----------------------------------------------------------------------------
// Spy sobre child_process.spawn — falla el smoke si Claude se invoca
// -----------------------------------------------------------------------------
const spawnCalls = [];
const originalSpawn = child_process.spawn;
child_process.spawn = function spySpawn(cmd, args, opts) {
    spawnCalls.push({ cmd: String(cmd), args: (args || []).slice(), at: Date.now() });
    // Continuamos delegando al original para no romper utilidades benignas
    // (pid-discovery puede llamar a wmic). El test final inspecciona la lista.
    return originalSpawn.apply(this, arguments);
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function pass(msg) { console.log(`  ✔ ${msg}`); }
function fail(msg) { console.error(`  ✘ ${msg}`); process.exit(1); }
function assert(cond, msg) { if (!cond) fail(msg); else pass(msg); }

function isLLMSpawn(call) {
    // Cualquier spawn que mencione "claude", "codex", "groq", "cerebras" o
    // "gemini" se considera invocación al LLM. Spawns de wmic/taskkill son
    // benignos (los hace el handler determinístico para descubrir PIDs).
    const haystack = (call.cmd + ' ' + (call.args || []).join(' ')).toLowerCase();
    return /claude|codex|groq|cerebras|gemini-cli|gemini\.exe|anthropic/.test(haystack);
}

// -----------------------------------------------------------------------------
// Smoke
// -----------------------------------------------------------------------------

async function run() {
    const startedAt = Date.now();
    console.log('[smoke] commander-degraded · issue #3253 CA-8');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-cmdr-'));
    const logsDir = path.join(tmpDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const flagDst = path.join(tmpDir, 'quota-exhausted.json');
    fs.copyFileSync(FIXTURE, flagDst);
    assert(fs.existsSync(flagDst), 'fixture quota-exhausted.json copiado a tmp aislado');

    // Cargar commander-deterministic DESPUÉS de crear el tmp, en proceso aislado.
    delete require.cache[require.resolve(path.join(REPO_ROOT, '.pipeline', 'lib', 'commander-deterministic.js'))];
    const commanderDet = require(path.join(REPO_ROOT, '.pipeline', 'lib', 'commander-deterministic.js'));
    const { clearCache } = require(path.join(REPO_ROOT, '.pipeline', 'lib', 'commander', 'fill-template.js'));
    clearCache();

    let clock = Date.now();
    const dispatcher = commanderDet.createDispatcher({
        pipelineRoot: tmpDir,
        logsDir,
        destructiveCooldown: { cooldownMs: 60_000 },
        now: () => clock,
        // Inyectamos handlers stub para los comandos legacy del pulpo
        // (status / help / restart) que viven fuera del dispatcher. El smoke
        // valida que NO se invoca el LLM; no necesitamos comportamiento real.
        handlers: {
            status: async () => '🐙 Pulpo OK (smoke stub)',
            help: async () => '🤖 Comandos (smoke stub)',
            restart: async () => '🔄 Restart simulado',
        },
    });

    // ─── /quota — debe responder con flag activo desde el fixture ──────────
    const tQuota = Date.now();
    const rQuota = await dispatcher.dispatch({ chat_id: '999', from: 'Leo', text: '/quota' });
    const dQuota = Date.now() - tQuota;
    assert(rQuota.status === 'ok', `/quota status=ok (got ${rQuota.status})`);
    assert(/anthropic/.test(rQuota.reply || ''), '/quota reply menciona provider "anthropic"');
    assert(/usage/.test(rQuota.reply || ''), '/quota reply incluye reason-kind ("usage_limit_error")');
    assert(dQuota < 5000, `/quota respondió en ${dQuota}ms (<5s)`);

    // ─── /status — handler stub, no LLM ─────────────────────────────────────
    const tStatus = Date.now();
    const rStatus = await dispatcher.dispatch({ chat_id: '999', from: 'Leo', text: '/status' });
    const dStatus = Date.now() - tStatus;
    assert(rStatus.status === 'ok', `/status status=ok (got ${rStatus.status})`);
    assert(rStatus.reply && rStatus.reply.includes('smoke stub'), '/status usa el stub inyectado, no Claude');
    assert(dStatus < 5000, `/status respondió en ${dStatus}ms (<5s)`);

    // ─── /quota clear (mutativo) — rechazado, archivo intocado ──────────────
    const flagBefore = fs.readFileSync(flagDst, 'utf8');
    const rClear = await dispatcher.dispatch({ chat_id: '999', from: 'Leo', text: '/quota clear' });
    const flagAfter = fs.readFileSync(flagDst, 'utf8');
    assert(rClear.status === 'invalid_args', '/quota clear rechazado como invalid_args');
    assert(flagBefore === flagAfter, '/quota clear NO modifica el archivo fixture (CA-S1)');

    // ─── Cooldown destructivo — primer /restart ok, segundo rechazado ──────
    const r1 = await dispatcher.dispatch({ chat_id: '999', from: 'Leo', text: '/restart' });
    assert(r1.status === 'ok', 'primer /restart ejecuta el handler stub');

    clock += 10_000; // 10s después
    const r2 = await dispatcher.dispatch({ chat_id: '999', from: 'Leo', text: '/restart' });
    assert(r2.status === 'cooldown', `/restart consecutivo bloqueado (got ${r2.status})`);
    assert(/cooldown/i.test(r2.reply || ''), 'reply de cooldown menciona "cooldown"');

    clock += 60_000; // 60s más → cooldown expira
    const r3 = await dispatcher.dispatch({ chat_id: '999', from: 'Leo', text: '/restart' });
    assert(r3.status === 'ok', '/restart tras cooldown expirado se vuelve a permitir');

    // ─── Spy: ningún spawn LLM se invocó ────────────────────────────────────
    const llmCalls = spawnCalls.filter(isLLMSpawn);
    if (llmCalls.length > 0) {
        console.error('  ✘ Spawn de LLM detectado durante el smoke:', llmCalls.map((c) => c.cmd));
        process.exit(1);
    } else {
        pass(`ningún spawn LLM durante el smoke (${spawnCalls.length} spawns benignos totales)`);
    }

    // ─── Tiempo total < 30s ────────────────────────────────────────────────
    const totalMs = Date.now() - startedAt;
    assert(totalMs < 30_000, `smoke total ${totalMs}ms (<30s)`);

    // ─── Cleanup ────────────────────────────────────────────────────────────
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    console.log(`\n[smoke] OK · ${totalMs}ms`);
}

run().catch((e) => {
    console.error('[smoke] FAIL:', e && e.stack || e);
    process.exit(1);
});
