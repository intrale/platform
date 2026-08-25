'use strict';

// Tests de service-liveness-sweep.js (#6441).
// node --test .pipeline/lib/service-liveness-sweep.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const { sweep, impactoDe, textoDuracion, normalizeDedup } = require('./service-liveness-sweep');
const stale = require('./stale-services');

const HORA = 3600 * 1000;
const T0 = 1_700_000_000_000;

// Registro reducido con los tres casos que importan: supervisado, no
// supervisado por auto-muerte y no supervisado por ventana.
const REG = [
    { name: 'pulpo', script: 'pulpo.js', supervisado: true },
    { name: 'svc-reconciler', script: 'servicio-reconciler.js', supervisado: true },
    { name: 'outbox-drain', script: 'outbox-drain.js', supervisado: false },
    { name: 'svc-emulador', script: 'servicio-emulador.js', supervisado: false },
];

function todosVivos() {
    return {
        'pulpo': { alive: true },
        'svc-reconciler': { alive: true },
        'outbox-drain': { alive: true },
        'svc-emulador': { alive: true },
    };
}

// ---------------------------------------------------------------------------
// CA-6 — camino feliz: cero ruido.
// ---------------------------------------------------------------------------

test('CA-6: con todos los servicios vivos no se emite ningún aviso', () => {
    const d = sweep({ registry: REG, observed: todosVivos(), dedupState: null, now: T0 });
    assert.deepStrictEqual(d.alerts, []);
    assert.deepStrictEqual(d.relaunch, []);
    assert.deepStrictEqual(d.recovered, []);
    assert.deepStrictEqual(d.nextDedupState, { down: {} });
});

// ---------------------------------------------------------------------------
// CA-3/CA-4 — un supervisado que muere: alerta con nombre e impacto.
// ---------------------------------------------------------------------------

test('un supervisado caído alerta nombrando el servicio y qué deja de funcionar', () => {
    const obs = todosVivos();
    obs['svc-reconciler'] = { alive: false };
    const d = sweep({ registry: REG, observed: obs, dedupState: null, now: T0 });

    assert.strictEqual(d.alerts.length, 1);
    const a = d.alerts[0];
    assert.strictEqual(a.service, 'svc-reconciler');
    assert.strictEqual(a.kind, 'down');
    assert.ok(a.message.includes('svc-reconciler'), 'nombra el servicio');
    assert.ok(/tablero|sincroniza/i.test(a.message), 'explica el impacto en lenguaje llano');
    assert.deepStrictEqual(d.relaunch, ['svc-reconciler']);
});

test('un componente declarado que ni aparece en lo observado cuenta como muerto', () => {
    // "No lo vi" es exactamente el caso que quedó seis días mudo: fail hacia la
    // visibilidad, nunca hacia el silencio.
    const d = sweep({ registry: REG, observed: { 'pulpo': { alive: true } }, dedupState: null, now: T0 });
    assert.deepStrictEqual(d.relaunch, ['svc-reconciler']);
    assert.strictEqual(d.alerts.length, 1);
});

// ---------------------------------------------------------------------------
// CA-5 — deduplicación: avisa una vez y recuerda con throttle.
// ---------------------------------------------------------------------------

test('CA-5: la segunda corrida dentro del TTL no vuelve a alertar', () => {
    const obs = todosVivos();
    obs['svc-reconciler'] = { alive: false };

    const d1 = sweep({ registry: REG, observed: obs, dedupState: null, now: T0, reminderMs: 6 * HORA });
    assert.strictEqual(d1.alerts.length, 1, 'primer aviso inmediato');

    // dos minutos después (un ciclo de watchdog)
    const d2 = sweep({ registry: REG, observed: obs, dedupState: d1.nextDedupState, now: T0 + 120000, reminderMs: 6 * HORA });
    assert.deepStrictEqual(d2.alerts, [], 'no repite el aviso');
    assert.deepStrictEqual(d2.relaunch, ['svc-reconciler'], 'pero sigue pidiendo el relanzamiento');
});

test('CA-5: pasado el TTL recuerda, sin degradar a silencio permanente', () => {
    const obs = todosVivos();
    obs['svc-reconciler'] = { alive: false };

    const d1 = sweep({ registry: REG, observed: obs, dedupState: null, now: T0, reminderMs: 6 * HORA });
    const d2 = sweep({ registry: REG, observed: obs, dedupState: d1.nextDedupState, now: T0 + 6 * HORA, reminderMs: 6 * HORA });

    assert.strictEqual(d2.alerts.length, 1);
    assert.strictEqual(d2.alerts[0].kind, 'reminder');
    assert.ok(d2.alerts[0].message.includes('sigue caído'));
    assert.ok(d2.alerts[0].message.includes('6 horas'), 'dice hace cuánto');
    // El "desde cuándo" se conserva: no se reinicia en cada recordatorio.
    assert.strictEqual(d2.nextDedupState.down['svc-reconciler'].firstSeenTs, T0);
});

test('el estado ilegible o corrupto no silencia: se alerta igual', () => {
    const obs = todosVivos();
    obs['svc-reconciler'] = { alive: false };
    for (const basura of [null, undefined, 'no soy json', { down: 'tampoco' }, { down: { 'svc-reconciler': { firstSeenTs: 'x' } } }]) {
        const d = sweep({ registry: REG, observed: obs, dedupState: basura, now: T0 });
        assert.strictEqual(d.alerts.length, 1, 'con dedupState=' + JSON.stringify(basura) + ' debe alertar igual');
    }
});

test('tras recuperarse, una caída posterior vuelve a alertar de inmediato', () => {
    const caido = todosVivos();
    caido['svc-reconciler'] = { alive: false };

    const d1 = sweep({ registry: REG, observed: caido, dedupState: null, now: T0 });
    const d2 = sweep({ registry: REG, observed: todosVivos(), dedupState: d1.nextDedupState, now: T0 + HORA });
    assert.strictEqual(d2.recovered.length, 1, 'avisa la recuperación');
    assert.deepStrictEqual(d2.nextDedupState, { down: {} }, 'la entrada se limpia');

    const d3 = sweep({ registry: REG, observed: caido, dedupState: d2.nextDedupState, now: T0 + 2 * HORA });
    assert.strictEqual(d3.alerts.length, 1, 'la nueva caída no queda tapada por el throttle');
    assert.strictEqual(d3.alerts[0].kind, 'down');
});

test('la recuperación no avisa si nunca se había alertado la caída', () => {
    // Camino feliz de un restart: nunca estuvo en estado "alertado".
    const d = sweep({ registry: REG, observed: todosVivos(), dedupState: { down: {} }, now: T0 });
    assert.deepStrictEqual(d.recovered, []);
});

// ---------------------------------------------------------------------------
// Componentes NO supervisados: se registran, no alertan ni se relanzan.
// ---------------------------------------------------------------------------

test('outbox-drain y svc-emulador muertos no alertan ni se relanzan', () => {
    const obs = todosVivos();
    obs['outbox-drain'] = { alive: false };
    obs['svc-emulador'] = { alive: false };

    const d = sweep({ registry: REG, observed: obs, dedupState: null, now: T0 });
    assert.deepStrictEqual(d.alerts, [], 'outbox-drain se auto-mata con el Pulpo vivo: alertarlo es falso positivo diario');
    assert.deepStrictEqual(d.relaunch, [], 'relanzar outbox-drain con el Pulpo vivo sería un loop');
    assert.deepStrictEqual(d.nextDedupState, { down: {} });
});

// ---------------------------------------------------------------------------
// CA-4 — "vivo pero mudo": sólo se registra.
// ---------------------------------------------------------------------------

test('CA-4: un servicio vivo con el log frío se reporta como quiet, sin alertar', () => {
    const d = sweep({
        registry: REG,
        observed: todosVivos(),
        dedupState: null,
        now: T0,
        quietThresholdMs: 24 * HORA,
        logAges: { 'pulpo': 30 * HORA, 'svc-reconciler': HORA },
    });
    assert.deepStrictEqual(d.alerts, [], 'no escala a alerta (evita falsos positivos)');
    assert.strictEqual(d.quiet.length, 1);
    assert.strictEqual(d.quiet[0].service, 'pulpo');
    assert.ok(d.quiet[0].texto.includes('día'));
});

test('un servicio sin log no se reporta como mudo', () => {
    // logs/outbox-drain.log directamente no existe: la ausencia no es señal.
    const d = sweep({ registry: REG, observed: todosVivos(), dedupState: null, now: T0, logAges: {} });
    assert.deepStrictEqual(d.quiet, []);
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

test('todo componente del registro canónico tiene un impacto redactado', () => {
    for (const c of stale.COMPONENT_REGISTRY) {
        const txt = impactoDe(c.name);
        assert.ok(txt && txt.length > 10, 'falta el impacto de ' + c.name);
        assert.notStrictEqual(txt, impactoDe('__inexistente__'), c.name + ' cae al texto genérico');
    }
});

test('textoDuracion no miente con valores raros', () => {
    assert.strictEqual(textoDuracion(NaN), 'hace un rato');
    assert.strictEqual(textoDuracion(-1), 'hace un rato');
    assert.strictEqual(textoDuracion(1000), 'recién');
    assert.strictEqual(textoDuracion(90 * 60 * 1000), 'hace 1 hora');
    assert.strictEqual(textoDuracion(49 * HORA), 'hace 2 días');
});

test('normalizeDedup descarta entradas sin firstSeenTs usable', () => {
    const n = normalizeDedup({ down: { a: { firstSeenTs: 0 }, b: { firstSeenTs: T0, alerted: true }, c: 'x' } });
    assert.deepStrictEqual(Object.keys(n.down), ['b']);
});

test('un registro vacío no rompe ni inventa alertas', () => {
    const d = sweep({ registry: [], observed: {}, dedupState: null, now: T0 });
    assert.deepStrictEqual(d.alerts, []);
    assert.deepStrictEqual(d.relaunch, []);
});
