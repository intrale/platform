// =============================================================================
// dispatch-stall-watchdog.test.js — Watchdog de inactividad de DESPACHO (#5400).
//
// El 2026-08-02 el pipeline estuvo 1h33 sin despachar y no llegó NINGUNA
// notificación. El watchdog de ola (#4708) existía pero: (a) estaba apagado,
// (b) una causa declarada lo callaba para siempre, (c) medía el movimiento con
// el conteo de `trabajando/`, que miente cuando un agente queda clavado.
//
// Un test por escenario Gherkin del issue + las regresiones que el análisis
// marcó como obligatorias:
//   G-3    un agente clavado no congela el reloj
//   R-3    no-regresión de #4751 (modo ola por debajo del umbral sigue mudo)
//   SEC-2  autoría declarada, nunca atribuida a una persona sin dato
//   SEC-3  el watchdog es read-only (no destraba nada)
//   SEC-4  clamp del umbral nuevo (0 / negativo / gigante no lo desactivan)
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wd = require('../wave-stall-watchdog');
const lastDispatch = require('../last-dispatch');

const MIN = 60 * 1000;

// Foto base con estampa de despacho efectivo: el pipeline no despacha desde
// `lastDispatchTs`, hay trabajo elegible y el estado ya vio esa estampa.
function pipelineFacts(overrides = {}) {
    const lastDispatchTs = overrides.lastDispatchTs !== undefined ? overrides.lastDispatchTs : 20 * MIN;
    return {
        now: 120 * MIN,
        waveKey: 7,
        enabledCount: 5,
        dispatching: 0,
        progressSeries: [{ ts: 1, waveKey: 7, avancePct: 42 }],
        cause: null,
        lastDispatchTs,
        state: {
            lastMovementTs: lastDispatchTs,
            lastSignature: `0:42:${lastDispatchTs}`,
            lastAlertTs: 0,
            alertCount: 0,
        },
        stallMinutes: 20,
        cooldownMinutes: 30,
        declaredCauseEscalateMinutes: 45,
        ...overrides,
    };
}

// ─── Escenario Gherkin 1 · pipeline pausado más allá del umbral ──────────────

test('pipeline pausado más allá del umbral emite alerta nombrando la pausa y su autoría', () => {
    // Pausa preservada por un restart, declarada hace 100 min (> 45 de escalada).
    const d = wd.decide(pipelineFacts({
        cause: { declared: true, kind: 'human-halt', readable: true, sinceTs: 20 * MIN },
        authorDeclared: 'leitolarreta',
    }));
    assert.equal(d.action, 'alert');
    assert.equal(d.reason, 'stale-declared-cause:human-halt');
    assert.equal(d.level, 'warn');
    // CA-2: nombra la causa concreta, no un mensaje genérico.
    assert.ok(d.message.includes('pausa total declarada por el operador'), d.message);
    // Autoría rotulada como DECLARADA (SEC-2).
    assert.ok(d.message.includes('autoría declarada: leitolarreta'), d.message);
    // Cantidad de issues elegibles esperando.
    assert.ok(d.message.includes('5 issue(s) habilitado(s)'), d.message);
});

// ─── Escenario Gherkin 2 · cola legítimamente vacía ──────────────────────────

test('cola legítimamente vacía no genera alerta', () => {
    const d = wd.decide(pipelineFacts({ enabledCount: 0, cause: null }));
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'no-enabled-work');
    assert.equal(d.message, null);
});

test('una causa vieja tampoco alerta si no hay trabajo elegible esperando (CA-3 manda)', () => {
    const d = wd.decide(pipelineFacts({
        enabledCount: 0,
        cause: { declared: true, kind: 'human-halt', readable: true, sinceTs: 20 * MIN },
    }));
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'no-enabled-work');
    assert.equal(d.message, null);
});

// ─── Escenario Gherkin 3 · recuperación del despacho ─────────────────────────

test('recuperación del despacho emite aviso con la duración total de la detención', () => {
    // Episodio ya alertado (alertCount 2), último despacho previo a los 20 min.
    // Ahora entra una estampa nueva a los 120 min → detención de 100 min.
    const d = wd.decide(pipelineFacts({
        now: 120 * MIN,
        lastDispatchTs: 120 * MIN,
        state: {
            lastMovementTs: 20 * MIN,
            lastSignature: `0:42:${20 * MIN}`,
            lastAlertTs: 100 * MIN,
            alertCount: 2,
        },
    }));
    assert.ok(d.recovery, 'debe traer payload de recuperación');
    assert.equal(d.recovery.outageMs, 100 * MIN);
    assert.ok(d.recovery.message.includes('1 h 40 min'), d.recovery.message);
    assert.ok(d.recovery.message.includes('despacho reanudado'), d.recovery.message);
    // El episodio se cierra: no re-alerta ni deja contador colgado.
    assert.equal(d.nextState.alertCount, 0);
    assert.equal(d.nextState.lastAlertTs, 0);
});

test('la recuperación se emite UNA sola vez (el tick siguiente ya no la repite)', () => {
    const primero = wd.decide(pipelineFacts({
        now: 120 * MIN,
        lastDispatchTs: 120 * MIN,
        state: {
            lastMovementTs: 20 * MIN, lastSignature: `0:42:${20 * MIN}`,
            lastAlertTs: 100 * MIN, alertCount: 2,
        },
    }));
    assert.ok(primero.recovery);
    // Segundo tick con el estado ya persistido y la misma estampa.
    const segundo = wd.decide(pipelineFacts({
        now: 121 * MIN, lastDispatchTs: 120 * MIN, state: primero.nextState,
    }));
    assert.equal(segundo.recovery, null);
});

test('sin alerta previa, reanudar el despacho NO emite aviso de recuperación', () => {
    // Nadie se enteró de nada: no hay nada que "recuperar" que valga un mensaje.
    const d = wd.decide(pipelineFacts({
        now: 120 * MIN,
        lastDispatchTs: 120 * MIN,
        state: { lastMovementTs: 100 * MIN, lastSignature: `0:42:${100 * MIN}`, lastAlertTs: 0, alertCount: 0 },
    }));
    assert.equal(d.recovery, null);
});

test('los agentes terminando NO se confunden con un despacho nuevo', () => {
    // El conteo de `trabajando/` baja de 3 a 0 sin que salga nada nuevo. Con la
    // proxy vieja eso reiniciaba el reloj y habría emitido una recuperación falsa.
    const d = wd.decide(pipelineFacts({
        now: 120 * MIN,
        dispatching: 0,
        lastDispatchTs: 20 * MIN,
        state: {
            lastMovementTs: 20 * MIN, lastSignature: `3:42:${20 * MIN}`,
            lastAlertTs: 100 * MIN, alertCount: 1,
        },
    }));
    assert.equal(d.recovery, null, 'terminar trabajo no es despachar trabajo');
    assert.equal(d.nextState.lastMovementTs, 20 * MIN, 'el reloj no se reinicia');
});

// ─── G-3 · el conteo de trabajando/ no es la señal ──────────────────────────

test('un agente clavado en trabajando no congela el reloj de despacho', () => {
    // 3 agentes vivos en `trabajando/` pero el último despacho fue hace 100 min.
    // Con la proxy de conteo esto era `skip: dispatching` para siempre.
    const d = wd.decide(pipelineFacts({ dispatching: 3, lastDispatchTs: 20 * MIN }));
    assert.equal(d.action, 'alert');
    assert.equal(d.reason, 'unexplained-stall');
    assert.equal(d.stalledMs, 100 * MIN);
});

test('sin estampa de despacho se conserva la proxy legacy (skip dispatching)', () => {
    // Instalación que todavía no escribió `last-dispatch.json`: conducta #4708.
    const d = wd.decide(pipelineFacts({ dispatching: 3, lastDispatchTs: undefined }));
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'dispatching');
});

// ─── R-3 · no-regresión de #4751 ─────────────────────────────────────────────

test('causa declarada por debajo del umbral sigue muda (no-regresión #4751)', () => {
    // Modo ola declarado hace 10 min: por debajo de los 45 de escalada → mudo.
    const d = wd.decide(pipelineFacts({
        now: 120 * MIN,
        cause: { declared: true, kind: 'wave-empty', readable: true, sinceTs: 110 * MIN },
    }));
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'declared-cause:wave-empty');
    assert.equal(d.message, null);
});

test('el reloj de la causa arranca solo cuando la causa aparece (sin sinceTs del caller)', () => {
    // Es el caso de la PAUSA TOTAL: `getPipelineMode()` devuelve `createdAt: null`,
    // así que el watchdog necesita su propio reloj o el incidente se repite.
    const cause = { declared: true, kind: 'human-halt', readable: true };
    const t1 = wd.decide(pipelineFacts({ now: 120 * MIN, cause }));
    assert.equal(t1.action, 'skip');
    assert.equal(t1.reason, 'declared-cause:human-halt');
    assert.equal(t1.nextState.causeSinceTs, 120 * MIN);
    // 46 min después con la MISMA causa vigente → supera la escalada.
    const t2 = wd.decide(pipelineFacts({ now: 166 * MIN, cause, state: t1.nextState }));
    assert.equal(t2.action, 'alert');
    assert.equal(t2.reason, 'stale-declared-cause:human-halt');
});

test('cambiar de causa reinicia el reloj de la causa (no acumula entre causas distintas)', () => {
    const t1 = wd.decide(pipelineFacts({
        now: 120 * MIN,
        cause: { declared: true, kind: 'wave-empty', readable: true },
    }));
    const t2 = wd.decide(pipelineFacts({
        now: 160 * MIN,
        cause: { declared: true, kind: 'night-window', readable: true },
        state: t1.nextState,
    }));
    assert.equal(t2.nextState.causeKind, 'night-window');
    assert.equal(t2.nextState.causeSinceTs, 160 * MIN);
    assert.equal(t2.action, 'skip');
});

// ─── CA-4 · backoff verificable ──────────────────────────────────────────────

test('el aviso no se repite en cada ciclo: hay backoff verificable', () => {
    const cause = { declared: true, kind: 'human-halt', readable: true, sinceTs: 20 * MIN };
    const t1 = wd.decide(pipelineFacts({ now: 120 * MIN, cause }));
    assert.equal(t1.action, 'alert');
    // Ticks siguientes dentro del cooldown de 30 min → mudos.
    for (const min of [121, 130, 145]) {
        const tn = wd.decide(pipelineFacts({ now: min * MIN, cause, state: t1.nextState }));
        assert.equal(tn.action, 'skip', `tick ${min} debe callar`);
        assert.equal(tn.reason, 'cooldown');
    }
    // Pasado el cooldown → re-alerta escalando.
    const t5 = wd.decide(pipelineFacts({ now: 151 * MIN, cause, state: t1.nextState }));
    assert.equal(t5.action, 'escalate');
    assert.equal(t5.level, 'error');
});

// ─── G-5 / C-3 · alcance pipeline, no sólo ola ───────────────────────────────

test('sin ola activa el watchdog igual vigila el despacho del pipeline', () => {
    const d = wd.decide(pipelineFacts({ waveKey: null }));
    assert.equal(d.action, 'alert');
    assert.equal(d.waveKey, null);
    // El sujeto del mensaje pasa a ser el pipeline, no una ola inexistente.
    assert.ok(d.message.startsWith('Pipeline sin despachar'), d.message);
    assert.ok(!d.message.includes('null'), d.message);
});

// ─── SEC-4 · clamp del umbral nuevo ──────────────────────────────────────────

test('umbral de escalada 0, negativo, null o gigante cae al default y no desactiva el control', () => {
    for (const malo of [0, -5, null, 'abc', 999999, 3.5]) {
        const d = wd.decide(pipelineFacts({
            declaredCauseEscalateMinutes: malo,
            cause: { declared: true, kind: 'human-halt', readable: true, sinceTs: 20 * MIN },
        }));
        // Con el default (45 min) y una causa de 100 min, DEBE escalar igual.
        assert.equal(d.action, 'alert', `umbral inválido ${malo} no debe desactivar la escalada`);
    }
});

test('una estampa en el futuro (reloj corrido) no silencia el watchdog', () => {
    const d = wd.decide(pipelineFacts({
        now: 120 * MIN,
        lastDispatchTs: 999 * MIN, // futuro
        state: { lastMovementTs: 20 * MIN, lastSignature: 'x', lastAlertTs: 0, alertCount: 0 },
    }));
    // Se acota a `now`: stalledMs nunca negativo y la estampa no vale "nunca stall".
    assert.ok(d.stalledMs >= 0);
    assert.equal(d.lastDispatchTs, 120 * MIN);
});

// ─── SEC-2 · autoría ─────────────────────────────────────────────────────────

test('sin autoría registrada el aviso jamás atribuye la pausa a una persona', () => {
    for (const sinAutor of [undefined, null, '', '   ']) {
        const d = wd.decide(pipelineFacts({
            cause: { declared: true, kind: 'human-halt', readable: true, sinceTs: 20 * MIN },
            authorDeclared: sinAutor,
        }));
        assert.equal(d.action, 'alert');
        assert.ok(d.message.includes('autoría no registrada'), d.message);
        assert.ok(!d.message.includes('autoría declarada'), d.message);
    }
});

test('la autoría se rotula siempre como DECLARADA, nunca como hecho verificado', () => {
    const d = wd.decide(pipelineFacts({
        cause: { declared: true, kind: 'partial-pause', readable: true, sinceTs: 20 * MIN },
        authorDeclared: 'commander',
    }));
    assert.ok(d.message.includes('autoría declarada: commander'), d.message);
});

// ─── SEC-3 · read-only por contrato ──────────────────────────────────────────

test('el watchdog no muta punto-paused ni la allowlist ni la cola', () => {
    const d = wd.decide(pipelineFacts({
        cause: { declared: true, kind: 'human-halt', readable: true, sinceTs: 20 * MIN },
    }));
    // Las únicas acciones posibles son observacionales.
    assert.ok(['skip', 'alert', 'escalate'].includes(d.action));
    // Nada en la decisión sugiere tocar `.paused`, la allowlist o la cola.
    for (const prohibido of ['unpause', 'clearPause', 'resume', 'allowlist', 'promote', 'delete']) {
        assert.ok(!(prohibido in d), `la decisión no debe exponer '${prohibido}'`);
    }
    assert.ok(!/\.paused|allowlist|partial-pause\.json/.test(d.message || ''), d.message);
});

test('decide() es puro: no muta los facts ni el estado recibido', () => {
    const f = pipelineFacts({
        cause: { declared: true, kind: 'human-halt', readable: true, sinceTs: 20 * MIN },
    });
    const snapshotFacts = JSON.stringify(f);
    const estadoOriginal = { ...f.state };
    wd.decide(f);
    assert.equal(JSON.stringify(f), snapshotFacts, 'decide no debe mutar los facts');
    assert.deepEqual(f.state, estadoOriginal, 'decide no debe mutar el estado recibido');
});

// ─── SEC-1 · el aviso se entrega (nada rompe el parseo ni filtra datos) ──────

test('el mensaje no filtra paths, tokens ni metacaracteres de la autoría', () => {
    const d = wd.decide(pipelineFacts({
        cause: { declared: true, kind: 'human-halt', readable: true, sinceTs: 20 * MIN },
        authorDeclared: 'C:\\Workspaces\\secreto *_`[ AKIAIOSFODNN7EXAMPLE',
    }));
    assert.ok(!/[A-Za-z]:\\/.test(d.message), d.message);
    assert.ok(!/[*`[]/.test(d.message), d.message);
});

// ─── Helpers de formato / catálogo de causas ─────────────────────────────────

test('formatDurationEs: segundos, minutos y horas', () => {
    assert.equal(wd.formatDurationEs(5000), '5 s');
    assert.equal(wd.formatDurationEs(20 * MIN), '20 min');
    assert.equal(wd.formatDurationEs(93 * MIN), '1 h 33 min');
    assert.equal(wd.formatDurationEs(120 * MIN), '2 h');
    assert.equal(wd.formatDurationEs(-1), '0 s');
    assert.equal(wd.formatDurationEs(NaN), '0 s');
});

test('describeCause nombra cada causa del CA-2 y tolera un kind desconocido', () => {
    assert.match(wd.describeCause('human-halt'), /pausa total/);
    assert.match(wd.describeCause('partial-pause'), /pausa parcial/);
    assert.match(wd.describeCause('wave-empty'), /allowlist vacía/);
    assert.match(wd.describeCause('concurrency-limit'), /límite de concurrencia/);
    assert.match(wd.describeCause('priority-window'), /ventana de prioridad/);
    assert.equal(wd.describeCause(null), 'sin causa declarada');
    // Kind desconocido: se devuelve saneado, sin metacaracteres de Markdown.
    assert.equal(wd.describeCause('raro_*`[x'), 'raro_x');
});

// ─── G-1 · estampa del despacho efectivo ─────────────────────────────────────

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'last-dispatch-'));
}

test('el timestamp de último despacho se persiste de forma atómica al lanzar un agente', () => {
    const dir = tmpDir();
    try {
        const ok = lastDispatch.writeLastDispatch(
            dir, { issue: 5400, skill: 'pipeline-dev', fase: 'dev', pipeline: 'desarrollo' }, 1_700_000_000_000
        );
        assert.equal(ok, true);
        const leido = lastDispatch.readLastDispatch(dir);
        assert.equal(leido.ts, 1_700_000_000_000);
        assert.equal(leido.issue, '5400');
        assert.equal(leido.skill, 'pipeline-dev');
        assert.equal(leido.fase, 'dev');
        assert.equal(leido.pipeline, 'desarrollo');
        // No queda ningún temporal: el rename fue atómico.
        const sobrantes = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
        assert.deepEqual(sobrantes, []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('la estampa ignora un ts inyectado por el caller (no se puede silenciar el watchdog)', () => {
    const dir = tmpDir();
    try {
        // `ts` dentro de meta NO debe pisar el timestamp real: estampar un futuro
        // lejano sería la forma trivial de callar el watchdog para siempre.
        lastDispatch.writeLastDispatch(dir, { issue: 1, ts: 9_999_999_999_999 }, 1000);
        assert.equal(lastDispatch.readLastDispatch(dir).ts, 1000);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('la estampa descarta campos fuera de la allowlist y sanea los aceptados', () => {
    const dir = tmpDir();
    try {
        lastDispatch.writeLastDispatch(dir, {
            issue: 5400,
            skill: 'a\nb\tc   d',
            secreto: 'AKIAIOSFODNN7EXAMPLE',
        }, 1000);
        const leido = lastDispatch.readLastDispatch(dir);
        assert.equal(leido.skill, 'a b c d', 'los caracteres de control se colapsan');
        assert.equal('secreto' in leido, false, 'campo fuera de la allowlist descartado');
        const crudo = fs.readFileSync(lastDispatch.lastDispatchPath(dir), 'utf8');
        assert.ok(!crudo.includes('AKIAIOSFODNN7EXAMPLE'), 'nada fuera de la allowlist se persiste');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('la estampa acota cada campo y es fail-soft ante lectura ausente o corrupta', () => {
    const dir = tmpDir();
    try {
        assert.equal(lastDispatch.readLastDispatch(path.join(dir, 'no-existe')), null);
        lastDispatch.writeLastDispatch(dir, { skill: 'x'.repeat(500) }, 1000);
        assert.equal(lastDispatch.readLastDispatch(dir).skill.length, lastDispatch.MAX_FIELD_LEN);
        // Corrupto → null (nunca lanza, nunca alimenta al watchdog con basura).
        fs.writeFileSync(lastDispatch.lastDispatchPath(dir), '{no json');
        assert.equal(lastDispatch.readLastDispatch(dir), null);
        // ts inválido → se trata como ausencia de estampa (cae a la proxy legacy).
        fs.writeFileSync(lastDispatch.lastDispatchPath(dir), JSON.stringify({ ts: -1 }));
        assert.equal(lastDispatch.readLastDispatch(dir), null);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('escribir la estampa en un destino imposible no lanza (fail-soft)', () => {
    // Un fallo de FS jamás puede tumbar el loop del Pulpo.
    const dir = tmpDir();
    try {
        const archivo = path.join(dir, 'soy-un-archivo');
        fs.writeFileSync(archivo, 'x');
        assert.equal(lastDispatch.writeLastDispatch(path.join(archivo, 'sub'), { issue: 1 }, 1000), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
