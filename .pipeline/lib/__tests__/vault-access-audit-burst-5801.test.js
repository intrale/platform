// Tests del umbral de ráfaga del vault (#5801).
// node --test
//
// Viven en un archivo propio y no dentro de `vault-access-audit.test.js`
// porque afirman sobre una decisión distinta: aquel cubre el registro y el copy
// del auditor (#5340), este cubre QUÉ se cuenta para decidir una ráfaga y qué
// pasa cuando el umbral no es un número válido.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyChain, readAll } = require('../audit-log');
const audit = require('../vault-access-audit');
const { VAULT_TELEMETRY_CATEGORIES } = require('../secret-vault');

const NOW = new Date('2026-08-03T12:00:00.000Z');
const EXPECTED = 'arn:aws:iam::123456789012:role/intrale-host-a';

/** Entrada del Event history: una lectura FÍSICA exitosa del vault. */
function physicalRead(n) {
    const detail = {
        eventTime: '2026-08-03T11:59:00Z',
        eventName: 'GetParameter',
        userIdentity: { arn: EXPECTED },
        requestParameters: { name: '/intrale/project/shared/providers' },
    };
    return {
        EventId: `physical-${n}`,
        EventName: detail.eventName,
        EventTime: detail.eventTime,
        CloudTrailEvent: JSON.stringify(detail),
    };
}

/** Entrada del Event history que NO leyó ningún secreto. */
function denied(n) {
    const detail = {
        eventTime: '2026-08-03T11:59:00Z',
        eventName: 'GetParameter',
        userIdentity: { arn: EXPECTED },
        errorCode: 'AccessDenied',
        requestParameters: null,
    };
    return {
        EventId: `denied-${n}`,
        EventName: detail.eventName,
        EventTime: detail.eventTime,
        CloudTrailEvent: JSON.stringify(detail),
    };
}

/** Evento del rastro LOCAL del vault: `{category, ts_ms}` (#5803). */
function telemetry(category, n = 0) {
    return { category, ts_ms: NOW.getTime() - n };
}

function config(overrides = {}) {
    return {
        expected_principals: [EXPECTED],
        cooldown_min: 10,
        lookback_min: 30,
        burst_threshold: 12,
        ...overrides,
    };
}

const esRafaga = (f) => f && f.causa === 'RAFAGA_DE_LECTURAS';

// --- 1 · fronteras del umbral ----------------------------------------------

test('#5801 fronteras: threshold-1 y threshold no alertan, threshold+1 sí', () => {
    const umbral = 5;
    const evaluar = (cantidad) => audit.evaluateAccessEvents({
        now: NOW,
        events: Array.from({ length: cantidad }, (_, i) => physicalRead(i)),
        state: {},
        config: config({ burst_threshold: umbral }),
    });

    const debajo = evaluar(umbral - 1);
    assert.equal(debajo.counters.physical_read, umbral - 1);
    assert.ok(!debajo.notifications.some(esRafaga));

    // El conteo IGUAL al umbral es carga normal: la comparación es estricta.
    // Con `>=`, un umbral calibrado desde el pico alertaría en el pico mismo,
    // o sea justo en la carga que la calibración declaró normal.
    const enElUmbral = evaluar(umbral);
    assert.equal(enElUmbral.counters.physical_read, umbral);
    assert.ok(!enElUmbral.notifications.some(esRafaga));

    const encima = evaluar(umbral + 1);
    assert.equal(encima.counters.physical_read, umbral + 1);
    assert.ok(encima.notifications.some(esRafaga));
});

// --- 2 · exclusividad de `physical_read` ------------------------------------

test('#5801 cache hits y joins no mueven el contador físico ni el veredicto', () => {
    const umbral = 3;
    const ruido = [];
    for (let i = 0; i < 50; i += 1) {
        ruido.push(telemetry('cache_hit', i), telemetry('single_flight_join', i));
    }
    const result = audit.evaluateAccessEvents({
        now: NOW,
        // Tres lecturas físicas (= umbral, no alerta) ahogadas en 100 eventos
        // que NO son tráfico físico: si uno solo se colara al numerador, este
        // caso alertaría.
        events: [...ruido, physicalRead(1), physicalRead(2), physicalRead(3)],
        state: {},
        config: config({ burst_threshold: umbral }),
    });
    assert.equal(result.counters.physical_read, 3);
    assert.equal(result.counters.cache_hit, 50);
    assert.equal(result.counters.single_flight_join, 50);
    assert.ok(!result.notifications.some(esRafaga));
    assert.equal(result.burst.umbral, umbral);
    // Tampoco produjeron registro de acceso: no hubo llamada a AWS que auditar.
    assert.equal(result.records.length, 3);
});

test('#5801 una lectura física de más sobre el mismo ruido sí alerta', () => {
    const ruido = Array.from({ length: 40 }, (_, i) => telemetry('cache_hit', i));
    const result = audit.evaluateAccessEvents({
        now: NOW,
        events: [...ruido, ...[1, 2, 3, 4].map(physicalRead)],
        state: {},
        config: config({ burst_threshold: 3 }),
    });
    assert.equal(result.counters.physical_read, 4);
    assert.ok(result.notifications.some(esRafaga));
});

test('#5801 un rechazo de autorización no es una lectura física', () => {
    const result = audit.evaluateAccessEvents({
        now: NOW,
        events: [1, 2, 3].map(denied),
        state: {},
        config: config({ burst_threshold: 2, authorization_failure_threshold: 3 }),
    });
    // Un `AccessDenied` no leyó ningún secreto. Ese tráfico ya tiene su propio
    // control (`authorization_failure_threshold`); contarlo también como
    // volumen convertía un pico de rechazos en una alerta que no describía
    // nada real y ocultaba el diagnóstico verdadero.
    assert.equal(result.counters.physical_read, 0);
    assert.ok(!result.notifications.some(esRafaga));
    assert.ok(result.notifications.some((n) => n.causa === 'AUTORIZACION_RECHAZADA'));
});

// --- 3 · eventos inválidos --------------------------------------------------

test('#5801 eventos desconocidos o malformados se rechazan y nunca se reclasifican', () => {
    const invalidos = [
        null,
        'physical_read',
        42,
        [],
        {},
        { category: 'physical_reads' },  // typo del vocabulario
        { category: 'PHYSICAL_READ' },   // el enum es case-sensitive
        { category: '' },
        { category: null },
        { category: 7 },
        { category: true },
        { ts_ms: NOW.getTime() },        // telemetría sin categoría
    ];
    const result = audit.evaluateAccessEvents({
        now: NOW,
        events: invalidos,
        state: {},
        config: config({ burst_threshold: 1 }),
    });
    assert.equal(result.counters.physical_read, 0);
    assert.equal(result.counters.cache_hit, 0);
    assert.equal(result.counters.single_flight_join, 0);
    assert.equal(result.counters.rechazados, invalidos.length);
    assert.ok(!result.notifications.some(esRafaga));
    assert.equal(result.records.length, 0);
});

// --- 4 · el umbral no admite coerción ---------------------------------------

test('#5801 R3 · cada clase inválida del umbral hace LANZAR al evaluador', () => {
    const invalidos = [
        undefined, null, 0, -1, 1.5, '12', '', true, false,
        NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 2, {}, [], [12],
    ];
    for (const valor of invalidos) {
        assert.equal(audit.readBurstThreshold(valor), null,
            `readBurstThreshold debe rechazar ${String(valor)}`);
        // Regresión EXPLÍCITA del fail-OPEN (R3): antes, `Number(cfg.burst_threshold
        // || 0)` más el guard `> 0` hacían que estas clases evaluaran SIN alertar,
        // o sea un control apagado indistinguible de «no hubo ráfaga». Ahora no
        // pasa ninguna de las dos cosas: se lanza.
        assert.throws(
            () => audit.evaluateAccessEvents({
                now: NOW,
                events: Array.from({ length: 20 }, (_, i) => physicalRead(i)),
                state: {},
                config: config({ burst_threshold: valor }),
            }),
            (err) => {
                assert.match(err.message, /burst_threshold/);
                assert.match(err.message, /entero positivo/);
                // El mensaje nombra la CLAVE y la condición, nunca el valor
                // recibido (que es configuración del vault).
                assert.doesNotMatch(err.message, /12|1\.5|Infinity/);
                return true;
            },
            `burst_threshold ${String(valor)} debe hacer lanzar al evaluador`,
        );
    }
    assert.equal(audit.readBurstThreshold(1), 1);
    assert.equal(audit.readBurstThreshold(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

test('#5801 R3 · el tick propaga el umbral inválido en vez de degradar a «no hay ráfaga»', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-audit-umbral-'));
    // El pulpo envuelve el tick en `try/catch` y registra el mensaje
    // (`pulpo.js` · "Tick excepción no capturada"), así que propagar NO tumba el
    // pipeline: lo deja ruidoso, que es lo contrario del silencio del fail-OPEN.
    assert.throws(() => audit.runAccessAuditTick({
        pipelineDir: dir,
        statePath: path.join(dir, 'state.json'),
        auditPath: path.join(dir, 'audit.jsonl'),
        now: NOW,
        config: { enabled: true, ...config({ burst_threshold: 0 }) },
        lookupEvents: () => JSON.stringify({ Events: [] }),
    }), /burst_threshold/);
});

// --- 5 · detección auditable, cooldown y sink caído -------------------------

test('#5801 el cooldown suprime el aviso pero la detección queda en el rastro', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-audit-cooldown-'));
    const auditPath = path.join(dir, 'audit.jsonl');
    const statePath = path.join(dir, 'state.json');
    const opts = (ids) => ({
        pipelineDir: dir,
        statePath,
        auditPath,
        now: NOW,
        config: { enabled: true, ...config({ burst_threshold: 1 }) },
        lookupEvents: (eventName) => JSON.stringify({
            Events: eventName === 'GetParameter' ? ids.map(physicalRead) : [],
        }),
        sendTelegramFn: () => {},
    });

    const primera = audit.runAccessAuditTick(opts([1, 2]));
    assert.ok(primera.notifications.some(esRafaga));

    // Segunda pasada DENTRO del cooldown, con eventos nuevos (ids distintos):
    // la ráfaga sigue ocurriendo y el operador no recibe el aviso repetido.
    const segunda = audit.runAccessAuditTick(opts([3, 4]));
    assert.ok(!segunda.notifications.some(esRafaga),
        'el cooldown debe suprimir el aviso duplicado');
    const suprimida = segunda.detections.find(esRafaga);
    assert.ok(suprimida, 'la detección debe existir aunque no se notifique');
    assert.equal(suprimida.notificada, false);

    // Y quedó en el rastro encadenado: eso es lo que hace auditable la
    // supresión, e impide que silenciar el canal borre las ráfagas siguientes.
    assert.equal(verifyChain(auditPath).ok, true);
    const detecciones = readAll(auditPath)
        .filter((e) => e.event_name === 'VaultAuditDetection' && e.causa === 'RAFAGA_DE_LECTURAS');
    assert.equal(detecciones.length, 2);
    assert.deepEqual(detecciones.map((d) => d.notificada), [true, false]);
    assert.equal(detecciones[1].umbral, 1);
    assert.equal(detecciones[1].lecturas_fisicas, 2);
});

test('#5801 un canal caído no revierte ni borra la detección registrada', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-audit-sink-'));
    const auditPath = path.join(dir, 'audit.jsonl');
    const result = audit.runAccessAuditTick({
        pipelineDir: dir,
        statePath: path.join(dir, 'state.json'),
        auditPath,
        now: NOW,
        config: { enabled: true, ...config({ burst_threshold: 1 }) },
        lookupEvents: (eventName) => JSON.stringify({
            Events: eventName === 'GetParameter' ? [1, 2, 3].map(physicalRead) : [],
        }),
        sendTelegramFn: () => { throw new Error('canal caido'); },
    });
    assert.ok((result.errors || []).some((e) => e.stage === 'send-telegram'));
    assert.equal(verifyChain(auditPath).ok, true);
    const entradas = readAll(auditPath);
    const deteccion = entradas.find((e) => e.causa === 'RAFAGA_DE_LECTURAS');
    assert.ok(deteccion, 'la detección se registra ANTES de intentar notificar');
    assert.equal(deteccion.notificada, true);
    assert.ok(entradas.some((e) => e.evidencia === 'NOTIFICACION_NO_ENVIADA'));
    // El error del canal nunca viaja al rastro.
    assert.equal(JSON.stringify(entradas).includes('canal caido'), false);
});

// --- 6 · copy del operador --------------------------------------------------

test('#5801 la alerta de ráfaga nombra conteo, umbral, ventana y unidades', () => {
    const finding = {
        causa: 'RAFAGA_DE_LECTURAS',
        scope_logico: 'vault',
        lecturas_fisicas: 9,
        umbral: 4,
        ventana_min: 30,
        unidad: audit.BURST_UNIT,
        contexto: { cache_hit: 71, single_flight_join: 5 },
    };
    const msg = audit.formatAccessAlert([finding], 'vault-abc-123');
    assert.match(msg, /Lecturas fisicas \(physical_read\): 9/);
    assert.match(msg, /Umbral configurado: 4 physical_read\/ventana/);
    assert.match(msg, /Ventana evaluada: 30 minutos/);
    // `cache_hit` y `single_flight_join` aparecen como contexto, distinguibles
    // y etiquetados como lo que NO cuenta para el umbral.
    assert.match(msg, /NO cuenta para el umbral: cache_hit=71, single_flight_join=5/);
    // Se entiende en texto plano y el diagnóstico va DESPUÉS de la acción.
    assert.ok(msg.indexOf('Qué hacer:') < msg.indexOf('Lecturas fisicas'));
    assert.doesNotMatch(msg, /arn:aws|\b\d{12}\b/);
});

// --- 7 · vocabulario único --------------------------------------------------

test('#5801 el vocabulario sale del enum del vault, no de literales propios', () => {
    const result = audit.evaluateAccessEvents({
        now: NOW, events: [], state: {}, config: config(),
    });
    for (const categoria of VAULT_TELEMETRY_CATEGORIES) {
        assert.equal(result.counters[categoria], 0, `falta el contador ${categoria}`);
    }
    // El primer elemento del enum es, por contrato, la categoría física.
    assert.equal(VAULT_TELEMETRY_CATEGORIES[0], 'physical_read');
    assert.equal(audit.classifyAccessEvent(telemetry('cache_hit')).category, 'cache_hit');
    assert.equal(audit.classifyAccessEvent(telemetry('physical_read')).kind, 'telemetry');
    assert.equal(audit.classifyAccessEvent(physicalRead(1)).kind, 'cloudtrail');
    assert.equal(audit.classifyAccessEvent({ category: 'otra' }).kind, 'rejected');

    // El módulo NO reescribe los literales del vocabulario: los importa.
    const fuente = fs.readFileSync(path.join(__dirname, '..', 'vault-access-audit.js'), 'utf8');
    assert.match(fuente, /require\('\.\/secret-vault'\)/);
});

// --- 8 · D2 · la unidad del umbral es la VENTANA, no el tick -----------------

test('#5801 D2 · el veredicto de ráfaga no depende del dedupe cross-tick', () => {
    const umbral = 5;
    const events = Array.from({ length: umbral + 1 }, (_, i) => physicalRead(i));

    // Primer tick: estado limpio. Los 6 eventos son nuevos.
    const primero = audit.evaluateAccessEvents({
        now: NOW, events, state: {}, config: config({ burst_threshold: umbral }),
    });
    assert.equal(primero.counters.physical_read, umbral + 1);
    assert.ok(primero.notifications.some(esRafaga));
    assert.equal(primero.records.length, umbral + 1);

    // Segundo tick: el MISMO lote con un `state` que ya vio TODOS los eventos.
    // El umbral está expresado en `physical_read` por ventana de `lookback_min`,
    // así que el conteo tiene que seguir siendo el de la ventana. Antes de D2 el
    // incremento vivía después del `continue` del dedupe: acá habría dado 0 y la
    // ráfaga habría desaparecido sola mientras el tráfico seguía adentro de la
    // ventana — el mismo umbral comparado contra dos denominadores distintos
    // (~`poll_interval_min` en régimen, `lookback_min` tras un reset de estado).
    const segundo = audit.evaluateAccessEvents({
        now: NOW,
        events,
        state: primero.nextState,
        config: config({ burst_threshold: umbral }),
    });
    assert.equal(segundo.counters.physical_read, umbral + 1,
        'el conteo es de la ventana completa, no de los eventos nuevos del tick');
    assert.equal(segundo.burst.lecturas_fisicas, umbral + 1);
    // El dedupe cross-tick sigue gobernando el RASTRO: no se reescriben registros.
    assert.equal(segundo.records.length, 0);
    // …y la detección se vuelve a registrar, que es lo deseado: una ráfaga
    // sostenida no puede desaparecer del rastro por haber sido vista antes.
    assert.ok(segundo.detections.some(esRafaga));
});

test('#5801 D2 · el conteo físico deduplica DENTRO del lote', () => {
    // Las cinco consultas de `ACCESS_EVENT_NAMES` no deberían solaparse, pero el
    // numerador del umbral no puede depender de que no lo hagan: un mismo
    // `EventId` repetido en el lote cuenta UNA vez.
    const uno = physicalRead(1);
    const result = audit.evaluateAccessEvents({
        now: NOW,
        events: [uno, uno, uno, physicalRead(2)],
        state: {},
        config: config({ burst_threshold: 12 }),
    });
    assert.equal(result.counters.physical_read, 2);
});

test('#5801 D2 · dos ticks con la misma ráfaga: 2 detecciones, 1 notificación', () => {
    const umbral = 3;
    const events = Array.from({ length: umbral + 2 }, (_, i) => physicalRead(i));
    const cfg = config({ burst_threshold: umbral, cooldown_min: 10 });

    const primero = audit.evaluateAccessEvents({ now: NOW, events, state: {}, config: cfg });
    const segundo = audit.evaluateAccessEvents({
        now: new Date(NOW.getTime() + 60 * 1000),
        events,
        state: primero.nextState,
        config: cfg,
    });

    // Registro auditable repetido: DESEADO. Notificación deduplicada por el
    // `cooldown_min`, que es quien decide si se vuelve a molestar al operador.
    assert.ok(primero.detections.some(esRafaga));
    assert.ok(segundo.detections.some(esRafaga));
    assert.equal(primero.notifications.filter(esRafaga).length, 1);
    assert.equal(segundo.notifications.filter(esRafaga).length, 0);
    assert.equal(segundo.detections.find(esRafaga).notificada, false);
});

// --- 9 · regresión del umbral calibrado y su acople con `lookback_min` -------

test('#5801 el config.yaml del repo trae el umbral calibrado y su ventana', () => {
    const yaml = require('js-yaml');
    const cfgRepo = yaml.load(fs.readFileSync(
        path.join(__dirname, '..', '..', 'config.yaml'), 'utf8'));
    const aa = cfgRepo.vault.access_audit;

    // El umbral está expresado en `physical_read` por ventana de `lookback_min`
    // minutos. Si alguien cambia la ventana sin recalcular el umbral, el control
    // se sobredimensiona (y se apaga de hecho) sin que nada lo avise: por eso los
    // dos se fijan JUNTOS, con la derivación completa.
    //
    //   peak_physical_reads_per_minute = 6      (corrida productiva de #5800)
    //   pico_ventana    = ceil(6 * 30)          = 180
    //   margen          = 1.0
    //   burst_threshold = ceil(180 * (1 + 1.0)) = 360
    const PICO_POR_MINUTO = 6;
    const MARGEN = 1.0;
    assert.equal(aa.lookback_min, 30);
    const picoVentana = Math.ceil(PICO_POR_MINUTO * aa.lookback_min);
    assert.equal(picoVentana, 180);
    assert.equal(aa.burst_threshold, Math.ceil(picoVentana * (1 + MARGEN)));
    assert.equal(aa.burst_threshold, 360);
    // CA-1 — el umbral SUPERA el pico observado convertido a la ventana.
    assert.ok(aa.burst_threshold > picoVentana);
    assert.ok(Number.isSafeInteger(aa.burst_threshold) && aa.burst_threshold > 0);

    // El TTL de la caché no se toca en esta entrega (regresión explícita).
    assert.equal(cfgRepo.vault.cache_ttl_seconds, 300);
});
