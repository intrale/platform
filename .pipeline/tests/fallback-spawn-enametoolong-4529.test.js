// =============================================================================
// fallback-spawn-enametoolong-4529.test.js — Regresión del incidente #4529
//
// Incidente (2026-07-06): la cadena de fallback del Commander moría en el spawn
// con `spawn ENAMETOOLONG` en Windows. Causa raíz: los adapters no-Anthropic
// (codex, gemini; y los retirados cerebras, nvidia — #6563) foldeaban el system prompt + historial en la
// LÍNEA DE COMANDO (argv), superando el límite de `CreateProcess` (~32K). El
// proceso del CLI nunca se creaba → throw síncrono antes de tocar la API.
//
// Fix: el payload grande (system foldeado + prompt) viaja por STDIN, igual que el
// path primario de Anthropic escribe el system prompt a archivo. `buildSpawn`
// devuelve `stdinPayload` y deja el argv chico (codex `-`, gemini `-p ''`).
//
// Estos tests verifican DOS cosas por provider:
//   1) CONTRATO: con un system prompt >32K, el argv total queda muy por debajo
//      del límite y el payload sale por `stdinPayload`.
//   2) SPAWN REAL: spawneamos `node` (comando benigno) con el argv construido y
//      un payload >32K por stdin — NO debe lanzar ENAMETOOLONG. Reproduce el
//      caso real del incidente end-to-end a nivel de `child_process.spawn`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const codex = require('../lib/agent-launcher/providers/openai-codex.js');
const gemini = require('../lib/agent-launcher/providers/antigravity.js');

// Límite práctico de la línea de comando de Windows (CreateProcess ~32767). El
// argv construido debe quedar MUY por debajo aunque el payload sea gigante.
const WINDOWS_CMDLINE_LIMIT = 32767;

// System prompt realista y GRANDE: > 32K. Emula persona + context-pack + RAG +
// historial que el Commander foldea en el fallback (el tamaño que reventaba argv).
function bigSystemPrompt() {
    const block = 'Sos el Commander de Intrale. Respondé natural, en español rioplatense. ';
    // ~64KB — el doble del límite, para garantizar que el caso viejo fallaría.
    return block.repeat(1000);
}

function writeBigSystemFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enametoolong-4529-'));
    const sysFile = path.join(dir, 'system.md');
    fs.writeFileSync(sysFile, bigSystemPrompt(), 'utf8');
    return { dir, sysFile };
}

function argvBytes(args) {
    return args.reduce((n, a) => n + Buffer.byteLength(String(a), 'utf8') + 1, 0);
}

// Setea un launcher determinístico basado en `node` para que el argv NO dependa
// de detectar binarios reales (codex/gemini) y podamos spawnear de verdad.
function forceNodeLauncher(provider, scriptStub) {
    provider._setLauncherForTesting({
        kind: 'test-node',
        cmd: process.execPath,
        prefixArgs: [scriptStub],
        shell: false,
    });
}

// Script benigno que consume stdin y sale 0 — emula el CLI sin tocar ninguna API.
function stdinSinkScript() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enametoolong-sink-'));
    const p = path.join(dir, 'sink.js');
    fs.writeFileSync(p, 'process.stdin.resume();process.stdin.on("data",()=>{});process.stdin.on("end",()=>process.exit(0));', 'utf8');
    return p;
}

// -----------------------------------------------------------------------------
// codex: argv chico + payload >32K por stdin, y spawn real sin ENAMETOOLONG.
// -----------------------------------------------------------------------------
test('#4529 codex: system >32K va por stdin, argv chico, spawn real sin ENAMETOOLONG', () => {
    const { sysFile } = writeBigSystemFile();
    const sink = stdinSinkScript();
    forceNodeLauncher(codex, sink);
    try {
        const spawnDef = codex.buildSpawn({
            args: ['-p', 'Hola, cómo va todo?', '--system-prompt-file', sysFile],
            cwd: process.cwd(),
            env: { CODEX_MODEL: 'gpt-5' },
        });
        // 1) argv NO contiene el system prompt gigante y queda chico.
        assert.ok(argvBytes(spawnDef.args) < 4096, `argv demasiado grande: ${argvBytes(spawnDef.args)}`);
        assert.ok(spawnDef.args.every((a) => !String(a).includes('Sos el Commander')));
        assert.equal(spawnDef.args[spawnDef.args.length - 1], '-');
        // 2) el payload gigante viaja por stdinPayload.
        assert.ok(spawnDef.stdinPayload.length > WINDOWS_CMDLINE_LIMIT);
        assert.ok(spawnDef.stdinPayload.startsWith('Sos el Commander'));
        assert.ok(spawnDef.stdinPayload.includes('Hola, cómo va todo?'));
        // 3) SPAWN REAL: no debe lanzar ENAMETOOLONG (el caso viejo lo hacía).
        const r = spawnSync(spawnDef.cmd, spawnDef.args, {
            input: spawnDef.stdinPayload,
            timeout: 15000,
            windowsHide: true,
        });
        assert.equal(r.error, undefined, `spawn falló: ${r.error && r.error.code}`);
        assert.equal(r.status, 0);
    } finally {
        codex._resetLauncherCacheForTesting();
    }
});

// -----------------------------------------------------------------------------
// gemini: NDJSON por stdin (`--input-format stream-json`, #6857) + payload >32K, spawn real sin ENAMETOOLONG.
// -----------------------------------------------------------------------------
test('#4529 gemini: system >32K va por stdin (NDJSON), argv chico, spawn real sin ENAMETOOLONG', () => {
    const { sysFile } = writeBigSystemFile();
    const sink = stdinSinkScript();
    forceNodeLauncher(gemini, sink);
    try {
        const spawnDef = gemini.buildSpawn({
            args: ['-p', 'Contame el estado', '--system-prompt-file', sysFile],
            cwd: process.cwd(),
            env: { ANTIGRAVITY_MODEL: 'gemini-3.8-flash-medium' },
        });
        assert.ok(argvBytes(spawnDef.args) < 4096, `argv demasiado grande: ${argvBytes(spawnDef.args)}`);
        assert.ok(spawnDef.args.every((a) => !String(a).includes('Sos el Commander')));
        // #6857 — agy 1.2.x: el prompt entra por `--input-format stream-json`
        // (NDJSON por stdin); `--print` sin valor dejó de existir. El invariante
        // de #4529 se mantiene: argv chico, payload gigante por stdin.
        assert.ok(spawnDef.args.includes('--input-format') && spawnDef.args.includes('stream-json'));
        assert.ok(!spawnDef.args.includes('--print'));
        assert.ok(!spawnDef.args.includes('Contame el estado'));
        assert.ok(spawnDef.stdinPayload.length > WINDOWS_CMDLINE_LIMIT);
        assert.ok(spawnDef.stdinPayload.includes('Contame el estado'));
        assert.equal(JSON.parse(spawnDef.stdinPayload).event, 'user', 'una línea NDJSON válida');
        const r = spawnSync(spawnDef.cmd, spawnDef.args, {
            input: spawnDef.stdinPayload,
            timeout: 15000,
            windowsHide: true,
        });
        assert.equal(r.error, undefined, `spawn falló: ${r.error && r.error.code}`);
        assert.equal(r.status, 0);
    } finally {
        gemini._resetLauncherCacheForTesting();
    }
});

// #6563 — los casos de cerebras / nvidia-nim (runners Node con `--prompt -`)
// se retiraron con esos providers.
