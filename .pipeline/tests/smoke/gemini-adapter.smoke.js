#!/usr/bin/env node
// =============================================================================
// gemini-adapter.smoke.js — Smoke E2E del adapter gemini-google
//
// Objetivo: invocar el provider real (no mockeado) y verificar que el
// pipeline buildSpawn → child_process.spawn → parseTokensFromLog cierra el
// contrato canónico contra `gemini --skip-trust -o json -p ...` con OAuth
// gratuito (cuenta Google, free tier real).
//
// NO toca el pulpo. NO requiere pipeline corriendo. Es un smoke aislado.
// =============================================================================
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const provider = require('../../lib/agent-launcher/providers/gemini-google.js');

const TIMEOUT_MS = 90_000;
const PROMPT = 'Responde exactamente con la palabra OK y nada mas. No expliques nada.';

async function main() {
    const t0 = Date.now();
    const launcher = provider.detectLauncher();
    console.log(`[smoke] launcher.kind = ${launcher.kind}`);
    console.log(`[smoke] launcher.cmd  = ${launcher.cmd}`);

    const args = ['-p', PROMPT];
    const cwd = process.cwd();
    const env = { ...process.env };
    const spawnCfg = provider.buildSpawn({ args, cwd, env, interactive_supported: false });

    console.log(`[smoke] spawn.cmd  = ${spawnCfg.cmd}`);
    console.log(`[smoke] spawn.args = ${JSON.stringify(spawnCfg.args)}`);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-smoke-'));
    const logPath = path.join(tmpDir, 'gemini.json');
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });

    const child = spawn(spawnCfg.cmd, spawnCfg.args, spawnCfg.spawnOpts);

    let stdoutBytes = 0;
    let stderrBytes = 0;

    child.stdout.on('data', (chunk) => {
        stdoutBytes += chunk.length;
        logStream.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
        stderrBytes += chunk.length;
        process.stderr.write(chunk);
    });

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
    const obj = provider._parseGeminiJson(raw);

    console.log('---');
    console.log(`[smoke] exit_code      = ${exitCode}`);
    console.log(`[smoke] duration_ms    = ${dtMs}`);
    console.log(`[smoke] stdout_bytes   = ${stdoutBytes}`);
    console.log(`[smoke] stderr_bytes   = ${stderrBytes}`);
    console.log(`[smoke] json_parsed    = ${obj ? 'yes' : 'no'}`);
    console.log(`[smoke] response       = ${obj ? JSON.stringify(obj.response) : 'null'}`);
    console.log(`[smoke] models         = ${obj && obj.stats && obj.stats.models ? JSON.stringify(Object.keys(obj.stats.models)) : 'none'}`);

    const tokens = provider.parseTokensFromLog(logPath);
    console.log(`[smoke] parseTokens    = ${JSON.stringify(tokens)}`);

    const QE = require('../../lib/quota-exhausted.js');
    const qe = provider.detectQuotaExhausted(logPath, null, QE);
    console.log(`[smoke] detectQuota    = ${JSON.stringify({ matched: qe.matched, errorType: qe.errorType || null })}`);

    const ok =
        exitCode === 0 &&
        obj != null &&
        typeof obj.response === 'string' && obj.response.length > 0 &&
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
