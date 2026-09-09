// =============================================================================
// pulpo-aislamiento-prueba-7086.test.js — El pipeline PRODUCTIVO no recibe
// efectos de una corrida de prueba (#7086).
//
// Contexto (medido el 08/09/2026)
// -------------------------------
// Dos canales del Pulpo seguían apuntando al `.pipeline` real aunque el proceso
// fuera una corrida de prueba:
//   - la cola de Telegram, cuando el test no setea `PIPELINE_DIR_OVERRIDE` o lo
//     setea DESPUES del require (180 avisos de auto-incorporación llegaron al
//     teléfono del operador en un solo día);
//   - el log del halt por config corrupta, que escribía con `__dirname` fijo y
//     ensuciaba `logs/pulpo.log` productivo con líneas «CONFIG INVÁLIDA —
//     dispatch pausado» de configs de test (la única vía de diagnóstico del
//     operador, envenenada justo el día que hacía falta leerla).
//
// Lo que este archivo fija es la DIRECCION del guard: el corte es por DESTINO,
// no por "estamos en un test". Un test bien aislado tiene que seguir ejerciendo
// el camino completo — si el guard cortara por entorno, mataría la cobertura de
// todo el canal de salientes.
//
// Aislamiento: tmpdir + `PIPELINE_DIR_OVERRIDE` ANTES del require, misma
// convención que `pulpo-config-recovery.test.js`.
// node --test
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulpo-aislamiento-7086-'));
fs.mkdirSync(path.join(TMP_DIR, 'logs'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, 'servicios', 'telegram', 'pendiente'), { recursive: true });

const PIPELINE_REAL = path.resolve(__dirname, '..', '..');
fs.copyFileSync(path.join(PIPELINE_REAL, 'config.yaml'), path.join(TMP_DIR, 'config.yaml'));
const { seedRealProductManifest } = require('./_test-helpers');
const { withEnv } = require('../test-helpers/with-env');
seedRealProductManifest(TMP_DIR);

process.env.PULPO_NO_AUTOSTART = '1';
process.env.PIPELINE_DIR_OVERRIDE = TMP_DIR;

const pulpo = require('../../pulpo.js');
const { corridaDePrueba, efectoProductivoBloqueado, PAUSE_FILE } = pulpo;

test('corridaDePrueba reconoce el proceso de test por NODE_TEST_CONTEXT', () => {
    assert.equal(typeof corridaDePrueba(), 'string');
});

test('un efecto dirigido al .pipeline productivo se bloquea aunque el test este aislado', () => {
    const colaReal = path.join(PIPELINE_REAL, 'servicios', 'telegram', 'pendiente');
    assert.ok(efectoProductivoBloqueado(colaReal), 'la cola de Telegram real tiene que quedar bloqueada');
    assert.ok(efectoProductivoBloqueado(path.join(PIPELINE_REAL, '.paused')), 'el marker de pausa real tiene que quedar bloqueado');
    assert.ok(efectoProductivoBloqueado(PIPELINE_REAL), 'el propio directorio productivo cuenta como destino bloqueado');
});

test('un efecto dirigido al tmpdir aislado NO se bloquea — el test sigue ejerciendo el camino completo', () => {
    assert.equal(efectoProductivoBloqueado(path.join(TMP_DIR, 'servicios', 'telegram', 'pendiente')), null);
    assert.equal(efectoProductivoBloqueado(PAUSE_FILE), null);
    assert.ok(PAUSE_FILE.startsWith(TMP_DIR), 'sanity del seam: PAUSE_FILE vive en el tmpdir');
});

test('un prefijo que sólo comparte texto con el directorio productivo no se confunde con estar adentro', () => {
    assert.equal(efectoProductivoBloqueado(PIPELINE_REAL + '-otro'), null);
});

test('PIPELINE_ALLOW_PROD_SIDE_EFFECTS=1 es el escape hatch explicito del operador', () => {
    withEnv({ PIPELINE_ALLOW_PROD_SIDE_EFFECTS: '1' }, () => {
        assert.equal(corridaDePrueba(), null);
        assert.equal(efectoProductivoBloqueado(path.join(PIPELINE_REAL, '.paused')), null);
    });
});
// --- Wiring: los dos call-sites consultan el guard --------------------------
// Estatico a proposito: ejercer el call-site de verdad exigiria un proceso SIN
// override (que es justamente el derrame que estamos cerrando). Lo que hay que
// impedir es que alguien saque el guard del camino sin enterarse.
test('los dos canales derramados consultan el guard antes de escribir', () => {
    const src = fs.readFileSync(path.join(PIPELINE_REAL, 'pulpo.js'), 'utf8');

    const iTg = src.indexOf('function sendTelegramWithMarkup(');
    assert.ok(iTg > 0, 'sendTelegramWithMarkup tiene que existir');
    const cuerpoTg = src.slice(iTg, iTg + 900);
    assert.match(cuerpoTg, /efectoProductivoBloqueado\(telegramPendienteDir\(\)\)/,
        'el saliente de Telegram tiene que consultar el guard con la cola de destino');

    const iHalt = src.indexOf('function haltOnConfigCorruption(');
    assert.ok(iHalt > 0, 'haltOnConfigCorruption tiene que existir');
    const cuerpoHalt = src.slice(iHalt, iHalt + 900);
    assert.match(cuerpoHalt, /efectoProductivoBloqueado\(PAUSE_FILE\)/,
        'el halt tiene que consultar el guard con el marker de pausa de destino');

    assert.ok(!/appendFileSync\(path\.join\(__dirname, 'logs', 'pulpo\.log'\), safeMsg/.test(src),
        'el log del halt tiene que seguir al pipelineDir efectivo (LOG_DIR), no a __dirname');
});
