// Tests del backoff de cadena agotada (incidente 2026-09-08).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const backoff = require('../lib/dispatch-backoff');

function tmpPipeline() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-backoff-'));
}

test('sin agotamientos previos no hay espera', () => {
    const dir = tmpPipeline();
    assert.deepEqual(backoff.estaEsperando(dir, 'ux', 5801), { esperando: false, restanteMin: 0 });
});

test('el primer agotamiento programa 1 minuto y bloquea el reintento inmediato', () => {
    const dir = tmpPipeline();
    const t0 = Date.now();

    const r = backoff.registrarCadenaAgotada(dir, 'ux', 5801, { now: t0 });
    assert.equal(r.esperaMin, 1);
    assert.equal(r.consecutivos, 1);

    // El tick siguiente del Pulpo llega 30 segundos después: debe encontrarlo esperando.
    assert.equal(backoff.estaEsperando(dir, 'ux', 5801, { now: t0 + 30_000 }).esperando, true);
    // Pasado el minuto, se puede volver a intentar.
    assert.equal(backoff.estaEsperando(dir, 'ux', 5801, { now: t0 + 61_000 }).esperando, false);
});

test('agotamientos consecutivos duplican la espera hasta el techo de 15 minutos', () => {
    const dir = tmpPipeline();
    const t0 = Date.now();
    const esperas = [];
    for (let i = 0; i < 8; i++) {
        esperas.push(backoff.registrarCadenaAgotada(dir, 'guru', 6239, { now: t0 }).esperaMin);
    }
    assert.deepEqual(esperas, [1, 2, 4, 8, 15, 15, 15, 15]);
});

test('un despacho efectivo limpia la cuenta', () => {
    const dir = tmpPipeline();
    const t0 = Date.now();
    backoff.registrarCadenaAgotada(dir, 'po', 6191, { now: t0 });
    backoff.registrarCadenaAgotada(dir, 'po', 6191, { now: t0 });
    assert.equal(backoff.limpiar(dir, 'po', 6191), true);
    assert.equal(backoff.estaEsperando(dir, 'po', 6191, { now: t0 }).esperando, false);
    // Y el próximo agotamiento vuelve a empezar por 1 minuto.
    assert.equal(backoff.registrarCadenaAgotada(dir, 'po', 6191, { now: t0 }).esperaMin, 1);
});

test('el backoff es por (skill, issue): no se contagia entre corridas', () => {
    const dir = tmpPipeline();
    const t0 = Date.now();
    backoff.registrarCadenaAgotada(dir, 'ux', 5801, { now: t0 });
    assert.equal(backoff.estaEsperando(dir, 'ux', 5801, { now: t0 }).esperando, true);
    assert.equal(backoff.estaEsperando(dir, 'ux', 6239, { now: t0 }).esperando, false);
    assert.equal(backoff.estaEsperando(dir, 'po', 5801, { now: t0 }).esperando, false);
});

test('la noche del incidente: 10 horas con la cadena caída producen decenas de intentos, no miles', () => {
    // Replica la madrugada real: Anthropic apagado 20:00-07:00 y ningún fallback
    // de pie. El Pulpo tickea cada 30 s. Medimos cuántas veces habría llegado a
    // intentar el despacho con el backoff puesto.
    const dir = tmpPipeline();
    const TICK_MS = 30_000;
    const DIEZ_HORAS_MS = 10 * 60 * 60 * 1000;
    let intentos = 0;

    for (let t = 0; t <= DIEZ_HORAS_MS; t += TICK_MS) {
        if (backoff.estaEsperando(dir, 'pipeline-dev', 5801, { now: t }).esperando) continue;
        intentos++;
        backoff.registrarCadenaAgotada(dir, 'pipeline-dev', 5801, { now: t });
    }

    // Sin backoff serían 1200 ticks = 1200 intentos. Con el techo de 15 min, ~44.
    assert.ok(intentos < 60, `esperaba menos de 60 intentos en la noche, hubo ${intentos}`);
    assert.ok(intentos > 5, `pero tampoco debe dejar de intentar del todo: hubo ${intentos}`);

    const sinBackoff = DIEZ_HORAS_MS / TICK_MS;
    const reduccion = 1 - intentos / sinBackoff;
    assert.ok(reduccion > 0.9, `la reducción debe superar el 90%, fue ${(reduccion * 100).toFixed(1)}%`);
});

test('un archivo de estado corrupto no frena el despacho', () => {
    const dir = tmpPipeline();
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'dispatch-backoff.json'), '{roto', 'utf8');
    assert.equal(backoff.estaEsperando(dir, 'ux', 1).esperando, false);
});
