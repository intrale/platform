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

test('#5801 cada clase inválida del umbral deja el control NO evaluado', () => {
    const invalidos = [
        undefined, null, 0, -1, 1.5, '12', '', true, false,
        NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 2, {}, [], [12],
    ];
    for (const valor of invalidos) {
        assert.equal(audit.readBurstThreshold(valor), null,
            `readBurstThreshold debe rechazar ${String(valor)}`);
        const result = audit.evaluateAccessEvents({
            now: NOW,
            events: Array.from({ length: 20 }, (_, i) => physicalRead(i)),
            state: {},
            config: config({ burst_threshold: valor }),
        });
        // Ni alerta (sería un umbral inventado) ni silencio (se leería como
        // «no hay ráfaga»): el control queda DECLARADO como no evaluado, con
        // el motivo que nombra la clave y la condición esperada.
        assert.equal(result.burst.evaluado, false);
        assert.equal(result.burst.umbral, null);
        assert.match(result.burst.motivo, /burst_threshold/);
        assert.ok(!result.notifications.some(esRafaga));
        // El conteo físico se sigue midiendo: lo que falta es contra qué
        // compararlo, no el dato.
        assert.equal(result.counters.physical_read, 20);
    }
    assert.equal(audit.readBurstThreshold(1), 1);
    assert.equal(audit.readBurstThreshold(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

test('#5801 el tick reporta el umbral inválido en vez de degradar a «no hay ráfaga»', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-audit-umbral-'));
    const result = audit.runAccessAuditTick({
        pipelineDir: dir,
        statePath: path.join(dir, 'state.json'),
        auditPath: path.join(dir, 'audit.jsonl'),
        now: NOW,
        config: { enabled: true, ...config({ burst_threshold: 0 }) },
        lookupEvents: () => JSON.stringify({ Events: [] }),
    });
    const fallo = (result.errors || []).find((e) => e.stage === 'burst-threshold');
    assert.ok(fallo, 'el tick debe declarar que la ráfaga no se evaluó');
    assert.match(fallo.message, /entero seguro positivo/);
    // El motivo nombra la clave y la condición, no el valor configurado.
    assert.doesNotMatch(fallo.message, /\b0\b/);
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
