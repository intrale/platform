// #6812 — Suprimir las ventanas de consola de los hijos en Windows.
// Cubre el parche de child_process, su idempotencia, la propagación por
// NODE_OPTIONS y el guardrail de regresión sobre launch.ps1 / entrypoints.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const mod = require('../force-windows-hide');

const PIPELINE_DIR = path.resolve(__dirname, '..', '..');

function fakeCp() {
    const calls = [];
    const mk = (name) => function (...args) { calls.push({ name, args }); return 'ok'; };
    return {
        calls,
        spawn: mk('spawn'),
        spawnSync: mk('spawnSync'),
        exec: mk('exec'),
        execSync: mk('execSync'),
        execFile: mk('execFile'),
        execFileSync: mk('execFileSync'),
        fork: mk('fork'),
    };
}

test('inyecta windowsHide cuando no hay objeto de opciones', () => {
    const cp = fakeCp();
    const env = {};
    mod.apply({ _cp: cp, _platform: 'win32', _env: env, propagate: false });
    cp.execSync('git status');
    cp.spawn('gh', ['issue', 'view', '1']);
    assert.deepStrictEqual(cp.calls[0].args[1], { windowsHide: true });
    assert.deepStrictEqual(cp.calls[1].args[2], { windowsHide: true });
});

test('preserva las opciones existentes y agrega windowsHide', () => {
    const cp = fakeCp();
    mod.apply({ _cp: cp, _platform: 'win32', _env: {}, propagate: false });
    cp.execSync('git status', { cwd: 'C:/repo', timeout: 5000 });
    assert.deepStrictEqual(cp.calls[0].args[1], { cwd: 'C:/repo', timeout: 5000, windowsHide: true });
});

test('respeta un windowsHide:false explícito', () => {
    const cp = fakeCp();
    mod.apply({ _cp: cp, _platform: 'win32', _env: {}, propagate: false });
    cp.execSync('git status', { windowsHide: false });
    assert.strictEqual(cp.calls[0].args[1].windowsHide, false);
});

test('inserta las opciones antes del callback sin romperlo', () => {
    const cp = fakeCp();
    mod.apply({ _cp: cp, _platform: 'win32', _env: {}, propagate: false });
    const cb = () => {};
    cp.execFile('gh', ['issue', 'list'], cb);
    const args = cp.calls[0].args;
    assert.deepStrictEqual(args[2], { windowsHide: true });
    assert.strictEqual(args[3], cb);
});

test('es idempotente: no envuelve dos veces', () => {
    const cp = fakeCp();
    assert.strictEqual(mod.apply({ _cp: cp, _platform: 'win32', _env: {}, propagate: false }), true);
    const first = cp.execSync;
    assert.strictEqual(mod.apply({ _cp: cp, _platform: 'win32', _env: {}, propagate: false }), true);
    assert.strictEqual(cp.execSync, first);
});

test('no hace nada fuera de Windows ni con el opt-out', () => {
    const cp = fakeCp();
    const original = cp.execSync;
    assert.strictEqual(mod.apply({ _cp: cp, _platform: 'linux', _env: {} }), false);
    assert.strictEqual(cp.execSync, original);
    assert.strictEqual(mod.apply({ _cp: cp, _platform: 'win32', _env: { PIPELINE_NO_HIDE_PATCH: '1' } }), false);
    assert.strictEqual(cp.execSync, original);
});

test('propaga el parche a los hijos Node por NODE_OPTIONS, sin duplicar', () => {
    const env = { NODE_OPTIONS: '--max-old-space-size=4096' };
    mod.apply({ _cp: fakeCp(), _platform: 'win32', _env: env });
    assert.match(env.NODE_OPTIONS, /--max-old-space-size=4096/);
    assert.match(env.NODE_OPTIONS, /--require .*force-windows-hide/);
    const once = env.NODE_OPTIONS;
    mod.apply({ _cp: fakeCp(), _platform: 'win32', _env: env });
    assert.strictEqual(env.NODE_OPTIONS, once);
});

test('los entrypoints de servicio cargan el parche antes de todo', () => {
    const entrypoints = [
        'pulpo.js', 'dashboard.js', 'listener-telegram.js', 'servicio-telegram.js',
        'servicio-github.js', 'servicio-drive.js', 'servicio-reconciler.js',
        'restart.js', 'ghostbusters.js',
    ];
    for (const ep of entrypoints) {
        const src = fs.readFileSync(path.join(PIPELINE_DIR, ep), 'utf8');
        const hide = src.indexOf("require('./lib/force-windows-hide')");
        assert.ok(hide !== -1, `${ep} no carga force-windows-hide`);
        const firstRequire = src.search(/^\s*(?:const|let|var)\s.*require\(/m);
        if (firstRequire !== -1) {
            assert.ok(hide < firstRequire, `${ep} carga el parche después de otro require`);
        }
    }
});

test('launch.ps1 no reintroduce ventanas visibles', () => {
    const src = fs.readFileSync(path.join(PIPELINE_DIR, 'launch.ps1'), 'utf8');
    assert.ok(!/Start-PipelineService\s+'[^']+'\s+'(?!Hidden')/.test(src),
        'hay servicios lanzados con un WindowStyle distinto de Hidden');
    for (const m of src.matchAll(/-Argument\s+"([^"]*watchdog[^"]*)"/g)) {
        assert.match(m[1], /-WindowStyle Hidden/,
            `el Action de la tarea programada perdió -WindowStyle Hidden: ${m[1]}`);
    }
});

test('un proceso Node hijo nace ya parcheado (herencia real por NODE_OPTIONS)', { skip: process.platform !== 'win32' }, () => {
    const { execSync } = require('node:child_process');
    const selfPath = path.resolve(__dirname, '..', 'force-windows-hide.js').split(path.sep).join('/');
    const env = Object.assign({}, process.env);
    delete env.NODE_OPTIONS;
    // El nieto no requiere el módulo: si está parcheado, es porque lo heredó.
    const inner = `node -p ${JSON.stringify(`!!require('child_process').${mod.FLAG}`)}`;
    const parent = `require(${JSON.stringify(selfPath)});`
        + `const cp=require('child_process');`
        + `process.stdout.write(cp.execSync(${JSON.stringify(inner)},{encoding:'utf8'}).trim());`;
    const out = execSync(`node -e ${JSON.stringify(parent)}`, { encoding: 'utf8', env, windowsHide: true }).trim();
    assert.strictEqual(out, 'true');
});
