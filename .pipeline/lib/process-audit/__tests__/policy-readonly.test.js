'use strict';

// #6809 CA-6 / SEC-6809-1 / SEC-6809-2 — el auditor es de sólo lectura y
// determinístico: sin LLM, sin red, sin `gh`; el único proceso que lanza es
// `git` por `execFileSync` sin shell; y sus únicas escrituras son su estado
// (`state/process-audit-cron.json`) y el rollup horario. Nunca toca
// `config.yaml`, `agent-models.json` ni `provider-schedule.json`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const MODULE_DIR = path.join(__dirname, '..');
const LECTURA = ['bands.js', 'read-hourly.js', 'read-verdicts.js', 'read-control-age.js', 'axis-process.js',
    'axis-capacity.js', 'axis-providers.js', 'index.js', 'publish.js'];
const ESCRITORES = { 'cron.js': ['mkdirSync', 'writeFileSync', 'renameSync', 'chmodSync'], 'hourly-rollup.js': ['appendFileSync', 'writeFileSync', 'renameSync'] };
const TODAS = /\b(writeFileSync|appendFileSync|appendChained|unlinkSync|renameSync|rmSync|mkdirSync|writeFile|copyFileSync|truncateSync|createWriteStream|openSync|chmodSync)\s*\(/g;
const REQUIRE_RE = /require\(\s*(['"])([^'"]+)\1\s*\)/g;
const PERMITIDOS = new Set(['fs', 'path', 'crypto', 'node:fs', 'node:path', 'node:crypto']);

function sinComentarios(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
}
function codigo(nombre) {
    return sinComentarios(fs.readFileSync(path.join(MODULE_DIR, nombre), 'utf8'));
}

test('el directorio contiene exactamente los módulos declarados en la política', () => {
    const js = fs.readdirSync(MODULE_DIR).filter((f) => f.endsWith('.js')).sort();
    assert.deepEqual(js, [...LECTURA, ...Object.keys(ESCRITORES)].sort());
});

test('los módulos de lectura no tienen primitivas de escritura', () => {
    for (const m of LECTURA) {
        const usadas = [...codigo(m).matchAll(TODAS)].map((x) => x[1]);
        assert.deepEqual(usadas, [], `${m} escribe`);
    }
});

test('los escritores sólo usan sus primitivas declaradas', () => {
    for (const [m, permitidas] of Object.entries(ESCRITORES)) {
        const usadas = [...codigo(m).matchAll(TODAS)].map((x) => x[1]);
        assert.deepEqual(usadas.filter((u) => !permitidas.includes(u)), [], `${m} usa primitivas no permitidas`);
    }
});

test('sin red, sin LLM, sin gh: child_process sólo en read-control-age y sólo execFileSync("git") sin shell', () => {
    for (const m of [...LECTURA, ...Object.keys(ESCRITORES)]) {
        const c = codigo(m);
        assert.ok(!/require\(\s*['"](?:node:)?(?:net|http|https|dgram|tls|dns|worker_threads|vm|cluster)['"]\s*\)/.test(c), `${m} abre red`);
        assert.ok(!/\beval\s*\(|new Function\s*\(/.test(c), `${m} usa eval`);
        assert.ok(!/['"`](?:gh|claude|codex)['"`]/.test(c), `${m} invoca gh/claude/codex`);
        assert.ok(!/\bprocess\.(?:exit|kill)\b/.test(c), `${m} toca process.exit/kill`);
        const usaCp = /require\(\s*['"](?:node:)?child_process['"]\s*\)/.test(c);
        assert.equal(usaCp, m === 'read-control-age.js', `${m}: child_process`);
    }
    const rca = codigo('read-control-age.js');
    assert.ok(!/childProcess\.(?!execFileSync\b)\w+/.test(rca), 'de child_process sólo se usa execFileSync');
    assert.ok(!/\b(?:spawn|spawnSync|execSync|fork)\s*\(/.test(rca), 'sin spawn/execSync/fork');
    assert.match(rca, /exec\('git', \[/);
    assert.match(rca, /shell: false/);
});

test('todo require es fs/path/crypto, child_process (sólo git) o una ruta relativa dentro de lib/', () => {
    const libDir = path.resolve(MODULE_DIR, '..');
    for (const m of [...LECTURA, ...Object.keys(ESCRITORES)]) {
        const c = codigo(m);
        assert.ok(!/require\(\s*[^'")]/.test(c), `${m} tiene un require dinámico`);
        for (const spec of [...c.matchAll(REQUIRE_RE)].map((x) => x[2])) {
            if (PERMITIDOS.has(spec) || spec === 'child_process') continue;
            assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${m}: require "${spec}"`);
            assert.ok(path.resolve(MODULE_DIR, spec).startsWith(libDir + path.sep), `${m}: "${spec}" sale de lib/`);
        }
    }
});

test('runtime: una corrida completa sobre un pipeline de prueba no escribe NADA fuera del estado del cron y sólo lanza git sin shell', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-policy-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const pdir = path.join(root, '.pipeline');
    for (const d of ['logs', 'state', 'desarrollo/validacion/procesado']) fs.mkdirSync(path.join(pdir, d), { recursive: true });
    fs.writeFileSync(path.join(pdir, 'config.yaml'), 'handoff:\n  enabled: false\n');
    fs.writeFileSync(path.join(pdir, 'agent-models.json'), JSON.stringify({ default_provider: 'anthropic', skills: {} }));
    fs.writeFileSync(path.join(pdir, 'provider-schedule.json'), JSON.stringify({ providers: {} }));
    fs.writeFileSync(path.join(pdir, 'desarrollo/validacion/procesado/1.ux'), 'resultado: aprobado\n');
    fs.writeFileSync(path.join(pdir, 'state', 'provider-cost.jsonl'), JSON.stringify({ schema: 2, timestamp: new Date().toISOString(), provider: 'anthropic', skill: 'ux', fase: 'validacion', resultado: 'ganada' }) + '\n');
    fs.writeFileSync(path.join(pdir, 'logs', `rebound-events-${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), skill: 'ux', rechazado_en_fase: 'validacion', evaluadores: ['qa'] }) + '\n');
    const protegidos = ['config.yaml', 'agent-models.json', 'provider-schedule.json'].map((f) => [f, fs.readFileSync(path.join(pdir, f), 'utf8')]);
    const stateFile = path.join(pdir, 'state', 'process-audit-cron.json');

    const escrituras = [];
    const procesos = [];
    const orig = {};
    const espiar = (obj, nombre, fn) => { orig[nombre] = obj[nombre]; obj[nombre] = fn; };
    for (const n of ['writeFileSync', 'appendFileSync', 'renameSync', 'mkdirSync', 'unlinkSync', 'rmSync', 'copyFileSync', 'truncateSync']) {
        const real = fs[n];
        espiar(fs, n, function (...a) { escrituras.push([n, String(a[0])]); return real.apply(fs, a); });
    }
    const openReal = fs.openSync;
    espiar(fs, 'openSync', function (p, flags, ...r) {
        if (flags && flags !== 'r') escrituras.push(['openSync', String(p)]);
        return openReal.call(fs, p, flags, ...r);
    });
    const cpOrig = {};
    for (const n of ['execFileSync', 'execSync', 'spawn', 'spawnSync', 'exec', 'execFile', 'fork']) {
        cpOrig[n] = childProcess[n];
        childProcess[n] = (...a) => {
            procesos.push([n, a[0], a[1], a[2]]);
            if (n === 'execFileSync') return `${Math.floor(Date.now() / 1000) - 30 * 86400}\n`;
            throw new Error(`proceso no permitido: ${n}`);
        };
    }
    let r;
    try {
        const cron = require('../cron');
        cron._resetInFlight();
        r = cron.tickIfDue({
            pipelineDir: pdir,
            cfgRoot: { process_audit: { enabled: true }, handoff: { enabled: false } },
            stateFile,
            publish: () => ({ publicado: false, motivo: 'duplicada' }),
        });
    } finally {
        for (const [n, f] of Object.entries(orig)) fs[n] = f;
        for (const [n, f] of Object.entries(cpOrig)) childProcess[n] = f;
    }
    assert.equal(r.ran, true, JSON.stringify(r));
    const destinos = [...new Set(escrituras.map(([, p]) => path.resolve(p)))];
    for (const d of destinos) {
        assert.ok(d === path.resolve(stateFile) || d.startsWith(path.resolve(stateFile) + '.tmp.') || d === path.dirname(path.resolve(stateFile)),
            `escritura fuera de la allowlist: ${d}`);
    }
    assert.ok(escrituras.length > 0, 'escribió su estado');
    for (const [n, bin, argv, opts] of procesos) {
        assert.equal(n, 'execFileSync');
        assert.equal(bin, 'git');
        assert.equal(argv[0], 'log');
        assert.equal(opts.shell, false);
    }
    assert.equal(procesos.length, 1, 'git sólo para el control apagado de la allowlist');
    for (const [f, antes] of protegidos) assert.equal(fs.readFileSync(path.join(pdir, f), 'utf8'), antes, `${f} intacto`);
});
