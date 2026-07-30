'use strict';

// =============================================================================
// kernel-config-cutover-5126.test.js — CA-B3 de #5126
//
// Protege el ESTADO INTERMEDIO del cutover: tablas y región cargadas, flag
// todavía apagado. Es un estado deliberado, y sin un test que lo fije se
// degrada de dos maneras opuestas:
//
//   1. Alguien enciende `durable: true` en un PR cualquiera. El encendido es una
//      operación supervisada del operador dentro de la ventana de cutover
//      (runbook §2), NO un cambio de configuración que viaja en un diff. Con las
//      tablas ya cargadas, un `true` de más ya no falla fail-closed: arranca y
//      empieza a escribir a DynamoDB de verdad.
//   2. Alguien "limpia" las tablas de vuelta a "" y el encendido posterior falla
//      fail-closed sin razón aparente.
//
// El test NO valida los nombres literales de tabla (eso cambia por entorno):
// valida que estén cargados, que no haya material sensible, y que el flag esté
// apagado.
// =============================================================================

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.yaml');

function loadKernelSection() {
    const doc = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
    assert.ok(doc.kernel && typeof doc.kernel === 'object', 'falta la sección kernel en config.yaml');
    return doc.kernel;
}

test('#5126 CA-B3 · las tres claves del store durable están cargadas', () => {
    const k = loadKernelSection();

    for (const key of ['tableName', 'coordinationTableName', 'region']) {
        assert.equal(typeof k[key], 'string', `kernel.${key} debe ser string`);
        assert.ok(k[key].trim().length > 0,
            `kernel.${key} está vacío: normalizeConfig falla fail-closed al encender durable`);
    }

    // Las dos tablas son recursos distintos (#5124): la de coordinación es la
    // única que admite DeleteItem en la policy IAM. Si fueran la misma, el
    // release de un claim borraría ítems de la partición de no-repudio.
    assert.notEqual(k.tableName, k.coordinationTableName,
        'la tabla de no-repudio y la de coordinación no pueden ser la misma');
});

test('#5126 CA-B3 · durable sigue apagado: encenderlo es una operación supervisada, no un diff', () => {
    const k = loadKernelSection();

    // Estrictamente `false`, no falsy: el fail-closed de #4820 depende del
    // booleano exacto.
    assert.equal(k.durable, false,
        'kernel.durable debe seguir en false. Encenderlo es un paso del operador dentro de la ' +
        'ventana de cutover (docs/pipeline/runbook-cutover-durable.md §2), con paridad verificada antes.');
});

test('#5126 CA-B3 · la ventana de cutover está cerrada en régimen normal', () => {
    const k = loadKernelSection();

    // #5135 CA-1: `true` sólo durante el cutover. Dejarla abierta convierte
    // cualquier throttle transitorio de DynamoDB en un DoS de disparo trivial
    // contra el dispatch del pipeline.
    assert.equal(k.cutover_window, false,
        'kernel.cutover_window debe estar en false fuera del cutover');
});

test('#5126 CA-B2 · la sección kernel no filtra account-id, ARNs ni credenciales', () => {
    const k = loadKernelSection();
    const asText = JSON.stringify(k);

    assert.ok(!/\b\d{12}\b/.test(asText),
        'hay una secuencia de 12 dígitos en la sección kernel: el account-id NUNCA se commitea');
    assert.ok(!/arn:aws:/i.test(asText),
        'hay un ARN literal en la sección kernel: se arma en runtime a partir de tabla + región');
    assert.ok(!/\b(AKIA|ASIA)[A-Z0-9]{16}\b/.test(asText),
        'hay algo con forma de access key id en la sección kernel');

    // Las credenciales llegan SOLO por el scope `aws` del ambiente hijo.
    for (const forbidden of ['accessKeyId', 'secretAccessKey', 'access_key_id', 'secret_access_key']) {
        assert.ok(!Object.prototype.hasOwnProperty.call(k, forbidden),
            `kernel.${forbidden} no va en config.yaml: las credenciales vienen de build-child-env.js`);
    }
});
