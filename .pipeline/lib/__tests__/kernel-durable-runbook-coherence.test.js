// #5212 · Coherencia entre el guard fail-closed y el runbook que él mismo cita.
//
// El mensaje de aborto de `kernel-durable-config-guard.js` remite al runbook como
// destino UNICO de profundizacion ("Detalle: docs/pipeline/runbook-cutover-durable.md").
// Esa promesa se rompe en silencio de dos maneras:
//
//   1. El runbook deja de cubrir el caso `kernel.tableName` (antes de #5212 su unica
//      entrada de troubleshooting resolvia `coordinationTableName`, no este).
//   2. Alguien edita el mensaje del guard y el bloque citado en el runbook queda viejo.
//
// Ninguna de las dos rompe un test existente: el guard sigue pasando sus 61 casos y
// el runbook es markdown que nadie ejecuta. Este archivo ata las dos puntas.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
    DURABLE_CONFIG_ABORT_MESSAGE,
    DURABLE_CONFIG_EXIT_CODE,
} = require('../kernel-durable-config-guard.js');

const RUNBOOK_PATH = path.join(__dirname, '..', '..', '..', 'docs', 'pipeline', 'runbook-cutover-durable.md');
const runbook = fs.readFileSync(RUNBOOK_PATH, 'utf8');

/** Normaliza saltos de linea y espacios: el runbook wrapea, el guard no. */
const norm = (s) => s.replace(/\s+/g, ' ').trim();

/** La entrada de troubleshooting que el operador busca cuando el arranque aborta. */
const SECCION = '### "Encendí `kernel.durable` y el pipeline no arranca"';

function seccionTroubleshooting() {
    const desde = runbook.indexOf(SECCION);
    assert.notStrictEqual(desde, -1, `el runbook perdió la sección ${SECCION}`);
    // Hasta el proximo encabezado del mismo nivel.
    const resto = runbook.slice(desde + SECCION.length);
    const hasta = resto.indexOf('\n### ');
    return hasta === -1 ? resto : resto.slice(0, hasta);
}

test('#5212 · el runbook citado por el guard cubre el caso kernel.tableName', () => {
    const seccion = seccionTroubleshooting();
    assert.match(
        seccion,
        /kernel\.tableName/,
        'la entrada de troubleshooting no menciona kernel.tableName: el mensaje del ' +
        'guard manda al operador a un runbook que no resuelve su caso',
    );
});

test('#5212 · el mensaje citado en el runbook es EXACTAMENTE el que emite el guard', () => {
    const seccion = seccionTroubleshooting();
    const bloques = seccion.split('```');
    // Bloques impares = contenido cercado; buscamos el que arranca con el aborto.
    const citado = bloques.find((b, i) => i % 2 === 1 && b.includes('Arranque abortado'));
    assert.ok(citado, 'el runbook no cita el mensaje de aborto del guard');
    assert.strictEqual(
        norm(citado),
        norm(DURABLE_CONFIG_ABORT_MESSAGE),
        'el mensaje citado en el runbook divergió del que emite el guard: ' +
        'actualizá docs/pipeline/runbook-cutover-durable.md',
    );
});

test('#5212 · el runbook documenta el exit code real del guard', () => {
    const seccion = seccionTroubleshooting();
    assert.ok(
        seccion.includes(String(DURABLE_CONFIG_EXIT_CODE)),
        `el runbook no documenta el exit code ${DURABLE_CONFIG_EXIT_CODE} del guard`,
    );
});

test('#5212 · el runbook aclara que el mensaje NO distingue ausente/vacío/whitespace', () => {
    const seccion = seccionTroubleshooting();
    // El guard emite un mensaje constante a proposito (no vuelca config ni entorno).
    // Si el runbook no lo aclara, el operador cree que el texto le va a decir cual es.
    assert.match(seccion, /whitespace/i, 'el runbook no explica que el mensaje es constante');
});

test('#5212 · el runbook sigue apuntando a la tabla de no-repudio, no a la de coordinación', () => {
    const seccion = seccionTroubleshooting();
    // Las dos tablas conviven (§4 CA-0). Confundirlas es el error clasico.
    assert.match(seccion, /coordinationTableName/, 'se perdió la distinción con la tabla de coordinación');
    assert.match(seccion, /no-repudio/, 'el runbook no aclara cuál de las dos tablas nombrar');
});
