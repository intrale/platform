'use strict';

// #7635 · CA-7 / CA-8 — el `.pipeline/env-exceptions.yaml` REAL del repo declara
// cada servicio de confianza del inventario, vigente y con fundamento.
//
// Si este test se pone rojo porque una fecha venció, es a propósito: la
// excepción hay que revisarla y renovarla con un PR que el operador mergea a
// mano (gate de permisos). No se "arregla" corriendo la fecha en el test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const ex = require('../child-env-exceptions');

const SERVICIOS = Object.freeze(['envDeHijo', 'envDeServicio', 'adbEnv', 'builder', 'vault', 'notificadores']);

test('CA-7 · el YAML real carga sin error y sin entradas descartadas', () => {
    const r = ex.loadExceptions();
    assert.equal(r.error, null);
    assert.deepEqual(r.descartadas, []);
});

test('CA-7 · cada servicio de confianza tiene su excepción vigente, con fundamento', () => {
    const r = ex.loadExceptions();
    for (const s of SERVICIOS) {
        const propias = r.vigentes.filter((e) => e.tipo === 'servicio' && e.rol === s);
        assert.equal(propias.length >= 1, true, `falta la excepción vigente de ${s}`);
        for (const e of propias) {
            assert.ok(typeof e.fundamento === 'string' && e.fundamento.trim().length > 0, `${s}: fundamento vacío`);
            assert.ok(ex.fechaValida(e.revisar_el), `${s}: revisar_el inválido`);
        }
    }
    // Ninguna de las del inventario vencida.
    assert.deepEqual(r.vencidas.filter((e) => SERVICIOS.includes(e.rol)).map((e) => e.rol), []);
});

test('CA-7 · el archivo real no declara excepciones de agente (sólo el inventario de servicios)', () => {
    const r = ex.loadExceptions();
    assert.deepEqual(r.vigentes.filter((e) => e.tipo === 'agente'), []);
});

test('CA-8 · la cabecera explica cómo agregar, aprobador declarativo, reservadas y tope de 180 días', () => {
    const texto = fs.readFileSync(ex.DEFAULT_FILE, 'utf8');
    const cabecera = texto.split(/\r?\n/).filter((l) => l.startsWith('#')).join('\n');
    for (const campo of ['tipo:', 'rol:', 'variable:', 'scope:', 'fundamento:', 'aprobador:', 'revisar_el:']) {
        assert.ok(cabecera.includes(campo), `ejemplo sin ${campo}`);
    }
    assert.match(cabecera, /DECLARATIVO/);
    assert.match(cabecera, /gate de permisos/);
    assert.match(cabecera, /AWS, GitHub, keys de providers ni Telegram/);
    assert.match(cabecera, /180 días/);
});
