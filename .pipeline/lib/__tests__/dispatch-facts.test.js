// =============================================================================
// dispatch-facts.test.js — BRAZO DE RECOLECCIÓN del watchdog de despacho (#5400)
//
// Por qué existe (bloqueante N4 de la review rev-2)
// -------------------------------------------------
// `decide()` estaba bien testeado y era correcto; lo que fallaba eran LOS HECHOS
// que le entraban. Los tres bloqueantes de rev-2 vivían todos en este tramo, y
// se colaron porque era el único sin un solo test:
//
//   N1 — la causa salía SIEMPRE `partial-pause`: el primer chequeo era
//        `mode !== 'running'` y desde #5060 `partial_pause` con allowlist viva es
//        el modo NORMAL de operación. Todas las causas siguientes eran
//        inalcanzables y el aviso nombraba siempre la causa equivocada.
//   N2 — "elegibles" contaba los 241 workfiles de `pendiente/` sin cruzarlos con
//        la allowlist (228 eran backlog parkeado, alguno de 200 h).
//   N3 — la autoría de la pausa TOTAL se leía de `getPipelineMode().source`, que
//        es `null` por estructura cuando existe `.paused`.
//
// Los escenarios de acá reproducen el ESTADO REAL del pipeline vivo: allowlist
// no vacía + `pendiente/` mayoritariamente fuera de esa allowlist. Es el test
// que, según la propia review, "habría mostrado N1 y N2 de una".
// =============================================================================

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const df = require('../dispatch-facts');

// --- Andamiaje: un `.pipeline/` de verdad en un temp dir ---------------------

let tmpRoot = null;
let envPrevio;

const CONFIG = {
    pipelines: {
        definicion: { fases: ['analisis', 'criterios'] },
        desarrollo: { fases: ['dev', 'verificacion'] },
    },
};

function crearPendiente(pipelineName, fase, nombre) {
    const dir = path.join(tmpRoot, pipelineName, fase, 'pendiente');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, nombre), 'issue: x\n');
}

function escribirPartialPause(allowedIssues, extra) {
    fs.writeFileSync(
        path.join(tmpRoot, '.partial-pause.json'),
        JSON.stringify(Object.assign({
            allowed_issues: allowedIssues,
            created_at: '2026-08-03T10:22:37.495Z',
            source: 'commander:leo',
        }, extra || {})),
    );
}

function escribirPausaTotal(marker) {
    fs.writeFileSync(path.join(tmpRoot, '.paused'), typeof marker === 'string'
        ? marker
        : JSON.stringify(marker));
}

/** partialPause REAL, apuntado al temp dir vía el override que expone el módulo. */
function partialPauseReal() {
    delete require.cache[require.resolve('../partial-pause')];
    return require('../partial-pause');
}

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-facts-'));
    envPrevio = {
        dir: process.env.PIPELINE_DIR_OVERRIDE,
        unscoped: process.env.PIPELINE_ALLOW_UNSCOPED_DISPATCH,
    };
    process.env.PIPELINE_DIR_OVERRIDE = tmpRoot;
    delete process.env.PIPELINE_ALLOW_UNSCOPED_DISPATCH;
});

afterEach(() => {
    if (envPrevio.dir === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
    else process.env.PIPELINE_DIR_OVERRIDE = envPrevio.dir;
    if (envPrevio.unscoped === undefined) delete process.env.PIPELINE_ALLOW_UNSCOPED_DISPATCH;
    else process.env.PIPELINE_ALLOW_UNSCOPED_DISPATCH = envPrevio.unscoped;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    delete require.cache[require.resolve('../partial-pause')];
});

// =============================================================================
// N2 — conteo de elegibles
// =============================================================================

test('el backlog parkeado fuera de la allowlist NO cuenta como trabajo elegible', () => {
    escribirPartialPause([5400, 5401]);
    crearPendiente('desarrollo', 'dev', '5400.pipeline-dev');
    crearPendiente('definicion', 'analisis', '3641.security');   // 198 h en la cola real
    crearPendiente('definicion', 'analisis', '3913.guru');       // 208 h en la cola real
    crearPendiente('desarrollo', 'verificacion', '4210.qa');

    const hechos = df.recolectarHechos({
        partialPause: partialPauseReal(),
        listarPendientes: () => df.listarPendientesFS(tmpRoot, CONFIG),
    });

    assert.equal(hechos.conteo.total, 4);
    assert.equal(hechos.conteo.elegibles, 1, 'sólo #5400 está en la allowlist');
    assert.equal(hechos.conteo.fueraDeAlcance, 3);
    assert.equal(hechos.conteo.alcanceAplicado, 'allowlist');
});

test('con la allowlist sin trabajo encolado el conteo elegible da 0 (CA-3 alcanzable)', () => {
    // El estado real del pipeline vivo: 65 issues en la allowlist, 241 pendientes,
    // ninguno de la ola. rev-2 informaba 241 elegibles y CA-3 nunca enganchaba.
    escribirPartialPause([9001, 9002, 9003]);
    for (let i = 0; i < 20; i++) crearPendiente('definicion', 'analisis', `${3000 + i}.guru`);

    const hechos = df.recolectarHechos({
        partialPause: partialPauseReal(),
        listarPendientes: () => df.listarPendientesFS(tmpRoot, CONFIG),
    });

    assert.equal(hechos.conteo.total, 20);
    assert.equal(hechos.conteo.elegibles, 0);
});

test('con el escape hatch de dispatch sin ola todo pendiente es elegible', () => {
    process.env.PIPELINE_ALLOW_UNSCOPED_DISPATCH = '1';
    crearPendiente('desarrollo', 'dev', '5400.pipeline-dev');
    crearPendiente('definicion', 'analisis', '3641.security');

    const hechos = df.recolectarHechos({
        partialPause: partialPauseReal(),
        listarPendientes: () => df.listarPendientesFS(tmpRoot, CONFIG),
    });

    assert.equal(hechos.conteo.elegibles, 2);
    assert.equal(hechos.conteo.alcanceAplicado, 'unscoped');
});

test('sin allowlist ni ola activa el backlog parkeado no es trabajo elegible', () => {
    // #5060: sin allowlist el dispatch está fail-closed. El backlog no está
    // "esperando que lo despachen", está estacionado a propósito.
    for (let i = 0; i < 5; i++) crearPendiente('definicion', 'analisis', `${3000 + i}.guru`);

    const hechos = df.recolectarHechos({
        partialPause: partialPauseReal(),
        listarPendientes: () => df.listarPendientesFS(tmpRoot, CONFIG),
        issuesOlaActiva: () => [],
    });

    assert.equal(hechos.conteo.elegibles, 0);
    assert.equal(hechos.conteo.alcanceAplicado, 'fail-closed-sin-ola');
    assert.equal(hechos.cause.kind, 'wave-empty');
});

test('con ola activa pero allowlist ausente el elegible se acota a la ola (desync)', () => {
    crearPendiente('desarrollo', 'dev', '5400.pipeline-dev');
    crearPendiente('definicion', 'analisis', '3641.security');
    crearPendiente('definicion', 'analisis', '3913.guru');

    const hechos = df.recolectarHechos({
        partialPause: partialPauseReal(),
        listarPendientes: () => df.listarPendientesFS(tmpRoot, CONFIG),
        issuesOlaActiva: () => [
            { number: 5400, status: 'open' },
            { number: 9999, status: 'open' },
        ],
    });

    assert.equal(hechos.conteo.elegibles, 1, 'sólo #5400 tiene workfile encolado');
    assert.equal(hechos.conteo.alcanceAplicado, 'desync-ola');
    assert.equal(hechos.cause.kind, 'wave-empty');
});

// =============================================================================
// N1 — la causa declarada
// =============================================================================

test('la pausa parcial con trabajo elegible esperando NO es la causa del no-despacho', () => {
    // El estado REAL del pipeline vivo (2026-08-03): partial_pause con 65 issues
    // habilitados. rev-2 devolvía 'partial-pause' acá y dejaba inalcanzables
    // todas las causas siguientes.
    escribirPartialPause([5400]);
    crearPendiente('desarrollo', 'dev', '5400.pipeline-dev');

    const hechos = df.recolectarHechos({
        partialPause: partialPauseReal(),
        listarPendientes: () => df.listarPendientesFS(tmpRoot, CONFIG),
        isQuotaExhausted: () => true,
    });

    assert.equal(hechos.conteo.elegibles, 1);
    assert.equal(hechos.cause.kind, 'quota', 'la causa real es la cuota, no la allowlist');
});

test('la pausa parcial SÍ es la causa cuando no deja trabajo elegible', () => {
    escribirPartialPause([9001]);
    crearPendiente('definicion', 'analisis', '3641.security');

    const hechos = df.recolectarHechos({
        partialPause: partialPauseReal(),
        listarPendientes: () => df.listarPendientesFS(tmpRoot, CONFIG),
    });

    assert.equal(hechos.cause.kind, 'partial-pause');
    assert.equal(hechos.cause.authorDeclared, 'commander:leo');
    assert.equal(hechos.cause.sinceTs, Date.parse('2026-08-03T10:22:37.495Z'));
});

test('en operación normal las causas posteriores a la pausa parcial son alcanzables', () => {
    // El contraejemplo directo de N1: con `partial_pause` vivo y elegibles > 0,
    // cada causa del recolector tiene que poder salir. rev-2 devolvía
    // 'partial-pause' en los seis casos.
    escribirPartialPause([5400]);
    crearPendiente('desarrollo', 'dev', '5400.pipeline-dev');
    const base = {
        partialPause: partialPauseReal(),
        listarPendientes: () => df.listarPendientesFS(tmpRoot, CONFIG),
    };

    const casos = [
        [{ isNightWindow: () => true }, 'night-window'],
        [{ isQuotaExhausted: () => true }, 'quota'],
        [{ isResourcePressure: () => true }, 'resource-pressure'],
        [{ isWaveWaitingOperator: () => true }, 'waiting-operator'],
        [{
            causaDesdeArtifact: () => ({
                declared: true, kind: 'concurrency-limit', readable: true,
                sinceTs: null, authorDeclared: null,
            }),
        }, 'concurrency-limit'],
    ];

    for (const [deps, esperado] of casos) {
        const hechos = df.recolectarHechos({ ...base, ...deps });
        assert.equal(hechos.cause.kind, esperado);
    }
});

test('sin ninguna causa detectable el recolector devuelve null y el watchdog dispara', () => {
    escribirPartialPause([5400]);
    crearPendiente('desarrollo', 'dev', '5400.pipeline-dev');

    const hechos = df.recolectarHechos({
        partialPause: partialPauseReal(),
        listarPendientes: () => df.listarPendientesFS(tmpRoot, CONFIG),
    });

    assert.equal(hechos.cause, null);
});

test('un chequeo de causa que explota no silencia la alarma (fail-closed)', () => {
    escribirPartialPause([5400]);
    crearPendiente('desarrollo', 'dev', '5400.pipeline-dev');

    const hechos = df.recolectarHechos({
        partialPause: partialPauseReal(),
        listarPendientes: () => df.listarPendientesFS(tmpRoot, CONFIG),
        isNightWindow: () => { throw new Error('night-window rota'); },
        isQuotaExhausted: () => { throw new Error('quota rota'); },
        causaDesdeArtifact: () => { throw new Error('artifact ilegible'); },
    });

    assert.equal(hechos.cause, null, 'sin causa ⇒ el watchdog dispara');
});

// =============================================================================
// N3 — autoría de la pausa TOTAL (Gherkin #1)
// =============================================================================

test('la pausa total resuelve autoría y fecha desde el marker estructurado', () => {
    escribirPartialPause([5400, 5401]);
    escribirPausaTotal({
        source: 'restart:preserved',
        ts: '2026-08-02T14:31:00.000Z',
        detail: 'pausa preservada por /restart',
    });
    crearPendiente('desarrollo', 'dev', '5400.pipeline-dev');

    const hechos = df.recolectarHechos({
        partialPause: partialPauseReal(),
        listarPendientes: () => df.listarPendientesFS(tmpRoot, CONFIG),
    });

    assert.equal(hechos.cause.kind, 'human-halt');
    assert.equal(hechos.cause.authorDeclared, 'restart:preserved');
    assert.equal(hechos.cause.sinceTs, Date.parse('2026-08-02T14:31:00.000Z'));
});

test('la pausa total NO borra la allowlist para el conteo de elegibles', () => {
    // `getPipelineMode()` devuelve allowedIssues:[] en cuanto existe `.paused`.
    // Si el recolector se quedara con eso, el escenario Gherkin #1 (pipeline
    // pausado con trabajo esperando) daría 0 elegibles y NUNCA alertaría.
    escribirPartialPause([5400, 5401]);
    escribirPausaTotal({ source: 'commander:leo', ts: '2026-08-02T14:31:00.000Z' });
    crearPendiente('desarrollo', 'dev', '5400.pipeline-dev');
    crearPendiente('desarrollo', 'dev', '5401.android-dev');
    crearPendiente('definicion', 'analisis', '3641.security');

    const hechos = df.recolectarHechos({
        partialPause: partialPauseReal(),
        listarPendientes: () => df.listarPendientesFS(tmpRoot, CONFIG),
    });

    assert.equal(hechos.alcance.fullPaused, true);
    assert.equal(hechos.conteo.elegibles, 2);
    assert.equal(hechos.conteo.fueraDeAlcance, 1);
});

test('sin autoría registrada la pausa total jamás se atribuye a una persona', () => {
    escribirPartialPause([5400]);
    escribirPausaTotal('2026-08-02T14:31:00.000Z'); // marker legacy: ISO pelado
    crearPendiente('desarrollo', 'dev', '5400.pipeline-dev');

    const hechos = df.recolectarHechos({
        partialPause: partialPauseReal(),
        listarPendientes: () => df.listarPendientesFS(tmpRoot, CONFIG),
    });

    assert.equal(hechos.cause.kind, 'human-halt');
    assert.equal(hechos.cause.authorDeclared, null, 'null ⇒ el mensaje dirá "autoría no registrada"');
});

test('la pausa total gana sobre cualquier otra causa: con .paused no sale nada', () => {
    escribirPartialPause([5400]);
    escribirPausaTotal({ source: 'commander:leo', ts: '2026-08-02T14:31:00.000Z' });
    crearPendiente('desarrollo', 'dev', '5400.pipeline-dev');

    const hechos = df.recolectarHechos({
        partialPause: partialPauseReal(),
        listarPendientes: () => df.listarPendientesFS(tmpRoot, CONFIG),
        isQuotaExhausted: () => true,
    });

    assert.equal(hechos.cause.kind, 'human-halt');
});

// =============================================================================
// Barrido de `pendiente/`
// =============================================================================

test('el barrido de pendientes ignora dotfiles, gitkeep y artifacts auxiliares', () => {
    const dir = path.join(tmpRoot, 'desarrollo', 'dev', 'pendiente');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '5400.pipeline-dev'), 'x');
    fs.writeFileSync(path.join(dir, '.gitkeep'), '');
    fs.writeFileSync(path.join(dir, '.oculto'), '');
    fs.writeFileSync(path.join(dir, '5400.pipeline-dev.guidance.txt'), 'x');

    const pendientes = df.listarPendientesFS(tmpRoot, CONFIG);
    assert.deepEqual(pendientes.map((p) => p.name), ['5400.pipeline-dev']);
    assert.equal(pendientes[0].issue, '5400');
});

test('una fase sin carpeta pendiente no rompe el barrido', () => {
    crearPendiente('desarrollo', 'dev', '5400.pipeline-dev');
    assert.equal(df.listarPendientesFS(tmpRoot, CONFIG).length, 1);
    assert.deepEqual(df.listarPendientesFS(tmpRoot, {}), []);
    assert.deepEqual(df.listarPendientesFS(tmpRoot, null), []);
});

// =============================================================================
// SEC-3 — el recolector es READ-ONLY
// =============================================================================

test('recolectar hechos no muta punto-paused, ni la allowlist, ni la cola', () => {
    escribirPartialPause([5400]);
    escribirPausaTotal({ source: 'commander:leo', ts: '2026-08-02T14:31:00.000Z' });
    crearPendiente('desarrollo', 'dev', '5400.pipeline-dev');

    const foto = () => {
        const out = {};
        const rec = (dir, prefijo) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                const rel = prefijo ? `${prefijo}/${e.name}` : e.name;
                if (e.isDirectory()) rec(p, rel);
                else out[rel] = fs.readFileSync(p, 'utf8');
            }
        };
        rec(tmpRoot, '');
        return out;
    };

    const antes = foto();
    df.recolectarHechos({
        partialPause: partialPauseReal(),
        listarPendientes: () => df.listarPendientesFS(tmpRoot, CONFIG),
    });
    assert.deepEqual(foto(), antes);
});

// =============================================================================
// rev-6 — Hallazgos del dictamen de integridad (#5400, rebote rev-1)
// =============================================================================

// S2 — el conteo elegible gobierna CA-3 y además viaja al mensaje de Telegram.
// Inflarlo rompía las dos cosas: volvía inalcanzable el "0 = cola vacía" y le
// mentía al operador sobre el tamaño real de la cola.
test('S2: el mismo issue en varias fases cuenta UNA vez (dedup por issue)', () => {
    const alcance = { unscoped: false, scoped: true, allowedIssues: new Set([5400, 5401]) };
    const pendientes = [
        { issue: '5400' }, { issue: '5400' }, { issue: '5400' },  // 3 fases, 1 issue
        { issue: '5401' },
    ];
    const c = df.contarElegibles(alcance, pendientes, {});
    assert.equal(c.total, 4, 'el total crudo de workfiles no cambia');
    assert.equal(c.elegibles, 2, 'pero los elegibles son ISSUES distintos');
});

test('S2: con el escape hatch, los workfiles que no parsean a issue no se cuentan', () => {
    const alcance = { unscoped: true, scoped: false, allowedIssues: new Set() };
    const pendientes = [
        { issue: '5400' }, { issue: '5400' },   // duplicado
        { issue: null }, { issue: 'basura' },   // no parsean
    ];
    const c = df.contarElegibles(alcance, pendientes, {});
    assert.equal(c.total, 4);
    assert.equal(c.elegibles, 1, 'un solo issue real y distinto');
    assert.equal(c.fueraDeAlcance, 3);
});

// B4 — "no hay trabajo" vs "no puedo ver el trabajo".
test('B4: sin allowlist y sin ola, con la cola llena, el alcance se declara CIEGO', () => {
    const alcance = { unscoped: false, scoped: false, allowedIssues: new Set() };
    const c = df.contarElegibles(alcance, [{ issue: '5400' }, { issue: '5401' }], {});
    assert.equal(c.alcanceAplicado, 'fail-closed-sin-ola');
    assert.equal(c.elegibles, 0);
    assert.equal(c.ciego, true, '0 elegibles acá NO es una cola vacía');
});

test('B4: con la cola realmente vacía NO hay ceguera (CA-3 sigue valiendo)', () => {
    const alcance = { unscoped: false, scoped: false, allowedIssues: new Set() };
    const c = df.contarElegibles(alcance, [], {});
    assert.equal(c.ciego, false, 'sin nada en cola, "0 elegibles" es un hecho afirmable');
});

test('B4: con alcance conocido, 0 elegibles es un hecho, no ceguera', () => {
    const alcance = { unscoped: false, scoped: true, allowedIssues: new Set([9999]) };
    const c = df.contarElegibles(alcance, [{ issue: '5400' }], {});
    assert.equal(c.elegibles, 0);
    assert.equal(c.ciego, false);
});

// S3 — una excepción JAMÁS puede silenciar el watchdog (lo promete el header).
test('S3: si getPipelineMode() TIRA, el alcance se marca ilegible y no se declara causa', () => {
    const alcance = df.leerAlcanceDespacho({
        partialPause: {
            getPipelineMode() { throw new Error('marker corrupto'); },
            readPreviousAllowlist: () => [],
            unscopedDispatchEnabled: () => false,
            readFullPauseOrigin: () => null,
        },
    });
    assert.equal(alcance.modeReadable, false, 'no sé leer el modo ≠ no hay ola');

    // Antes esto devolvía `wave-empty`: una excepción se convertía en causa
    // declarada y callaba la alarma. Sin causa, el watchdog dispara.
    const causa = df.resolverCausaDeclarada({ alcance, elegibles: 0, deps: {} });
    assert.equal(causa, null, 'una lectura fallida no es una explicación');
});

test('S3: si unscopedDispatchEnabled() TIRA, tampoco se declara causa', () => {
    const alcance = df.leerAlcanceDespacho({
        partialPause: {
            getPipelineMode: () => ({ mode: 'running', allowedIssues: [] }),
            readPreviousAllowlist: () => [],
            unscopedDispatchEnabled() { throw new Error('ilegible'); },
            readFullPauseOrigin: () => null,
        },
    });
    assert.equal(alcance.modeReadable, false);
    assert.equal(df.resolverCausaDeclarada({ alcance, elegibles: 0, deps: {} }), null);
});

test('S3: con el modo LEGIBLE y sin allowlist, `wave-empty` sigue siendo causa válida', () => {
    const alcance = df.leerAlcanceDespacho({
        partialPause: {
            getPipelineMode: () => ({ mode: 'running', allowedIssues: [] }),
            readPreviousAllowlist: () => [],
            unscopedDispatchEnabled: () => false,
            readFullPauseOrigin: () => null,
        },
    });
    assert.equal(alcance.modeReadable, true);
    const causa = df.resolverCausaDeclarada({ alcance, elegibles: 0, deps: {} });
    assert.equal(causa && causa.kind, 'wave-empty', 'no-regresión: el desync real sí explica');
});
