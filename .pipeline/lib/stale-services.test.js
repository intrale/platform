'use strict';

// Tests de stale-services.js (#5646) — restart selectivo de servicios que
// quedaron con CÓDIGO VIEJO tras un `git reset --hard`.
// Cubre CA-2, CA-4, CA-5, CA-7, CA-8, CA-9 y CA-10.
// node --test .pipeline/lib/stale-services.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const stale = require('./stale-services');
const runtimeBoot = require('./runtime-boot');

const PIPELINE_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PIPELINE_DIR, '..');

function tmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

// ===========================================================================
// CA-2 — mapeo diff -> componente: estático, conservador y documentado.
// ===========================================================================

test('CA-2: un cambio en .pipeline/lib/** marca a TODOS los componentes', () => {
    const r = stale.componentsForPath('.pipeline/lib/config-schema.js');
    assert.deepStrictEqual(r, stale.ALL_COMPONENTS);
    assert.strictEqual(r.length, 9, 'el registro canónico es de 9 componentes');
});

test('CA-2: un cambio en .pipeline/config.yaml marca a TODOS los componentes', () => {
    assert.deepStrictEqual(stale.componentsForPath('.pipeline/config.yaml'), stale.ALL_COMPONENTS);
});

test('CA-2: un cambio en servicio-drive.js marca SÓLO a svc-drive', () => {
    assert.deepStrictEqual(stale.componentsForPath('.pipeline/servicio-drive.js'), ['svc-drive']);
    assert.deepStrictEqual(stale.componentsForPath('.pipeline/dashboard.js'), ['dashboard']);
    assert.deepStrictEqual(stale.componentsForPath('.pipeline/outbox-drain.js'), ['outbox-drain']);
});

test('CA-2: un diff enteramente fuera de .pipeline/ no marca a nadie', () => {
    const paths = ['app/composeApp/src/Main.kt', 'docs/pipeline/x.md', 'README.md', 'users/build.gradle.kts'];
    const r = stale.mapPathsToComponents(paths);
    assert.deepStrictEqual(r.components, []);
    assert.deepStrictEqual(r.reasons, []);
});

test('CA-2: un archivo nuevo dentro de .pipeline/ que no es de ningún componente no marca a nadie', () => {
    // REQ-SEC-5646-2: un commit que agregue `.pipeline/loquesea.js` no debe poder
    // inducir su ejecución por el solo hecho de aparecer en el diff.
    assert.deepStrictEqual(stale.componentsForPath('.pipeline/loquesea.js'), []);
    assert.deepStrictEqual(stale.componentsForPath('.pipeline/roles/_base.md'), []);
});

test('CA-2/UX G-1: se guarda UN path por componente (el primero que lo motivó), no el diff entero', () => {
    const r = stale.mapPathsToComponents([
        '.pipeline/lib/config-schema.js',
        '.pipeline/lib/waves.js',
        '.pipeline/lib/otro.js',
    ]);
    assert.strictEqual(r.reasons.length, 9);
    for (const reason of r.reasons) {
        assert.strictEqual(reason.path, '.pipeline/lib/config-schema.js');
    }
});

// ===========================================================================
// CA-8 / REQ-SEC-5646-1 — el prevSha nunca llega a los argv de git sin validar.
// ===========================================================================

test('CA-8: prevSha tampereado (--upload-pack=...) NUNCA llega a los argv de git', () => {
    const calls = [];
    const res = stale.computeAffectedComponents({
        prevSha: '--upload-pack=/tmp/evil.sh',
        headSha: 'abc1234',
        repoRoot: '/fake',
        pipelineDir: '/fake',
        exec: (args) => { calls.push(args); return ''; },
    });
    assert.strictEqual(calls.length, 0, 'git no se invocó en absoluto');
    assert.strictEqual(res.unknown, true, 'estado desconocido');
    // Fail-closed conservador: JAMÁS `components: []` ante un SHA que no valida.
    assert.deepStrictEqual(res.components, stale.ALL_COMPONENTS);
});

test('CA-8: prevSha no-hex (mayúsculas, guiones, texto) también se rechaza antes de git', () => {
    for (const malo of ['ABC1234', '-x', 'HEAD~1', 'main', '../../etc/passwd', 'abc123']) {
        const calls = [];
        const res = stale.computeAffectedComponents({
            prevSha: malo, headSha: 'abc1234', repoRoot: '/fake', pipelineDir: '/fake',
            exec: (args) => { calls.push(args); return ''; },
        });
        assert.strictEqual(calls.length, 0, `git invocado con prevSha inválido: ${malo}`);
        assert.strictEqual(res.unknown, true, `prevSha inválido aceptado: ${malo}`);
    }
});

test('CA-8: headSha tampereado tampoco llega a git', () => {
    const calls = [];
    const res = stale.computeAffectedComponents({
        prevSha: 'abc1234', headSha: '--exec=rm -rf /', repoRoot: '/fake', pipelineDir: '/fake',
        exec: (args) => { calls.push(args); return ''; },
    });
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(res.unknown, true);
    assert.deepStrictEqual(res.components, stale.ALL_COMPONENTS);
});

test('CA-8: git se invoca SIEMPRE con array de argumentos y con -z (nunca string de shell)', () => {
    const calls = [];
    const res = stale.computeAffectedComponents({
        prevSha: 'aaaaaaa', headSha: 'bbbbbbb', repoRoot: '/fake', pipelineDir: '/fake',
        exec: (args) => {
            assert.ok(Array.isArray(args), 'args siempre es array, nunca string de shell');
            calls.push(args);
            return '.pipeline/servicio-drive.js\u0000';
        },
    });
    assert.deepStrictEqual(calls[0], ['diff', '--name-only', '-z', 'aaaaaaa', 'bbbbbbb']);
    assert.deepStrictEqual(res.components, ['svc-drive']);
    assert.strictEqual(res.unknown, false);
});

test('CA-8: sin marker ni prevSha -> unknown + TODOS (jamás "no hay afectados")', () => {
    const dir = tmpDir('stale-nomarker-');
    const res = stale.computeAffectedComponents({
        repoRoot: dir, pipelineDir: dir,
        exec: () => { throw new Error('no debería llamarse'); },
    });
    assert.strictEqual(res.unknown, true);
    assert.deepStrictEqual(res.components, stale.ALL_COMPONENTS);
});

test('CA-8: marker corrupto en runtime-boot.json -> unknown + TODOS', () => {
    const dir = tmpDir('stale-markercorrupto-');
    fs.writeFileSync(path.join(dir, 'runtime-boot.json'), '{"sha":"--upload-pack=x"}', 'utf8');
    const calls = [];
    const res = stale.computeAffectedComponents({
        repoRoot: dir, pipelineDir: dir, exec: (a) => { calls.push(a); return ''; },
    });
    assert.strictEqual(calls.length, 0, 'el sha tampereado del marker no llegó a git');
    assert.strictEqual(res.unknown, true);
    assert.deepStrictEqual(res.components, stale.ALL_COMPONENTS);
});

test('el único camino con lista vacía CIERTA es "el reset no movió el HEAD"', () => {
    const res = stale.computeAffectedComponents({
        prevSha: 'abc1234', headSha: 'abc1234', repoRoot: '/fake', pipelineDir: '/fake',
        exec: () => { throw new Error('no debería llamarse'); },
    });
    assert.strictEqual(res.unknown, false);
    assert.deepStrictEqual(res.components, []);
});

test('git diff que falla -> unknown + TODOS (no se asume "sin afectados")', () => {
    const res = stale.computeAffectedComponents({
        prevSha: 'aaaaaaa', headSha: 'bbbbbbb', repoRoot: '/fake', pipelineDir: '/fake',
        exec: () => { throw new Error('fatal: bad object'); },
    });
    assert.strictEqual(res.unknown, true);
    assert.deepStrictEqual(res.components, stale.ALL_COMPONENTS);
});

// ===========================================================================
// CA-7 / REQ-SEC-5646-8 — log injection: los paths salen del commit.
// ===========================================================================

test('CA-7: un path con CR/LF embebido no puede falsificar líneas de log', () => {
    const hostil = '.pipeline/lib/a.js\r\n[2026-08-06 12:00:00] restart selectivo: TODO OK';
    const limpio = stale.sanitizePathForLog(hostil);
    assert.ok(!limpio.includes('\r'), 'sin CR');
    assert.ok(!limpio.includes('\n'), 'sin LF');
    assert.ok(!/\r|\n/.test(limpio));
    // El texto queda, pero en UNA sola línea: no puede simular otra entrada.
    assert.strictEqual(limpio.split('\n').length, 1);
});

test('CA-7: se quitan secuencias ANSI y cualquier control char', () => {
    const ESC = '\u001b';
    const hostil = `.pipeline/${ESC}[31mlib${ESC}[0m/a.js\u0000\u0007\t b`;
    const limpio = stale.sanitizePathForLog(hostil);
    assert.strictEqual(limpio, '.pipeline/lib/a.js b');
    assert.ok(!limpio.includes(ESC));
});

test('CA-7: el path se trunca a longitud fija', () => {
    const largo = '.pipeline/lib/' + 'a'.repeat(500) + '.js';
    const limpio = stale.sanitizePathForLog(largo);
    assert.strictEqual(limpio.length, stale.LOG_PATH_MAX);
    assert.ok(limpio.endsWith('…'), 'marca visible de truncado');
});

test('CA-7: el path sanitizado es el que termina en el registro y en la línea de log', () => {
    const dir = tmpDir('stale-log-');
    const hostil = '.pipeline/lib/x.js\r\nFALSA LINEA';
    const mapped = stale.mapPathsToComponents([hostil]);
    assert.ok(!/\r|\n/.test(mapped.reasons[0].path));
    stale.markAffected(['dashboard'], { sha: 'abc1234', reasons: mapped.reasons }, { pipelineDir: dir });
    const pend = stale.readPending({ pipelineDir: dir });
    assert.ok(!/\r|\n/.test(pend.reasons[0].path), 'lo persistido tampoco tiene control chars');
    const linea = stale.formatRestartLogLine('dashboard', hostil, 'aaaaaaa1', 'bbbbbbb2');
    assert.strictEqual(linea.split('\n').length, 1);
    // UX G-1: causa antes del efecto, nombre del componente como en el panel.
    assert.ok(linea.startsWith('restart selectivo: dashboard reiniciado — cambio en '));
});

// ===========================================================================
// CA-5 — el pendiente persiste y se limpia SÓLO tras spawn confirmado.
// ===========================================================================

test('CA-5: el pendiente NO se limpia si el spawn falló (sigue en disco el ciclo siguiente)', () => {
    const dir = tmpDir('stale-pend-');
    stale.markAffected(['dashboard', 'svc-drive'], {
        sha: 'abc1234',
        reasons: [
            { component: 'dashboard', path: '.pipeline/lib/config-schema.js' },
            { component: 'svc-drive', path: '.pipeline/lib/config-schema.js' },
        ],
    }, { pipelineDir: dir });

    // Simulación del ejecutor: `svc-drive` spawnea OK -> se limpia.
    // `dashboard` FALLA -> NO se llama a clearComponent.
    stale.clearComponent('svc-drive', { pipelineDir: dir });

    const pend = stale.readPending({ pipelineDir: dir });
    assert.deepStrictEqual(pend.components, ['dashboard'],
        'el componente cuyo relanzamiento falló sigue pendiente');
    assert.strictEqual(pend.reasons[0].path, '.pipeline/lib/config-schema.js');
});

test('CA-5: el registro sobrevive entre procesos (persiste en disco, no en memoria)', () => {
    const dir = tmpDir('stale-persist-');
    stale.markAffected(['listener'], { sha: 'abc1234', reasons: [{ component: 'listener', path: '.pipeline/config.yaml' }] }, { pipelineDir: dir });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, stale.STATE_FILENAME), 'utf8'));
    assert.ok(raw.pending.listener, 'quedó escrito en stale-services.json');
    assert.strictEqual(raw.pending.listener.path, '.pipeline/config.yaml');
});

test('CA-5: markAffected es aditivo — no pisa el motivo original de un pendiente vivo', () => {
    const dir = tmpDir('stale-aditivo-');
    stale.markAffected(['pulpo'], { sha: 'aaaaaaa', reasons: [{ component: 'pulpo', path: '.pipeline/pulpo.js' }] }, { pipelineDir: dir });
    const segunda = stale.markAffected(['pulpo'], { sha: 'bbbbbbb', reasons: [{ component: 'pulpo', path: '.pipeline/lib/otro.js' }] }, { pipelineDir: dir });
    assert.deepStrictEqual(segunda.marked, [], 'no se re-marca lo ya pendiente');
    const pend = stale.readPending({ pipelineDir: dir });
    assert.strictEqual(pend.reasons[0].path, '.pipeline/pulpo.js', 'conserva el motivo original');
});

test('CA-5: un nombre fuera del registro canónico no se puede marcar ni limpiar', () => {
    const dir = tmpDir('stale-allow-');
    const r = stale.markAffected(['claude.exe', '../../evil', 'pulpo'], { sha: 'abc1234', reasons: [] }, { pipelineDir: dir });
    assert.deepStrictEqual(r.marked, ['pulpo']);
    assert.deepStrictEqual(stale.readPending({ pipelineDir: dir }).components, ['pulpo']);
    const c = stale.clearComponent('../../evil', { pipelineDir: dir });
    assert.strictEqual(c.ok, false);
});

test('CA-5: un stale-services.json tampereado con nombres desconocidos se ignora al leer', () => {
    const dir = tmpDir('stale-tamper-');
    fs.writeFileSync(path.join(dir, stale.STATE_FILENAME), JSON.stringify({
        version: 1,
        pending: { 'pulpo': { sha: 'abc1234', path: 'x' }, 'rm -rf': { sha: 'abc1234', path: 'y' } },
    }), 'utf8');
    assert.deepStrictEqual(stale.readPending({ pipelineDir: dir }).components, ['pulpo']);
});

test('CA-3: clearComponents limpia SÓLO la lista relanzada — outbox-drain sigue pendiente', () => {
    // P-1 de guru / corrección vinculante de PO: `launchAll()` de restart.js
    // itera sus 8 COMPONENTS, que NO incluyen `outbox-drain`. Limpiar el
    // registro entero lo dejaría stale en silencio y para siempre.
    const dir = tmpDir('stale-outbox-');
    stale.markAffected(stale.ALL_COMPONENTS, { sha: 'abc1234', reasons: [] }, { pipelineDir: dir });
    const relanzadosPorRestartJs = [
        'pulpo', 'listener', 'svc-telegram', 'svc-github', 'svc-drive',
        'svc-emulador', 'svc-reconciler', 'dashboard',
    ];
    stale.clearComponents(relanzadosPorRestartJs, { pipelineDir: dir });
    assert.deepStrictEqual(stale.readPending({ pipelineDir: dir }).components, ['outbox-drain'],
        'outbox-drain queda pendiente para el watchdog');
});

// ===========================================================================
// CA-4 — el registro de componentes está completo y no se desincroniza.
// ===========================================================================

function parseScriptMapDelWatchdog() {
    const src = fs.readFileSync(path.join(PIPELINE_DIR, 'watchdog.ps1'), 'utf8');
    const m = src.match(/\$ScriptMap\s*=\s*@\{([\s\S]*?)\n\}/);
    assert.ok(m, 'se encontró el bloque $ScriptMap en watchdog.ps1');
    const map = {};
    for (const linea of m[1].split('\n')) {
        const e = linea.match(/'([^']+)'\s*=\s*'([^']+)'/);
        if (e) map[e[1]] = e[2];
    }
    return map;
}

function parseComponentsDeNode(file) {
    const src = fs.readFileSync(path.join(PIPELINE_DIR, file), 'utf8');
    const m = src.match(/const COMPONENTS = \[([\s\S]*?)\n\];/);
    assert.ok(m, `se encontró el bloque COMPONENTS en ${file}`);
    return [...m[1].matchAll(/name:\s*'([^']+)'/g)].map(x => x[1]);
}

test('CA-4: $ScriptMap de watchdog.ps1 cubre TODO el registro canónico (9 componentes)', () => {
    const map = parseScriptMapDelWatchdog();
    const nombres = Object.keys(map).sort();
    assert.deepStrictEqual(nombres, stale.ALL_COMPONENTS.slice().sort(),
        'si esto falla, un componente marcado stale no tendría ejecutor (fail-open silencioso)');
    for (const c of stale.COMPONENT_REGISTRY) {
        assert.strictEqual(map[c.name], c.script, `script de ${c.name} desincronizado`);
    }
});

test('CA-4: el registro canónico es exactamente la unión de restart.js y dashboard.js', () => {
    const deRestart = parseComponentsDeNode('restart.js');
    const deDashboard = parseComponentsDeNode('dashboard.js');
    const union = [...new Set([...deRestart, ...deDashboard])].sort();
    assert.deepStrictEqual(union, stale.ALL_COMPONENTS.slice().sort());
    // Precondición del issue: ninguna lista contiene a la otra.
    assert.ok(!deRestart.includes('outbox-drain'), 'restart.js no lanza outbox-drain');
    assert.ok(!deDashboard.includes('dashboard'), 'el dashboard no puede matarse a sí mismo');
});

test('CA-4: todos los scripts del registro existen en disco', () => {
    for (const c of stale.COMPONENT_REGISTRY) {
        assert.ok(fs.existsSync(path.join(PIPELINE_DIR, c.script)), `falta ${c.script}`);
    }
});

// ===========================================================================
// CA-8 / REQ-SEC-5646-3 — contrato del CLI (frontera Node -> PowerShell).
// ===========================================================================

function runCli(args, dir) {
    const r = require('node:child_process').spawnSync(
        process.execPath,
        [path.join(PIPELINE_DIR, 'lib', 'stale-services.js'), ...args],
        { encoding: 'utf8', windowsHide: true, env: { ...process.env, STALE_SERVICES_DIR: dir } }
    );
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('CA-8: CLI --json devuelve JSON parseable con exit 0', () => {
    const dir = tmpDir('stale-cli-');
    stale.markAffected(['dashboard'], { sha: 'abc1234', reasons: [{ component: 'dashboard', path: '.pipeline/lib/x.js' }] }, { pipelineDir: dir });
    const r = runCli(['--json'], dir);
    assert.strictEqual(r.status, 0);
    const parsed = JSON.parse(r.stdout); // no debe lanzar
    assert.deepStrictEqual(parsed.components, ['dashboard']);
    assert.strictEqual(parsed.reasons[0].path, '.pipeline/lib/x.js');
});

test('CA-8: CLI --clear baja el pendiente y devuelve JSON con exit 0', () => {
    const dir = tmpDir('stale-cliclear-');
    stale.markAffected(['dashboard', 'pulpo'], { sha: 'abc1234', reasons: [] }, { pipelineDir: dir });
    const r = runCli(['--clear', 'dashboard'], dir);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(JSON.parse(r.stdout).cleared, true);
    assert.deepStrictEqual(stale.readPending({ pipelineDir: dir }).components, ['pulpo']);
});

test('CA-8: CLI con argumento no reconocido -> stdout VACÍO y exit != 0 (nunca stack trace mezclado)', () => {
    const dir = tmpDir('stale-clibad-');
    for (const args of [['--loquesea'], ['--clear'], ['--prev'], ['; rm -rf /']]) {
        const r = runCli(args, dir);
        assert.notStrictEqual(r.status, 0, `debía fallar: ${args.join(' ')}`);
        assert.strictEqual(r.stdout, '', `stdout debe quedar vacío: ${args.join(' ')}`);
    }
});

test('CA-8: CLI --json sobre un registro inexistente devuelve lista vacía, no crashea', () => {
    const dir = tmpDir('stale-clivacio-');
    const r = runCli(['--json'], dir);
    assert.strictEqual(r.status, 0);
    assert.deepStrictEqual(JSON.parse(r.stdout).components, []);
});

// ===========================================================================
// CA-1/CA-2 — escenario integrado sobre un repo git hermético.
// ===========================================================================

function repoHermetico() {
    const dir = tmpDir('stale-repo-');
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'user.email', 'test@intrale.com'], dir);
    git(['config', 'user.name', 'Test'], dir);
    git(['config', 'commit.gpgsign', 'false'], dir);
    fs.mkdirSync(path.join(dir, '.pipeline', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pipeline', 'lib', 'config-schema.js'), 'v1\n');
    fs.writeFileSync(path.join(dir, '.pipeline', 'config.yaml'), 'a: 1\n');
    fs.writeFileSync(path.join(dir, '.pipeline', 'servicio-drive.js'), 'v1\n');
    fs.writeFileSync(path.join(dir, 'README.md'), 'v1\n');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'base'], dir);
    return { dir, shaA: git(['rev-parse', 'HEAD'], dir) };
}

test('CA-1: escenario del incidente — merge que agrega una sección de config marca a TODOS', () => {
    const { dir, shaA } = repoHermetico();
    // Commit B: sección nueva en config.yaml + su declaración en config-schema.js
    // (exactamente el patrón de `telegram_voice_outbound` y `human_block_reminder`).
    fs.writeFileSync(path.join(dir, '.pipeline', 'config.yaml'), 'a: 1\nhuman_block_reminder:\n  enabled: true\n');
    fs.writeFileSync(path.join(dir, '.pipeline', 'lib', 'config-schema.js'), 'v2 human_block_reminder\n');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'feat: seccion nueva'], dir);
    const shaB = git(['rev-parse', 'HEAD'], dir);

    const res = stale.computeAffectedComponents({ prevSha: shaA, headSha: shaB, repoRoot: dir, pipelineDir: dir });
    assert.strictEqual(res.unknown, false);
    assert.deepStrictEqual(res.components, stale.ALL_COMPONENTS,
        'el dashboard vivo con schema viejo queda marcado -> el watchdog lo relanza');
    assert.ok(res.reasons.every(r => r.path.startsWith('.pipeline/')));

    // El ciclo completo: marcar -> leer pendientes -> el ejecutor los toma.
    stale.markAffected(res.components, { sha: res.headSha, reasons: res.reasons }, { pipelineDir: dir });
    assert.deepStrictEqual(stale.readPending({ pipelineDir: dir }).components, stale.ALL_COMPONENTS);
});

test('CA-2: escenario integrado — reset sin cambios relevantes NO marca a nadie (cero restarts)', () => {
    const { dir, shaA } = repoHermetico();
    fs.writeFileSync(path.join(dir, 'README.md'), 'v2\n');
    fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app', 'Main.kt'), 'fun main() {}\n');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'docs: nada del pipeline'], dir);
    const shaB = git(['rev-parse', 'HEAD'], dir);

    const res = stale.computeAffectedComponents({ prevSha: shaA, headSha: shaB, repoRoot: dir, pipelineDir: dir });
    assert.strictEqual(res.unknown, false);
    assert.deepStrictEqual(res.components, [], 'cero restarts');
    const mark = stale.markAffected(res.components, { sha: res.headSha, reasons: res.reasons }, { pipelineDir: dir });
    assert.deepStrictEqual(mark.marked, []);
    assert.deepStrictEqual(stale.readPending({ pipelineDir: dir }).components, []);
});

test('CA-2: escenario integrado — cambio de un solo servicio marca sólo a ese servicio', () => {
    const { dir, shaA } = repoHermetico();
    fs.writeFileSync(path.join(dir, '.pipeline', 'servicio-drive.js'), 'v2\n');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'fix: drive'], dir);
    const shaB = git(['rev-parse', 'HEAD'], dir);
    const res = stale.computeAffectedComponents({ prevSha: shaA, headSha: shaB, repoRoot: dir, pipelineDir: dir });
    assert.deepStrictEqual(res.components, ['svc-drive']);
    assert.deepStrictEqual(res.reasons, [{ component: 'svc-drive', path: '.pipeline/servicio-drive.js' }]);
});

test('CA-8: el boot marker real del pipeline se lee vía runtime-boot (no se parsea a mano)', () => {
    // Guard de regresión sobre REQ-SEC-5646-1: el módulo no debe leer
    // runtime-boot.json por su cuenta.
    const src = fs.readFileSync(path.join(PIPELINE_DIR, 'lib', 'stale-services.js'), 'utf8');
    assert.ok(src.includes("require('./runtime-boot')"), 'usa el módulo canónico');
    assert.ok(!/readFileSync\([^)]*runtime-boot\.json/.test(src), 'no parsea el marker a mano');
    assert.ok(!src.includes('execSync('), 'no usa execSync con string de shell');
    assert.strictEqual(typeof runtimeBoot.SHA_RE.test, 'function');
});

// ===========================================================================
// CA-9 — el endpoint HTTP no amplía su blast radius.
// ===========================================================================

function bloqueEndpointRestartOperativo() {
    const src = fs.readFileSync(path.join(PIPELINE_DIR, 'dashboard.js'), 'utf8');
    const ini = src.indexOf("req.url === '/api/ops/restart-operativo'");
    assert.ok(ini > 0, 'se encontró el endpoint restart-operativo');
    const fin = src.indexOf("req.url === '/api/gate-signature/csrf-token'", ini);
    assert.ok(fin > ini, 'se delimitó el bloque del endpoint');
    return src.slice(ini, fin);
}

test('CA-3: el endpoint lee readBootMarker ANTES de syncOperativoTree (que pisa el marker)', () => {
    const bloque = bloqueEndpointRestartOperativo();
    // Se comparan los CALL SITES reales, no las menciones en comentarios.
    const iMarker = bloque.indexOf('_runtimeBoot.readBootMarker(');
    const iSync = bloque.indexOf('_operativoSync.syncOperativoTree(');
    assert.ok(iMarker > 0, 'el endpoint lee el boot marker');
    assert.ok(iSync > 0, 'el endpoint sincroniza el tree');
    assert.ok(iMarker < iSync,
        'si el marker se lee después del sync ya no hay prevSha recuperable (operativo-sync lo pisa)');
});

test('CA-9: el conjunto se computa server-side — el body sólo aporta `actor`', () => {
    const bloque = bloqueEndpointRestartOperativo();
    assert.ok(bloque.includes('computeAffectedComponents'), 'el conjunto sale del diff, no del request');
    const usosDelBody = [...bloque.matchAll(/parsed\.(\w+)/g)].map(m => m[1]);
    assert.deepStrictEqual([...new Set(usosDelBody)], ['actor'],
        'del body del request no se lee nada más que `actor`');
});

test('CA-9: el endpoint conserva gate + CSRF + rate-limit + audit y suma la cota agregada', () => {
    const bloque = bloqueEndpointRestartOperativo();
    for (const control of ['checkGate', 'requireCSRF', '_opsRestartRateLimiter', 'appendOpsRestartAudit']) {
        assert.ok(bloque.includes(control), `se perdió el control ${control}`);
    }
    assert.ok(bloque.includes('_opsRestartAggregateLimiter.grant'),
        'cota agregada por ventana (el rate-limiter por target no alcanza con N targets)');
});

test('CA-3: el propio dashboard no está en la allowlist ejecutable del endpoint', () => {
    // No puede matarse a sí mismo: queda pendiente en disco y lo relanza el
    // watchdog, único ejecutor externo (REQ-SEC-5646-5).
    const deDashboard = parseComponentsDeNode('dashboard.js');
    assert.ok(!deDashboard.includes('dashboard'));
    const map = parseScriptMapDelWatchdog();
    assert.strictEqual(map['dashboard'], 'dashboard.js', 'pero el watchdog SÍ puede relanzarlo');
});

// ===========================================================================
// CA-6 — el watchdog es el único ejecutor y no puede entrar en crash-loop.
// ===========================================================================

function fuenteWatchdog() {
    return fs.readFileSync(path.join(PIPELINE_DIR, 'watchdog.ps1'), 'utf8');
}

test('CA-6: el watchdog tiene guard de ventana propio para el restart selectivo', () => {
    const src = fuenteWatchdog();
    assert.ok(src.includes('$StaleGuardFile'), 'existe el guard de ronda');
    assert.ok(/\$StaleGuardWindowSeconds\s*=\s*90/.test(src), 'ventana de 90s, molde de last-restart.json');
    assert.ok(/\$StaleMaxPerRound\s*=\s*\d+/.test(src), 'cota de componentes por ronda');
    assert.ok(src.includes('last-restart.json'), 'sigue respetando el stand-by de restart.js');
});

test('CA-6: el watchdog hace double-check pre-spawn antes de relanzar un stale', () => {
    const src = fuenteWatchdog();
    const ini = src.indexOf('function Invoke-StaleRestarts');
    assert.ok(ini > 0);
    const bloque = src.slice(ini);
    assert.ok(bloque.includes('Get-FreshServicePid'), 'el PID sale de un scan fresco del SO, no de un archivo');
    assert.ok(bloque.includes('no se spawnea otra'), 'no spawnea si sigue habiendo una instancia viva');
    assert.ok(bloque.includes('no esta corriendo'),
        'un componente apagado no se "reinicia": no tiene codigo viejo en memoria y este bloque no lo levanta');
});

test('CA-8: la frontera Node -> PowerShell usa ConvertFrom-Json y allowlist, nunca Invoke-Expression', () => {
    const src = fuenteWatchdog();
    assert.ok(src.includes('ConvertFrom-Json'));
    // Sólo código ejecutable: los comentarios pueden nombrar lo prohibido.
    const codigo = src.split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n');
    assert.ok(!/Invoke-Expression|\biex\b/.test(codigo), 'prohibido Invoke-Expression');
    assert.ok(src.includes('$ScriptMap.ContainsKey($name)'), 'valida el nombre contra la allowlist estática');
    assert.ok(/Start-Process -FilePath 'node' -ArgumentList @\(\$scriptPath\)/.test(src),
        'spawn con array de argumentos');
});

test('CA-3: los DOS resets del watchdog capturan el HEAD previo y marcan', () => {
    const src = fuenteWatchdog();
    const resets = [...src.matchAll(/reset --hard FETCH_HEAD/g)];
    assert.strictEqual(resets.length, 2, 'siguen siendo los dos emisores conocidos');
    for (const m of resets) {
        const contexto = src.slice(Math.max(0, m.index - 600), m.index + 400);
        assert.ok(/Get-RepoHead/.test(contexto), 'captura el HEAD previo al reset');
        assert.ok(/Invoke-StaleMark/.test(contexto), 'marca los afectados tras el reset');
    }
});

test('CA-5: el watchdog limpia el pendiente SÓLO después del spawn confirmado', () => {
    const src = fuenteWatchdog();
    const ini = src.indexOf('function Invoke-StaleRestarts');
    const bloque = src.slice(ini);
    const iSpawn = bloque.indexOf("Start-Process -FilePath 'node'");
    const iClear = bloque.lastIndexOf('Invoke-StaleClear $name');
    assert.ok(iSpawn > 0 && iClear > iSpawn, 'el clear del camino de relanzamiento va DESPUÉS del spawn');
    // Y no hay ningún clear entre el Stop-Process y el spawn: si el proceso se
    // mató pero el spawn falló, el componente tiene que seguir pendiente.
    const entre = bloque.slice(bloque.indexOf('Stop-Process'), iSpawn);
    assert.ok(!entre.includes('Invoke-StaleClear'), 'no se limpia entre el kill y el spawn');
    assert.ok(bloque.includes('sigue pendiente'), 'los caminos de falla dejan el componente pendiente');
});

// ===========================================================================
// CA-3 — restart.js no cambia su contrato y limpia sólo lo que relanzó.
// ===========================================================================

test('CA-3: restart.js conserva el contrato killAll -> syncWithMain -> reexec -> launchAll', () => {
    const src = fs.readFileSync(path.join(PIPELINE_DIR, 'restart.js'), 'utf8');
    const m = /killAll\(\);\r?\n\s*if \(!flagNoSync\) syncWithMain\(\);/.exec(src);
    assert.ok(m, 'killAll seguido de syncWithMain intacto');
    const iKill = m.index;
    assert.ok(src.indexOf('reexecIfSelfChanged();', iKill) > iKill);
    // #6441 — el paso de arranque pasó de `limpiarPendientesRelanzados(launchAll())`
    // a `launchAllVerificado()`, que lanza, VERIFICA servicio por servicio,
    // reintenta y recién ahí limpia. El contrato que este test protege (que el
    // arranque venga después de killAll/sync/reexec) no cambió.
    assert.ok(src.indexOf('launchAllVerificado();', iKill) > iKill);
});

test('CA-3: restart.js deriva la limpieza de lo efectivamente lanzado, no de una constante', () => {
    const src = fs.readFileSync(path.join(PIPELINE_DIR, 'restart.js'), 'utf8');
    // #6441 — la garantía se REFORZÓ: antes se bajaban del registro los
    // SPAWNEADOS; ahora sólo los verificados VIVOS. Bajar un servicio que no
    // arrancó lo dejaba con código viejo para siempre y en silencio.
    assert.ok(src.includes('limpiarPendientesRelanzados(res.vivos)'),
        'la lista sale de la verificación post-arranque, no de launchAll()');
    assert.ok(!src.includes('limpiarPendientesRelanzados(launchAll())'),
        'launchAll() devuelve los spawneados: usarlos sería el fail-open que #6441 cierra');
    assert.ok(!/clearComponents\(\s*COMPONENTS/.test(src), 'nunca se limpia el registro entero');
    assert.ok(/return lanzados;/.test(src), 'launchAll devuelve lo que realmente lanzó');
});

test('CA-6/REQ-SEC-5646-6: no se relaja la validación de config en ningún archivo tocado', () => {
    // Fuera de alcance explícito: ignorar claves desconocidas, degradar el
    // fail-closed o hot-reloadear el require-cache del schema.
    const src = fs.readFileSync(path.join(PIPELINE_DIR, 'lib', 'stale-services.js'), 'utf8');
    assert.ok(!/require\(['"][^'"]*config-schema/.test(src), 'el fix no importa el validador de config');
    assert.ok(!/delete require\.cache/.test(src), 'no invalida el require-cache de nadie');
    const wd = fuenteWatchdog();
    assert.ok(!/delete require\.cache/.test(wd));
});
