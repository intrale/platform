'use strict';

// Reproducción del episodio del 2026-08-18 (#6441, CA-7) contra el runner REAL.
//
// Cada ciclo se ejecuta como un PROCESO SEPARADO, igual que en producción
// (Task Scheduler, cada 2 min). Eso es lo que hace válida la prueba: si el
// estado previo viviera en memoria — como vivía hasta este issue — el flanco
// alive→dead no se detectaría en ninguna de las corridas, que es exactamente lo
// que pasó durante los seis días de silencio.
//
// Lo único que se sustituye es la frontera con el SO (`pid-discovery`): el resto
// del runner corre de verdad — carga de config, escritura del store, dedup
// persistente, notificación y línea ACTION.
//
// node --test .pipeline/lib/service-liveness-run-6441.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PIPELINE_DIR = path.resolve(__dirname, '..');
const RUNNER = path.join(PIPELINE_DIR, 'service-liveness-run.js');

// Stub de la frontera con el SO. Se precarga con `--require` para que ya esté
// en require.cache cuando el runner haga su require.
const STUB = `
const path = require('path');
const real = path.join(${JSON.stringify(PIPELINE_DIR)}, 'pid-discovery.js');
const vivos = JSON.parse(process.env.FAKE_PROCS || '[]');
require.cache[real] = {
    id: real, filename: real, loaded: true, children: [], paths: [],
    exports: {
        scanNodeProcesses: () => vivos,
        findPidByScriptIn: (list, script) => (list || []).find(p => p.commandLine.includes(script)) || null,
        processForPid: (pid) => vivos.find(p => p.pid === pid) || null,
    },
};
`;

function nuevoEntorno() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slv-'));
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    const stub = path.join(dir, 'stub.js');
    fs.writeFileSync(stub, STUB);
    return { dir, stub };
}

// Arma la lista de procesos node "vivos" a partir de los servicios pedidos.
function procs(nombres) {
    const script = {
        'pulpo': 'pulpo.js',
        'listener': 'listener-telegram.js',
        'svc-telegram': 'servicio-telegram.js',
        'svc-github': 'servicio-github.js',
        'svc-drive': 'servicio-drive.js',
        'svc-emulador': 'servicio-emulador.js',
        'svc-reconciler': 'servicio-reconciler.js',
        'outbox-drain': 'outbox-drain.js',
        'dashboard': 'dashboard.js',
    };
    return nombres.map((n, i) => ({
        pid: 1000 + i,
        name: 'node.exe',
        commandLine: 'node C:\\pipeline\\' + script[n],
    }));
}

// Un ciclo de watchdog = una ejecución del runner en un proceso nuevo.
function correrCiclo(env, vivos) {
    const r = spawnSync(process.execPath, ['--require', env.stub, RUNNER], {
        encoding: 'utf8',
        timeout: 30000,
        env: {
            ...process.env,
            FAKE_PROCS: JSON.stringify(procs(vivos)),
            SLV_PIPELINE_DIR: env.dir,
            SLV_LOG_DIR: path.join(env.dir, 'logs'),
            SLV_STATE_FILE: path.join(env.dir, 'logs', 'service-liveness-state.json'),
            // Los avisos se encolan en el temp, NUNCA en la outbox real.
            PIPELINE_DIR_OVERRIDE: env.dir,
        },
    });
    return {
        action: ((r.stdout || '').match(/ACTION:(.+)/) || [])[1] || '',
        stdout: r.stdout || '',
        stderr: r.stderr || '',
        status: r.status,
    };
}

function transiciones(env) {
    const file = path.join(env.dir, 'process-transitions.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
}

function avisos(env) {
    const dir = path.join(env.dir, 'servicios', 'telegram', 'pendiente');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

const TODOS = ['pulpo', 'listener', 'svc-telegram', 'svc-github', 'svc-drive', 'svc-emulador', 'svc-reconciler', 'outbox-drain', 'dashboard'];
const SIN_RECONCILER = TODOS.filter(n => n !== 'svc-reconciler');

// ===========================================================================
// CA-7 — reproducción del episodio.
// ===========================================================================

test('CA-7: el reconciliador muere y en un ciclo queda la transición Y el aviso', () => {
    const env = nuevoEntorno();

    // Ciclo 1: todo sano. Siembra la línea base en disco.
    const c1 = correrCiclo(env, TODOS);
    assert.strictEqual(c1.action.trim(), 'ok', 'stdout: ' + c1.stdout + ' stderr: ' + c1.stderr);
    assert.strictEqual(avisos(env).length, 0, 'CA-6: con todo sano, cero avisos');

    // Ciclo 2: muere el reconciliador. PROCESO NUEVO, sin memoria del ciclo 1.
    const c2 = correrCiclo(env, SIN_RECONCILER);
    assert.strictEqual(c2.action.trim(), 'down:svc-reconciler');

    const flanco = transiciones(env).find(t => t.service === 'svc-reconciler' && t.to === 'dead');
    assert.ok(flanco, 'quedó la línea alive->dead que el store nunca tuvo');
    assert.strictEqual(flanco.from, 'alive');

    const msgs = avisos(env);
    assert.strictEqual(msgs.length, 1, 'un aviso, uno solo');
    const texto = JSON.stringify(msgs[0]);
    assert.ok(texto.includes('svc-reconciler'), 'el aviso nombra el servicio');
    assert.ok(/tablero|sincroniza/i.test(texto), 'y dice qué deja de funcionar');
});

test('CA-7 (variante): el flanco se detecta aunque el proceso que barre reinicie', () => {
    // Es el mismo escenario "reiniciando el dashboard en el medio": cada ciclo
    // ya es un proceso distinto. Con el estado previo en memoria, el ciclo 2
    // sembraría de nuevo y NO detectaría nada.
    const env = nuevoEntorno();
    correrCiclo(env, TODOS);
    correrCiclo(env, TODOS);   // ciclos extra: ninguno debe re-sembrar
    correrCiclo(env, TODOS);

    const siembras = transiciones(env).filter(t => t.reason === 'seed' && t.service === 'svc-reconciler');
    assert.strictEqual(siembras.length, 1, 'se siembra UNA vez, no en cada corrida');

    correrCiclo(env, SIN_RECONCILER);
    assert.ok(transiciones(env).some(t => t.service === 'svc-reconciler' && t.from === 'alive' && t.to === 'dead'));
});

// ===========================================================================
// CA-5 — dedup persistente entre procesos.
// ===========================================================================

test('CA-5: el servicio caído no dispara avisos en loop ciclo tras ciclo', () => {
    const env = nuevoEntorno();
    correrCiclo(env, TODOS);
    correrCiclo(env, SIN_RECONCILER);
    assert.strictEqual(avisos(env).length, 1);

    // Cinco ciclos más (10 min de watchdog): ni un aviso extra.
    for (let i = 0; i < 5; i++) correrCiclo(env, SIN_RECONCILER);
    assert.strictEqual(avisos(env).length, 1, 'el dedup sobrevive entre procesos');

    // Pero la transición NO se duplica tampoco.
    const muertes = transiciones(env).filter(t => t.service === 'svc-reconciler' && t.to === 'dead');
    assert.strictEqual(muertes.length, 1, 'una muerte, una línea');

    assert.ok(fs.existsSync(path.join(env.dir, 'logs', 'service-liveness-state.json')),
        'el dedup se persiste en disco (en memoria no serviría: el runner es efímero)');
});

test('CA-5: si el estado de dedup se borra, se vuelve a avisar (no queda mudo)', () => {
    const env = nuevoEntorno();
    correrCiclo(env, TODOS);
    correrCiclo(env, SIN_RECONCILER);
    assert.strictEqual(avisos(env).length, 1);

    fs.unlinkSync(path.join(env.dir, 'logs', 'service-liveness-state.json'));
    correrCiclo(env, SIN_RECONCILER);
    assert.strictEqual(avisos(env).length, 2, 'sin estado se alerta igual: fail hacia la visibilidad');
});

// ===========================================================================
// CA-6 — cero ruido en el camino feliz.
// ===========================================================================

test('CA-6: diez ciclos con todo sano no producen un solo aviso', () => {
    const env = nuevoEntorno();
    for (let i = 0; i < 10; i++) {
        const c = correrCiclo(env, TODOS);
        assert.strictEqual(c.action.trim(), 'ok');
    }
    assert.strictEqual(avisos(env).length, 0);
});

test('los no supervisados muertos se registran pero no avisan', () => {
    const env = nuevoEntorno();
    correrCiclo(env, TODOS);
    const c = correrCiclo(env, TODOS.filter(n => n !== 'outbox-drain' && n !== 'svc-emulador'));

    assert.strictEqual(c.action.trim(), 'ok', 'no cuentan como caídos supervisados');
    assert.strictEqual(avisos(env).length, 0, 'outbox-drain se auto-mata: alertarlo sería ruido diario');
    const t = transiciones(env);
    assert.ok(t.some(x => x.service === 'outbox-drain' && x.to === 'dead'), 'pero la transición SÍ queda');
    assert.ok(t.some(x => x.service === 'svc-emulador' && x.to === 'dead'));
});

// ===========================================================================
// Recuperación.
// ===========================================================================

test('cuando el servicio vuelve, se registra recovered y se avisa el cierre', () => {
    const env = nuevoEntorno();
    correrCiclo(env, TODOS);
    correrCiclo(env, SIN_RECONCILER);
    const c = correrCiclo(env, TODOS);

    assert.strictEqual(c.action.trim(), 'ok');
    assert.ok(transiciones(env).some(t => t.service === 'svc-reconciler' && t.reason === 'recovered'));
    assert.strictEqual(avisos(env).length, 2, 'la caída y su cierre');
});

// ===========================================================================
// Robustez del runner.
// ===========================================================================

test('el runner nunca deja al watchdog sin línea ACTION', () => {
    const env = nuevoEntorno();
    // Directorio de estado no escribible no puede dejar mudo al watchdog.
    const c = correrCiclo(env, TODOS);
    assert.match(c.stdout, /^ACTION:/m);
    assert.strictEqual(c.status, 0, 'sale con 0: un fallo del barrido no tumba el watchdog');
});

test('el runner escribe su propio log de diagnóstico', () => {
    const env = nuevoEntorno();
    correrCiclo(env, TODOS);
    correrCiclo(env, SIN_RECONCILER);
    const log = fs.readFileSync(path.join(env.dir, 'logs', 'service-liveness.log'), 'utf8');
    assert.ok(log.includes('svc-reconciler'));
    assert.ok(/transición|CAÍDO/.test(log));
});
