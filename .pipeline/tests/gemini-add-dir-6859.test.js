'use strict';

// =============================================================================
// #6859 — El launcher de Antigravity ignora el worktree: sin `--add-dir` el
// agente escribe en un scratch fantasma (`~/.gemini/antigravity-cli/scratch/`)
// y el CLI reporta SUCCESS igual.
//
// Cobertura:
//   CA-2  el `cwd` de `buildSpawn` viaja como `--add-dir <cwd>` (repetible con
//         `extraDirs`), verificado SOBRE DISCO con un `agy` falso que imita el
//         comportamiento medido en vivo (3/9, 16/9 y 17/9): honra el primer
//         `--add-dir` y, si falta, escribe en un scratch propio reportando
//         SUCCESS. El test asserta que el archivo está en el dir pedido, NO que
//         el CLI dijo que salió bien.
//   CA-3  el scratch (falso) queda vacío tras el spawn con el argv real del
//         handler. La contracara: el mismo fake SIN `--add-dir` sí escribe en el
//         scratch, lo que prueba que el fake atrapa la regresión.
//   CA-4  sin `cwd` (o con uno relativo/no-string) `buildSpawn` lanza con
//         `code='AGY_WORKSPACE_REQUIRED'` y un mensaje accionable que nombra el
//         scratch, el issue y el skill si vienen en `env`.
//
// El smoke contra el binario real (CA-1: archivo real + `git status`) vive en
// `tests/smoke/gemini-add-dir.smoke.js` — requiere OAuth y cuota, no corre acá.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const provider = require('../lib/agent-launcher/providers/gemini-google');

function tmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// -----------------------------------------------------------------------------
// `agy` falso — reproduce EXACTAMENTE la semántica medida en vivo:
//   * Lee el NDJSON de stdin (una línea `{"event":"user",...}`), extrae el
//     nombre del archivo pedido del `content` (`crear <nombre>`).
//   * Si hay `--add-dir`, escribe en el PRIMERO. Si no hay, escribe en el
//     scratch (`AGY_FAKE_SCRATCH`) y — como el real — reporta SUCCESS igual.
//   * Nunca usa `process.cwd()`: ése es el bug que motiva el issue.
//   * Emite el evento `{"event":"result","result":{"status":"SUCCESS",...}}`.
// Se ejecuta con `process.execPath` + `prefixArgs: [script]` a través de
// `_setLauncherForTesting`, así que el test spawnea el `cmd`/`args`/`spawnOpts`
// que devuelve `buildSpawn` sin tocar nada.
// -----------------------------------------------------------------------------
const FAKE_AGY_SOURCE = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const addDirs = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === '--add-dir') { addDirs.push(argv[i + 1]); i++; }
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
    const msg = JSON.parse(raw.trim().split(/\\r?\\n/)[0]);
    const m = /crear\\s+(\\S+)/.exec(msg.message.content);
    const name = m ? m[1] : 'sin-nombre.txt';
    const target = addDirs.length > 0 ? addDirs[0] : process.env.AGY_FAKE_SCRATCH;
    fs.mkdirSync(target, { recursive: true });
    const file = path.join(target, name);
    fs.writeFileSync(file, 'escrito-por-fake-agy\\n');
    process.stdout.write(JSON.stringify({ event: 'init', add_dirs: addDirs }) + '\\n');
    process.stdout.write(JSON.stringify({ event: 'result', result: {
        status: 'SUCCESS', response: file + '\\n',
        usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 12 },
    } }) + '\\n');
    process.exit(0);
});
`;

function writeFakeAgy(dir) {
    const script = path.join(dir, 'fake-agy.js');
    fs.writeFileSync(script, FAKE_AGY_SOURCE);
    return script;
}

function runSpawn(spawnDef) {
    return new Promise((resolve, reject) => {
        const child = spawn(spawnDef.cmd, spawnDef.args, spawnDef.spawnOpts);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => { stdout += c; });
        child.stderr.on('data', (c) => { stderr += c; });
        child.on('error', reject);
        child.on('exit', (code) => resolve({ code, stdout, stderr }));
        if (spawnDef.stdinPayload != null) {
            child.stdin.write(spawnDef.stdinPayload);
            child.stdin.end();
        }
    });
}

function listFiles(dir) {
    try { return fs.readdirSync(dir).sort(); } catch { return []; }
}

// =============================================================================
// Argv (unitario, sin spawn)
// =============================================================================
test('#6859: buildSpawn traduce el cwd a `--add-dir <cwd>` y lo mantiene en spawnOpts.cwd', () => {
    provider._setLauncherForTesting({ kind: 'native-exe', cmd: 'agy', prefixArgs: [], shell: false });
    try {
        const cwd = path.join(ROOT, 'app');
        const spawnDef = provider.buildSpawn({ args: ['-p', 'hola'], cwd, env: { GEMINI_MODEL: 'gemini-3.8-flash-low' } });
        const idx = spawnDef.args.indexOf('--add-dir');
        assert.ok(idx >= 0, 'falta --add-dir');
        assert.equal(spawnDef.args[idx + 1], cwd);
        assert.equal(spawnDef.args.filter((a) => a === '--add-dir').length, 1, 'un solo --add-dir para un solo cwd');
        assert.equal(spawnDef.spawnOpts.cwd, cwd, 'el cwd sigue en spawnOpts (paridad con los otros handlers)');
        // `--model` sigue siendo lo último: los tests de #6858 lo fijan con slice(-2).
        assert.deepEqual(spawnDef.args.slice(-2), ['--model', 'gemini-3.8-flash-low']);
        // El payload no cambia (#4529 / #6857).
        assert.deepEqual(JSON.parse(spawnDef.stdinPayload), { event: 'user', message: { role: 'user', content: 'hola' } });
    } finally {
        provider._resetLauncherCacheForTesting();
    }
});

test('#6859: `extraDirs` agrega un `--add-dir` por directorio adicional (el flag es repetible)', () => {
    provider._setLauncherForTesting({ kind: 'native-exe', cmd: 'agy', prefixArgs: [], shell: false });
    try {
        const cwd = path.join(ROOT, 'app');
        const extra1 = path.join(ROOT, 'docs');
        const extra2 = path.join(ROOT, 'backend');
        const spawnDef = provider.buildSpawn({ args: ['-p', 'hola'], cwd, env: {}, extraDirs: [extra1, extra2] });
        const dirs = [];
        for (let i = 0; i < spawnDef.args.length; i++) {
            if (spawnDef.args[i] === '--add-dir') dirs.push(spawnDef.args[i + 1]);
        }
        assert.deepEqual(dirs, [cwd, extra1, extra2], 'el cwd primero, después los adicionales en orden');
        // Un extraDir relativo también falla fuerte: mismo contrato que el cwd.
        assert.throws(
            () => provider.buildSpawn({ args: [], cwd, env: {}, extraDirs: ['relativo/x'] }),
            (e) => e.code === provider.AGY_WORKSPACE_ERROR_CODE && /extraDirs\[\]/.test(e.message),
        );
    } finally {
        provider._resetLauncherCacheForTesting();
    }
});

// =============================================================================
// CA-4 — fail-fast sin cwd
// =============================================================================
test('#6859 (CA-4): sin cwd buildSpawn lanza AGY_WORKSPACE_REQUIRED con mensaje accionable (scratch, issue y skill)', () => {
    provider._setLauncherForTesting({ kind: 'native-exe', cmd: 'agy', prefixArgs: [], shell: false });
    try {
        const env = { GEMINI_MODEL: 'gemini-3.8-flash-low', PIPELINE_ISSUE: '6859', PIPELINE_SKILL: 'android-dev' };
        const casos = [
            { cwd: undefined, etiqueta: 'undefined' },
            { cwd: null, etiqueta: 'null' },
            { cwd: '', etiqueta: 'string vacío' },
            { cwd: 'relativo/worktree', etiqueta: 'ruta relativa' },
            { cwd: 42, etiqueta: 'no-string' },
        ];
        for (const { cwd, etiqueta } of casos) {
            assert.throws(
                () => provider.buildSpawn({ args: ['-p', 'hola'], cwd, env }),
                (e) => {
                    assert.equal(e.code, provider.AGY_WORKSPACE_ERROR_CODE, `code (${etiqueta})`);
                    assert.match(e.message, /--add-dir/, `menciona el flag (${etiqueta})`);
                    assert.match(e.message, /scratch/, `menciona el scratch (${etiqueta})`);
                    assert.ok(e.message.includes(provider.agyScratchDir()), `incluye el path del scratch (${etiqueta})`);
                    assert.match(e.message, /issue #6859/, `incluye el issue (${etiqueta})`);
                    assert.match(e.message, /skill android-dev/, `incluye el skill (${etiqueta})`);
                    assert.match(e.message, /'cwd'/, `nombra el campo (${etiqueta})`);
                    return true;
                },
                etiqueta,
            );
        }
        // Sin PIPELINE_* en el env el mensaje sigue siendo accionable (sin el bloque de contexto).
        assert.throws(
            () => provider.buildSpawn({ args: [], env: {} }),
            (e) => e.code === provider.AGY_WORKSPACE_ERROR_CODE && !/issue #/.test(e.message) && /scratch/.test(e.message),
        );
    } finally {
        provider._resetLauncherCacheForTesting();
    }
});

test('#6859: agyScratchDir resuelve ~/.gemini/antigravity-cli/scratch (homedir inyectable)', () => {
    assert.equal(provider.agyScratchDir('/home/x'), path.join('/home/x', '.gemini', 'antigravity-cli', 'scratch'));
    assert.deepEqual([...provider.AGY_SCRATCH_RELATIVE], ['.gemini', 'antigravity-cli', 'scratch']);
    assert.ok(provider.agyScratchDir().startsWith(os.homedir()));
});

// =============================================================================
// CA-2 / CA-3 — sobre disco, con el `agy` falso que honra `--add-dir`
// =============================================================================
test('#6859 (CA-2/CA-3): el archivo aparece en el cwd pedido y el scratch queda vacío — se asserta disco, no el SUCCESS del CLI', async () => {
    const base = tmpDir('agy-6859-');
    const fakeScript = writeFakeAgy(base);
    const worktree = path.join(base, 'worktree');
    const scratch = path.join(base, 'scratch');
    fs.mkdirSync(worktree);
    fs.mkdirSync(scratch);

    provider._setLauncherForTesting({ kind: 'configured-native', cmd: process.execPath, prefixArgs: [fakeScript], shell: false });
    try {
        const spawnDef = provider.buildSpawn({
            args: ['-p', 'crear marca-6859.txt en el directorio actual'],
            cwd: worktree,
            env: { ...process.env, AGY_FAKE_SCRATCH: scratch, GEMINI_MODEL: 'gemini-3.8-flash-low' },
        });
        const r = await runSpawn(spawnDef);
        assert.equal(r.code, 0, r.stderr);
        // El CLI reporta SUCCESS — eso NO alcanza como evidencia (es lo que engañaba).
        const result = provider._parseGeminiJson(r.stdout);
        assert.equal(result.status, 'SUCCESS');
        // CA-2: el archivo está en el worktree pedido.
        assert.deepEqual(listFiles(worktree), ['marca-6859.txt'], 'el archivo tiene que estar en el cwd pedido');
        assert.equal(fs.readFileSync(path.join(worktree, 'marca-6859.txt'), 'utf8'), 'escrito-por-fake-agy\n');
        // CA-3: el scratch quedó vacío.
        assert.deepEqual(listFiles(scratch), [], 'el scratch NO puede recibir nada cuando viaja --add-dir');
    } finally {
        provider._resetLauncherCacheForTesting();
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('#6859 (regresión): el mismo fake SIN --add-dir escribe en el scratch reportando SUCCESS — el check de CA-3 atrapa la regresión', async () => {
    const base = tmpDir('agy-6859-sin-');
    const fakeScript = writeFakeAgy(base);
    const worktree = path.join(base, 'worktree');
    const scratch = path.join(base, 'scratch');
    fs.mkdirSync(worktree);
    fs.mkdirSync(scratch);
    try {
        // Argv legacy (pre-#6859): sin workspace, tal como lo armaba el handler.
        const legacyArgs = provider._translateClaudeArgsToGemini(['-p', 'x'], { GEMINI_MODEL: 'gemini-3.8-flash-low' });
        assert.ok(!legacyArgs.includes('--add-dir'));
        const r = await runSpawn({
            cmd: process.execPath,
            args: [fakeScript, ...legacyArgs],
            stdinPayload: provider._encodeStreamJsonPayload('crear marca-legacy.txt en el directorio actual'),
            spawnOpts: { cwd: worktree, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AGY_FAKE_SCRATCH: scratch }, windowsHide: true },
        });
        assert.equal(r.code, 0, r.stderr);
        assert.equal(provider._parseGeminiJson(r.stdout).status, 'SUCCESS', 'el CLI dice SUCCESS igual: por eso el bug era silencioso');
        assert.deepEqual(listFiles(worktree), [], 'el cwd del proceso NO se usa: quedó vacío');
        assert.deepEqual(listFiles(scratch), ['marca-legacy.txt'], 'el archivo cayó al scratch fantasma');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

// Guardrail de código: el handler no puede volver a armar el argv sin `--add-dir`
// ni a aceptar un cwd ausente en silencio.
test('#6859: guardrail — el handler emite --add-dir y valida el cwd en buildSpawn', () => {
    const codigo = fs.readFileSync(path.join(ROOT, '.pipeline/lib/agent-launcher/providers/gemini-google.js'), 'utf8')
        .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.match(codigo, /'--add-dir'/, 'el flag tiene que emitirse desde el handler');
    assert.match(codigo, /assertWorkspaceDir\(cwd, 'cwd'/, 'buildSpawn valida el cwd antes de armar el argv');
    assert.doesNotMatch(codigo, /'--project'|'--new-project'/, 'decisión documentada: no se usa --project/--new-project');
});
