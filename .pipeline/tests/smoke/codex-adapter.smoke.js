#!/usr/bin/env node
// =============================================================================
// codex-adapter.smoke.js — Smoke E2E del adapter openai-codex
//
// Objetivo: invocar el provider real (no mockeado) y verificar que el
// pipeline buildSpawn → child_process.spawn → parseTokensFromLog cierra el
// contrato canónico contra `codex exec --json` con OAuth de ChatGPT Plus.
//
// NO toca el pulpo. NO requiere pipeline corriendo. Es un smoke aislado.
// =============================================================================
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const provider = require('../../lib/agent-launcher/providers/openai-codex.js');

const TIMEOUT_MS = 60_000;
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

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-smoke-'));
    const logPath = path.join(tmpDir, 'codex.jsonl');
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });

    const child = spawn(spawnCfg.cmd, spawnCfg.args, spawnCfg.spawnOpts);

    let stdoutBytes = 0;
    let stderrBytes = 0;
    let firstEvent = null;
    let lastEvent = null;
    let eventCount = 0;
    let agentMessage = null;
    let turnCompleted = null;

    child.stdout.on('data', (chunk) => {
        stdoutBytes += chunk.length;
        logStream.write(chunk);
        for (const line of chunk.toString('utf8').split('\n')) {
            if (!line.startsWith('{')) continue;
            try {
                const obj = JSON.parse(line);
                eventCount++;
                if (!firstEvent) firstEvent = obj.type;
                lastEvent = obj.type;
                if (obj.type === 'item.completed' && obj.item && obj.item.type === 'agent_message') {
                    agentMessage = obj.item.text;
                }
                if (obj.type === 'turn.completed') {
                    turnCompleted = obj;
                }
            } catch { /* línea parcial */ }
        }
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
    const dtMs = Date.now() - t0;

    console.log('---');
    console.log(`[smoke] exit_code      = ${exitCode}`);
    console.log(`[smoke] duration_ms    = ${dtMs}`);
    console.log(`[smoke] stdout_bytes   = ${stdoutBytes}`);
    console.log(`[smoke] stderr_bytes   = ${stderrBytes}`);
    console.log(`[smoke] events_parsed  = ${eventCount}`);
    console.log(`[smoke] first_event    = ${firstEvent}`);
    console.log(`[smoke] last_event     = ${lastEvent}`);
    console.log(`[smoke] agent_message  = ${JSON.stringify(agentMessage)}`);
    console.log(`[smoke] turn_usage     = ${turnCompleted ? JSON.stringify(turnCompleted.usage) : 'null'}`);

    const tokens = provider.parseTokensFromLog(logPath);
    console.log(`[smoke] parseTokens    = ${JSON.stringify(tokens)}`);

    const QE = require('../../lib/quota-exhausted.js');
    const qe = provider.detectQuotaExhausted(logPath, null, QE);
    console.log(`[smoke] detectQuota    = ${JSON.stringify({ matched: qe.matched, errorType: qe.errorType || null })}`);

    const ok =
        exitCode === 0 &&
        firstEvent === 'thread.started' &&
        lastEvent === 'turn.completed' &&
        tokens.input > 0 &&
        tokens.output > 0 &&
        qe.matched === false &&
        agentMessage != null;

    console.log(`[smoke] log_path       = ${logPath}`);
    console.log(`[smoke] RESULT         = ${ok ? 'PASS' : 'FAIL'}`);
    process.exit(ok ? 0 : 1);
}

main().catch((err) => {
    console.error('[smoke] uncaught:', err);
    process.exit(2);
});
