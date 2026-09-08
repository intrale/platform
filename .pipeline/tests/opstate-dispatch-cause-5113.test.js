'use strict';
//
// #5113 · CA-UX2 — "Causa propia, no anomalía".
//
// La contracara de un buen fail-closed es un mal síntoma. Con CA-A7 cumplido
// (el gate DENIEGA cuando el store del estado operativo no responde, y tiene
// prohibido degradar a filesystem), la cola queda ociosa sin que ningún gate
// conocido la explique. El resultado, sin esta causa, es que el operador lee
// "⚠ Anomalía: causa no determinable" exactamente en el momento en que la causa
// se conoce con precisión absoluta — el peor mensaje posible en el peor momento.
//
// Este archivo fija las dos mitades del circuito:
//   1. la DECISIÓN pura (`opstateDispatchGate`): cuándo el sustrato explica el
//      no-despacho y cuándo no;
//   2. la PUBLICACIÓN (`resolveCause`): que la causa marcada gana sobre la
//      anomalía y sobre `MODO_OLA`, y el caso negativo que demuestra que sin
//      ella se caía al fallback.
//
const test = require('node:test');
const assert = require('node:assert/strict');
const dc = require('../lib/dispatch-cause');

process.env.PULPO_NO_AUTOSTART = '1';
const { opstateDispatchGate } = require('../pulpo');

// ─── 1 · La decisión pura ────────────────────────────────────────────────────

test('CA-UX2: store remoto caído ⇒ el sustrato explica el no-despacho', () => {
    const r = opstateDispatchGate({
        mode: 'remote', source: 'config', degraded: true, lastError: 'timeout',
    });
    assert.equal(r.blocked, true);
    assert.match(r.detalle, /no responde/i);
    // CA-UX5 — el síntoma nombra la acción: el detalle tiene que decir cuál es
    // el próximo paso del operador, no sólo describir el error técnico.
    assert.match(r.detalle, /durable: false/);
    // Y tiene que dejar explícito que NO hubo degradación silenciosa a FS.
    assert.match(r.detalle, /no se degrada a filesystem/i);
    // La causa técnica concreta viaja adentro: sin ella el operador no puede
    // decidir entre reintentar y volver.
    assert.match(r.detalle, /timeout/);
});

test('CA-UX2: modo filesystem NUNCA bloquea, ni con un rastro viejo de degradación', () => {
    // En `fs` el estado se lee del disco local: una falla del store no frena
    // nada. Nombrar la causa acá sería inventar un culpable — el error opuesto
    // y exactamente igual de caro que la anomalía.
    const r = opstateDispatchGate({
        mode: 'fs', source: 'config', degraded: true, lastError: 'timeout',
    });
    assert.equal(r.blocked, false);
    assert.equal(r.detalle, '');
});

test('CA-UX2: store remoto SANO no declara causa (el flag encendido no es un síntoma)', () => {
    const r = opstateDispatchGate({
        mode: 'remote', source: 'config', degraded: false, lastError: null,
    });
    assert.equal(r.blocked, false);
});

test('CA-UX2: una descripción rota no bloquea el despacho (fail-open de la CAUSA)', () => {
    // El gate real es `isIssueAllowed`, que deniega por su cuenta. Si la
    // introspección del sustrato se rompe, lo que NO puede pasar es que el
    // pipeline se frene por un bug del cartel.
    for (const basura of [null, undefined, {}, 'remote', 42, []]) {
        assert.equal(opstateDispatchGate(basura).blocked, false, `entrada: ${JSON.stringify(basura)}`);
    }
});

test('CA-UX2: `degraded` sólo cuenta si es booleano true (nada de coerción)', () => {
    for (const casi of ['true', 1, 'sí', {}]) {
        const r = opstateDispatchGate({ mode: 'remote', degraded: casi });
        assert.equal(r.blocked, false, `degraded=${JSON.stringify(casi)} no debe bloquear`);
    }
});

// ─── 2 · La publicación de la causa ──────────────────────────────────────────

/** Snapshot mínimo de un ciclo sin despacho y con cola pendiente. */
function cicloOcioso(gates, detalles) {
    return {
        anyLaunched: false,
        hayPendientes: true,
        gatesActivos: new Set(gates),
        detalles: detalles || {},
    };
}

test('CA-UX2: con el store caído se publica la causa propia, NO la anomalía', () => {
    const gate = opstateDispatchGate({ mode: 'remote', degraded: true, lastError: 'NetworkError' });
    const causa = dc.resolveCause(
        cicloOcioso([dc.CAUSAS.ESTADO_REMOTO_DEGRADADO], {
            [dc.CAUSAS.ESTADO_REMOTO_DEGRADADO]: gate.detalle,
        }),
        1_000,
    );
    assert.equal(causa.causa, dc.CAUSAS.ESTADO_REMOTO_DEGRADADO);
    assert.equal(causa.anomalia, false);
    assert.notEqual(causa.causa, dc.CAUSAS.ANOMALIA);
    // El label que ve el operador tiene que traer la acción (CA-UX5).
    assert.match(causa.label, /rollback|filesystem|durable: false/i);
    // Y el shape tiene que ser persistible: el enum es cerrado y `publish`
    // valida antes de escribir el artifact.
    assert.doesNotThrow(() => dc.validateCause(causa));
});

test('CA-UX2 (caso negativo): sin la causa marcada, el mismo ciclo cae en `anomalia_no_determinable`', () => {
    // Éste es el bug que el CA existe para impedir. Si alguien saca el
    // `_dcMark` del brazo de lanzamiento, este test sigue verde y el de arriba
    // también — por eso el que manda es el de abajo, que ata las dos mitades.
    const causa = dc.resolveCause(cicloOcioso([]), 1_000);
    assert.equal(causa.causa, dc.CAUSAS.ANOMALIA);
    assert.equal(causa.anomalia, true);
});

test('CA-UX2: la decisión pura y la publicación están ATADAS (el marcado no es decorativo)', () => {
    // Recorre el circuito completo con el mismo `mark` que usa `brazoLanzamiento`:
    // describeMode → opstateDispatchGate → mark → resolveCause.
    const gates = new Map();
    const mark = (c, d) => { if (!gates.has(c)) gates.set(c, d); };

    const decision = opstateDispatchGate({ mode: 'remote', degraded: true, lastError: 'timeout' });
    if (decision.blocked) mark(dc.CAUSAS.ESTADO_REMOTO_DEGRADADO, decision.detalle);

    const causa = dc.resolveCause({
        anyLaunched: false,
        hayPendientes: true,
        gatesActivos: new Set(gates.keys()),
        detalles: Object.fromEntries(gates),
    }, 1_000);

    assert.equal(causa.causa, dc.CAUSAS.ESTADO_REMOTO_DEGRADADO);
    assert.match(causa.detalle, /no responde/i);
});

test('CA-UX2: la causa del sustrato GANA sobre `MODO_OLA` (un fail-closed no es "modo ola")', () => {
    // `MODO_OLA` es una causa SILENCIOSA: si la degradación del store se
    // mapeara ahí, una falla real de infraestructura se pintaría como estado
    // esperado y no alertaría a nadie.
    const causa = dc.resolveCause(
        cicloOcioso([dc.CAUSAS.MODO_OLA, dc.CAUSAS.ESTADO_REMOTO_DEGRADADO]),
        1_000,
    );
    assert.equal(causa.causa, dc.CAUSAS.ESTADO_REMOTO_DEGRADADO);
});

test('CA-UX2: la causa del sustrato es ALERTABLE (no puede ser silenciosa)', () => {
    assert.ok(
        dc.CAUSAS_ALERTABLES.has(dc.CAUSAS.ESTADO_REMOTO_DEGRADADO),
        'la degradación del estado operativo tiene que alertar: es una falla de infra, no un estado esperado',
    );
});

test('CA-UX2: un deadlock real sigue explicando mejor el no-despacho', () => {
    // El orden dentro de PRECEDENCIA no es cosmético: si coexisten, el deadlock
    // del gate predictivo es la causa más informativa.
    const causa = dc.resolveCause(
        cicloOcioso([dc.CAUSAS.ESTADO_REMOTO_DEGRADADO, dc.CAUSAS.DEADLOCK]),
        1_000,
    );
    assert.equal(causa.causa, dc.CAUSAS.DEADLOCK);
});

// ─── 3 · Las DOS superficies que ve el operador (CA-UX5) ─────────────────────
//
// Rebote rev-1: el QA rechazó "enum sin productor" — la causa estaba declarada
// en `CAUSAS`, `PRECEDENCIA`, `LABELS` y `CAUSAS_ALERTABLES`, y nadie la emitía.
// El productor ya existe (`_dcMark` en el brazo de lanzamiento del Pulpo, sobre
// `describeMode().degraded`), pero eso solo no basta como control: una causa que
// se marca y no llega al tablero ni a Telegram es indistinguible de una que no
// se marca. Las aserciones de arriba paran en `resolveCause`; estas dos recorren
// el camino REAL hasta el texto que el operador lee, que es exactamente lo que
// el QA verificó a mano.
//
// Por qué son dos superficies y no una: el banner sale de `dispatch-cause`
// (label del enum) y el aviso de Telegram sale de `wave-stall-watchdog`
// (`CAUSE_LABELS`, indexado por el `kind` que traduce `dispatch-cause-kind`).
// Son tres tablas distintas y agregar la causa a una sola es el modo de falla
// natural: el tablero explica y Telegram sigue diciendo "sin causa declarada".

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dcKind = require('../lib/dispatch-cause-kind');
const dcRender = require('../lib/dispatch-cause-render');
const slices = require('../lib/dashboard-slices');
const stallWatchdog = require('../lib/wave-stall-watchdog');

/** Causa publicada por el camino real, tal como la deja el Pulpo en disco. */
function publicarCausaDelSustrato(dir) {
    const gate = opstateDispatchGate({
        mode: 'remote', source: 'config', degraded: true, lastError: 'ETIMEDOUT',
    });
    const resolved = dc.resolveCause(
        cicloOcioso([dc.CAUSAS.ESTADO_REMOTO_DEGRADADO], {
            [dc.CAUSAS.ESTADO_REMOTO_DEGRADADO]: gate.detalle,
        }),
        Date.now(),
    );
    dc.writeArtifact(dir, resolved);
    return resolved;
}

function enTmp(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opstate-ux5-5113-'));
    try { return fn(dir); } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

test('CA-UX5: el TABLERO explica el sustrato — no "causa no determinable"', () => enTmp((dir) => {
    publicarCausaDelSustrato(dir);

    const slice = slices.dispatchCauseSlice({}, { PIPELINE: dir });
    assert.equal(slice.active, true, 'el banner no se activó: el operador no ve nada');
    assert.equal(slice.causa, dc.CAUSAS.ESTADO_REMOTO_DEGRADADO);
    assert.equal(slice.anomalia, false);

    const html = dcRender.renderDispatchCauseBanner(slice);
    assert.doesNotMatch(html, /no determinable/i,
        'el tablero sigue mostrando la anomalía en el momento en que la causa se conoce exacto');
    assert.match(html, /remoto/i);
    // CA-UX5: el cartel trae el PRÓXIMO PASO, no sólo el diagnóstico.
    assert.match(html, /durable/i);
}));

test('CA-UX5: TELEGRAM nombra la causa — no "sin causa declarada"', () => enTmp((dir) => {
    publicarCausaDelSustrato(dir);

    // Camino real del watchdog: artifact en disco → `kind` → mensaje.
    const leido = dc.readArtifact(dir);
    const cause = dcKind.causeFromArtifact(leido);
    assert.notEqual(cause, null,
        'el enum quedó sin mapear a `kind`: el watchdog avisaría "no sé por qué no despacho"');
    assert.equal(cause.kind, 'opstate-remote-degraded');

    const msg = stallWatchdog.buildAlertMessage({
        waveKey: 10, stallMinutes: 45, enabledCount: 3, causeKind: cause.kind,
    });
    assert.doesNotMatch(msg, /sin causa declarada/,
        'el aviso de Telegram no nombra la causa: es el defecto del rebote rev-1');
    assert.match(msg, /estado operativo remoto no responde/i);
    assert.match(msg, /fail-closed/i);
}));

test('CA-UX5 (caso negativo): sin la entrada en CAUSE_LABELS el aviso degrada a slug crudo', () => {
    // Fija que la cobertura de Telegram NO es incidental. Si alguien saca la
    // causa de `CAUSE_LABELS`, `describeCause` devuelve el slug pelado y el
    // operador pierde la explicación — el test avisa antes que el incidente.
    assert.equal(
        stallWatchdog.describeCause('opstate-remote-degraded'),
        'estado operativo remoto no responde (dispatch denegado, fail-closed)',
    );
    assert.equal(stallWatchdog.describeCause(null), 'sin causa declarada');
});

// ─── 4 · El eslabón que faltaba: la FUENTE del descriptor (CA-UX2 / CA-C1) ───
//
// Rebote rev-1, segunda pasada. Los 14 casos de arriba entran por
// `opstateDispatchGate(descriptor)` con el descriptor ESCRITO A MANO
// (`{ mode: 'remote', degraded: true }`). Eso prueba la decisión, no la cadena:
// nadie verifica que `describeMode()` REALMENTE devuelva `degraded: true`
// cuando el store no responde.
//
// El hueco importa porque es el mismo modo de falla que produjo este rebote,
// corrido un eslabón: antes fue "enum sin productor" (la causa existía y nadie
// la marcaba); acá sería "productor sin fuente" — el gate marca, pero sobre un
// `degraded` que ya no se enciende. Alcanza con que alguien limpie
// `lastDegradation` en el catch, renombre el campo, o mueva la clasificación
// del error: los 14 tests siguen en verde y el operador vuelve a leer
// "anomalía: causa no determinable" en la degradación real.
//
// Estos dos casos arrancan donde arranca el hecho — una operación real contra
// un store caído — y bajan hasta el texto de las dos superficies. El control
// positivo (store sano) es el que impide el falso verde simétrico: un
// `degraded` clavado en `true` bloquearía el despacho para siempre, que es peor
// que no nombrar la causa.

const { createFakeSyncDynamoDriver } = require('../lib/__tests__/fixtures/fake-sync-dynamo-driver');
const { withEnv } = require('../lib/test-helpers/with-env');
const backend = require('../lib/operational-state-backend');

/**
 * Corre `fn` con el flag de cutover encendido y el sustrato apuntando a un
 * driver en memoria. Devuelve el driver para poder tumbarlo.
 */
function conStoreRemoto(fn) {
    return withEnv({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
        const driver = createFakeSyncDynamoDriver({});
        backend.invalidateConfigCache();
        backend.clearDegradation();
        // El sink se silencia a propósito: acá se verifica el SÍNTOMA que ve el
        // operador en el tablero, no el canal de Telegram (eso es CA-UX3).
        backend.setDegradationSink({ onDegraded() {} });
        backend._setDriverForTests({
            driver,
            spec: { type: 'dynamodb_table', tableName: 't', keys: [] },
            projectId: 'intrale-platform',
            instanceId: 'intrale-platform',
            atomicUpdate: true,
        });
        try {
            return fn(driver);
        } finally {
            backend._setDriverForTests(null);
            backend.clearDegradation();
            backend.setDegradationSink(null);
            backend.invalidateConfigCache();
        }
    });
}

test('CA-UX2: el store caído DE VERDAD enciende la causa, sin descriptor fabricado', () => enTmp((dir) => {
    const resuelta = conStoreRemoto((driver) => {
        // El hecho real: una lectura del estado operativo contra un store mudo.
        driver._setFailure(new Error('ProvisionedThroughputExceededException'));
        const leido = backend.readKey('waves');
        assert.equal(leido, null, 'con el store caído la lectura NO puede devolver estado');

        // La fuente, no una constante de test.
        const desc = backend.describeMode();
        assert.equal(desc.mode, 'remote');
        assert.equal(desc.degraded, true,
            'el sustrato no reporta degradación: el gate de CA-UX2 quedaría ciego y '
            + 'el ciclo volvería a caer en `anomalia_no_determinable`');

        const gate = opstateDispatchGate(desc);
        assert.equal(gate.blocked, true);

        const causa = dc.resolveCause(
            cicloOcioso([dc.CAUSAS.ESTADO_REMOTO_DEGRADADO], {
                [dc.CAUSAS.ESTADO_REMOTO_DEGRADADO]: gate.detalle,
            }),
            Date.now(),
        );
        dc.writeArtifact(dir, causa);
        return causa;
    });

    assert.equal(resuelta.causa, dc.CAUSAS.ESTADO_REMOTO_DEGRADADO);
    assert.equal(resuelta.anomalia, false);

    // Las dos superficies, desde el artifact que quedó en disco.
    const html = dcRender.renderDispatchCauseBanner(slices.dispatchCauseSlice({}, { PIPELINE: dir }));
    assert.doesNotMatch(html, /no determinable/i);

    const msg = stallWatchdog.buildAlertMessage({
        waveKey: null,
        stallMinutes: 45,
        enabledCount: 3,
        causeKind: dcKind.causeFromArtifact(dc.readArtifact(dir)).kind,
    });
    assert.doesNotMatch(msg, /sin causa declarada/);
    assert.match(msg, /estado operativo remoto no responde/i);
}));

test('CA-UX2 (control positivo): el store SANO no deja rastro de degradación', () => {
    conStoreRemoto(() => {
        // Sin fallas: la misma lectura, mismo flag, mismo driver.
        backend.readKey('waves');
        const desc = backend.describeMode();
        assert.equal(desc.mode, 'remote', 'el flag encendido tiene que dar modo remoto');
        assert.equal(desc.degraded, false,
            'un `degraded` clavado en true frenaría el despacho para siempre — '
            + 'el falso verde simétrico del caso de arriba');
        assert.equal(opstateDispatchGate(desc).blocked, false,
            'el flag encendido NO es un síntoma: sin degradación no se declara causa');
    });
});

// ─── 4 · El copy llega LITERAL al operador ───────────────────────────────────
//
// El banner del tablero escapa su texto (`dispatch-cause-render.js` usa
// `escapeHtmlText`) y no interpreta markdown: un backtick del label sale como
// backtick EN PANTALLA. El operador que está mirando por qué no despacha lee un
// adorno de código fuente en medio de la instrucción de rollback.
//
// Por eso los labels se escriben en texto plano. El QA marcó el caso concreto
// (la causa de #5113 nombraba el rollback entre backticks); el test lo fija
// para TODAS las causas, que es donde el defecto se vuelve a colar.
//
// El guion bajo NO entra en la lista: `operational_state.durable` es un
// identificador del config y tiene que leerse tal cual se escribe.

test('CA-UX5: ningún label de causa lleva adornos de markdown', () => {
    for (const [causa, label] of Object.entries(dc.LABELS)) {
        assert.equal(typeof label, 'string', `el label de ${causa} debe ser string`);
        assert.doesNotMatch(label, /[`*]/,
            `el label de "${causa}" trae adornos de markdown (${JSON.stringify(label)}): `
            + 'el banner escapa el texto y los renderiza literales');
    }
});

test('CA-UX5: el rollback se lee tal cual hay que escribirlo en el YAML', () => {
    const label = dc.LABELS[dc.CAUSAS.ESTADO_REMOTO_DEGRADADO];
    assert.match(label, /operational_state\.durable: false/,
        'el próximo paso tiene que aparecer con la sintaxis exacta del config');
    assert.doesNotMatch(label, /`/, 'sin backticks: el banner no interpreta markdown');
});
