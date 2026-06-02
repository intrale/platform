#!/usr/bin/env node
// =============================================================================
// cerebras-adapter.smoke.js — Smoke E2E del adapter cerebras
//
// Objetivo: invocar el provider real (no mockeado) y verificar que el pipeline
// buildSpawn → child_process.spawn → parseTokensFromLog cierra el contrato
// canónico contra el runner REST de Cerebras
// (`api.cerebras.ai/v1/chat/completions`, free tier con API key).
//
// NO toca el pulpo. NO requiere pipeline corriendo. Es un smoke aislado.
// La API key sale de env CEREBRAS_API_KEY (la hidrata credentials.js); el
// runner también la resuelve solo si no está en env.
// =============================================================================
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const provider = require('../../lib/agent-launcher/providers/cerebras.js');
const credentials = require('../../lib/credentials.js');

const TIMEOUT_MS = 120_000;
const PROMPT = 'Responde exactamente con la palabra OK y nada mas. No expliques nada.';
// El free tier sólo expone modelos de razonamiento; `gpt-oss-120b` es el default
// del runner (más rápido que `zai-glm-4.7`). `llama-3.3-70b` NO existe en este tier.
const MODEL = process.env.CEREBRAS_MODEL || 'gpt-oss-120b';

async function main() {
    // Hidratar la API key como lo hace el pulpo al boot.
    credentials.loadIntoEnv({ logger: () => {} });

    const t0 = Date.now();
    const launcher = provider.detectLauncher();
    console.log(`[smoke] launcher.kind = ${launcher.kind}`);
    console.log(`[smoke] launcher.cmd  = ${launcher.cmd}`);

    const args = ['-p', PROMPT];
    const cwd = process.cwd();
    const env = { ...process.env, CEREBRAS_MODEL: MODEL };
    const spawnCfg = provider.buildSpawn({ args, cwd, env, interactive_supported: false });

    console.log(`[smoke] model      = ${MODEL}`);
    console.log(`[smoke] spawn.cmd  = ${spawnCfg.cmd}`);
    console.log(`[smoke] spawn.args = ${JSON.stringify(spawnCfg.args)}`);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebras-smoke-'));
    const logPath = path.join(tmpDir, 'cerebras.json');
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });

    const child = spawn(spawnCfg.cmd, spawnCfg.args, spawnCfg.spawnOpts);

    let stdoutBytes = 0;
    let stderrBytes = 0;

    child.stdout.on('data', (chunk) => { stdoutBytes += chunk.length; logStream.write(chunk); });
    child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; process.stderr.write(chunk); });

    const timer = setTimeout(() => {
        console.error('[smoke] TIMEOUT — killing child');
        child.kill('SIGKILL');
    }, TIMEOUT_MS);

    const exitCode = await new Promise((resolve) => {
        child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
        child.on('error', (err) => { clearTimeout(timer); console.error('[smoke] spawn error:', err); resolve(-1); });
    });

    logStream.end();
    await new Promise((r) => logStream.on('finish', r));
    const dtMs = Date.now() - t0;

    const raw = fs.readFileSync(logPath, 'utf8');
    const obj = provider._parseCerebrasJson(raw);
    const responseText = obj && obj.choices && obj.choices[0] && obj.choices[0].message
        ? obj.choices[0].message.content : null;

    console.log('---');
    console.log(`[smoke] exit_code      = ${exitCode}`);
    console.log(`[smoke] duration_ms    = ${dtMs}`);
    console.log(`[smoke] stdout_bytes   = ${stdoutBytes}`);
    console.log(`[smoke] stderr_bytes   = ${stderrBytes}`);
    console.log(`[smoke] json_parsed    = ${obj ? 'yes' : 'no'}`);
    console.log(`[smoke] response       = ${JSON.stringify(responseText)}`);

    const tokens = provider.parseTokensFromLog(logPath);
    console.log(`[smoke] parseTokens    = ${JSON.stringify(tokens)}`);

    const QE = require('../../lib/quota-exhausted.js');
    const qe = provider.detectQuotaExhausted(logPath, null, QE);
    console.log(`[smoke] detectQuota    = ${JSON.stringify({ matched: qe.matched, errorType: qe.errorType || null })}`);

    const ok =
        exitCode === 0 &&
        obj != null &&
        typeof responseText === 'string' && responseText.length > 0 &&
        tokens.input > 0 &&
        qe.matched === false;

    console.log(`[smoke] log_path       = ${logPath}`);
    console.log(`[smoke] RESULT         = ${ok ? 'PASS' : 'FAIL'}`);
    process.exit(ok ? 0 : 1);
}

main().catch((err) => {
    console.error('[smoke] uncaught:', err);
    process.exit(2);
});
