#!/usr/bin/env node
// =============================================================================
// gemini-add-dir.smoke.js — Smoke E2E de #6859 contra el binario REAL de agy
//
// Evidencia de CA-1 y CA-3 del issue, que no se pueden fabricar con un fake:
//   CA-1  un agente despachado a este provider sobre un worktree escribe EN ESE
//         worktree, verificado con un archivo real y con `git status` mostrando
//         el cambio.
//   CA-3  el scratch de Antigravity (`~/.gemini/antigravity-cli/scratch/`)
//         queda igual que antes del spawn — la contracara que atrapa la
//         regresión (sin `--add-dir` el archivo cae ahí y el CLI dice SUCCESS).
//
// Cómo: crea un repo git temporal, arma el spawn con `provider.buildSpawn`
// (mismo argv/payload que usa el pipeline), le pide al modelo crear un archivo
// "en el directorio de trabajo", y asserta sobre disco + `git status --porcelain`
// + snapshot del scratch antes/después. NUNCA usa `obj.status === 'SUCCESS'`
// como prueba de nada.
//
// Requiere: agy instalado y logueado (OAuth) + cuota. No corre en `node --test`.
//   node .pipeline/tests/smoke/gemini-add-dir.smoke.js [--model gemini-3.7-flash-low]
// Exit 0 = PASS, 1 = FAIL, 2 = error de infraestructura (agy ausente, etc.).
// =============================================================================
'use strict';

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const provider = require('../../lib/agent-launcher/providers/gemini-google.js');

const TIMEOUT_MS = 180_000;
const argvModel = (() => {
    const i = process.argv.indexOf('--model');
    return i >= 0 ? process.argv[i + 1] : null;
})();
const MODEL = argvModel || process.env.GEMINI_MODEL || 'gemini-3.7-flash-low';

function listDir(dir) {
    try { return fs.readdirSync(dir).sort(); } catch { return []; }
}
function git(cwd, ...args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function main() {
    const t0 = Date.now();
    const launcher = provider.detectLauncher();
    console.log(`[smoke-6859] launcher     = ${launcher.kind} → ${launcher.cmd}`);
    let version = '?';
    try { version = execFileSync(launcher.cmd, ['--version'], { encoding: 'utf8' }).trim(); } catch (e) {
        console.error(`[smoke-6859] agy no responde a --version: ${e.message}`);
        process.exit(2);
    }
    console.log(`[smoke-6859] agy --version = ${version}`);
    console.log(`[smoke-6859] model        = ${MODEL}`);

    // Repo git temporal = "worktree" del agente.
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-6859-wt-'));
    git(worktree, 'init', '-q');
    fs.writeFileSync(path.join(worktree, 'README.md'), '# smoke 6859\n');
    git(worktree, 'add', '.');
    git(worktree, '-c', 'user.email=smoke@intrale.local', '-c', 'user.name=smoke', 'commit', '-q', '-m', 'base');
    console.log(`[smoke-6859] worktree     = ${worktree}`);

    const scratch = provider.agyScratchDir();
    const scratchBefore = listDir(scratch);
    console.log(`[smoke-6859] scratch      = ${scratch}`);
    console.log(`[smoke-6859] scratch antes= ${JSON.stringify(scratchBefore)}`);

    const marker = `marca-6859-${Date.now()}.txt`;
    const prompt = `Crea un archivo llamado ${marker} en el directorio de trabajo con el contenido exacto "6859-OK". `
        + 'No crees ningún otro archivo. Cuando termines responde solo con la ruta absoluta del archivo creado.';

    const spawnCfg = provider.buildSpawn({
        args: ['-p', prompt],
        cwd: worktree,
        env: { ...process.env, GEMINI_MODEL: MODEL },
        interactive_supported: false,
    });
    console.log(`[smoke-6859] spawn.args   = ${JSON.stringify(spawnCfg.args)}`);
    if (!spawnCfg.args.includes('--add-dir')) {
        console.error('[smoke-6859] el handler no emitió --add-dir: FAIL');
        process.exit(1);
    }

    const child = spawn(spawnCfg.cmd, spawnCfg.args, spawnCfg.spawnOpts);
    child.stdin.write(spawnCfg.stdinPayload);
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => { console.error('[smoke-6859] TIMEOUT'); child.kill('SIGKILL'); }, TIMEOUT_MS);
    const exitCode = await new Promise((resolve) => {
        child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
        child.on('error', (err) => { clearTimeout(timer); console.error('[smoke-6859] spawn error:', err); resolve(-1); });
    });
    const dtMs = Date.now() - t0;
    const result = provider._parseGeminiJson(stdout);

    // Evidencia sobre disco (lo único que vale).
    const markerPath = path.join(worktree, marker);
    const markerExists = fs.existsSync(markerPath);
    const markerContent = markerExists ? fs.readFileSync(markerPath, 'utf8').trim() : null;
    const gitStatus = git(worktree, 'status', '--porcelain');
    const scratchAfter = listDir(scratch);
    const scratchNew = scratchAfter.filter((f) => !scratchBefore.includes(f));

    console.log('---');
    console.log(`[smoke-6859] exit_code    = ${exitCode}  (${dtMs} ms)`);
    console.log(`[smoke-6859] cli.status   = ${result ? result.status : 'sin result'}  (NO es evidencia)`);
    console.log(`[smoke-6859] cli.response = ${result ? JSON.stringify(result.response) : 'null'}`);
    if (stderr.trim()) console.log(`[smoke-6859] stderr       = ${stderr.trim().slice(0, 400)}`);
    console.log(`[smoke-6859] CA-1 archivo = ${markerPath} → ${markerExists ? 'EXISTE' : 'NO EXISTE'} contenido=${JSON.stringify(markerContent)}`);
    console.log(`[smoke-6859] CA-1 git st  = ${JSON.stringify(gitStatus)}`);
    console.log(`[smoke-6859] CA-3 scratch = antes ${scratchBefore.length} / después ${scratchAfter.length}; nuevos=${JSON.stringify(scratchNew)}`);

    const ca1 = markerExists && markerContent === '6859-OK' && gitStatus.split(/\r?\n/).some((l) => l.includes(marker));
    const ca3 = scratchNew.length === 0;
    const ok = exitCode === 0 && ca1 && ca3;
    console.log(`[smoke-6859] CA-1 = ${ca1 ? 'PASS' : 'FAIL'} · CA-3 = ${ca3 ? 'PASS' : 'FAIL'}`);
    console.log(`[smoke-6859] RESULT       = ${ok ? 'PASS' : 'FAIL'}`);
    // El worktree temporal se deja para inspección si falló.
    if (ok) { try { fs.rmSync(worktree, { recursive: true, force: true }); } catch { /* best-effort */ } }
    else console.log(`[smoke-6859] worktree conservado para inspección: ${worktree}`);
    process.exit(ok ? 0 : 1);
}

main().catch((err) => {
    console.error('[smoke-6859] uncaught:', err);
    process.exit(2);
});
