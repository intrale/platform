'use strict';

// #6441 — Coherencia entre el registro canónico de Node y el watchdog de
// PowerShell. Archivo aparte de `stale-services.test.js` (que cubre #5646).
//
// Por qué existe este test: hasta este issue `$Services` en `watchdog.ps1` era
// una lista hardcodeada de 6 entradas que omitía `svc-reconciler`,
// `svc-emulador` y `outbox-drain`. El watchdog los veía muertos y los trataba
// como no-evento. Esa divergencia silenciosa es la causa dominante de los 6
// días de caída del 2026-08-18: nadie tenía motivo para sospechar.
//
// node --test .pipeline/lib/stale-services-supervised-6441.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const stale = require('./stale-services');

const PIPELINE_DIR = path.resolve(__dirname, '..');

function fuenteWatchdog() {
    return fs.readFileSync(path.join(PIPELINE_DIR, 'watchdog.ps1'), 'utf8');
}

function parseSupervisedDelWatchdog() {
    const src = fuenteWatchdog();
    const m = src.match(/\$Supervised\s*=\s*@\(([\s\S]*?)\n\)/);
    assert.ok(m, 'se encontró el bloque $Supervised en watchdog.ps1');
    return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

test('CA: $Supervised de watchdog.ps1 == componentes supervisados del registro', () => {
    const delPs = parseSupervisedDelWatchdog().slice().sort();
    const delRegistro = stale.SUPERVISED_COMPONENTS.slice().sort();
    assert.deepStrictEqual(
        delPs, delRegistro,
        'si esto falla, un servicio supervisado no lo vigila nadie (o se vigila uno que no corresponde)'
    );
});

test('CA: svc-reconciler está supervisado — es el servicio del incidente', () => {
    assert.ok(stale.SUPERVISED_COMPONENTS.includes('svc-reconciler'));
    assert.ok(parseSupervisedDelWatchdog().includes('svc-reconciler'));
});

test('CA-6: outbox-drain y svc-emulador NO están supervisados (cero ruido)', () => {
    // outbox-drain se auto-mata si el Pulpo está corriendo: alertarlo sería un
    // falso positivo diario. svc-emulador sólo corre en la ventana QA.
    for (const n of ['outbox-drain', 'svc-emulador']) {
        assert.ok(!stale.SUPERVISED_COMPONENTS.includes(n), n + ' no debe alertar');
        assert.ok(!parseSupervisedDelWatchdog().includes(n), n + ' no debe estar en $Supervised');
    }
});

test('todo componente del registro declara `supervisado` explícitamente', () => {
    // Un `undefined` se leería como false y el componente quedaría sin vigilar
    // en silencio — exactamente el modo de falla que este issue cierra.
    for (const c of stale.COMPONENT_REGISTRY) {
        assert.strictEqual(typeof c.supervisado, 'boolean', c.name + ' no declara `supervisado`');
    }
});

test('los supervisados son un subconjunto del registro canónico', () => {
    for (const n of stale.SUPERVISED_COMPONENTS) {
        assert.ok(stale.ALL_COMPONENTS.includes(n), n + ' no está en el registro');
    }
});

test('$Services se DERIVA del registro, no se vuelve a hardcodear', () => {
    const src = fuenteWatchdog();
    // La regresión a evitar: que alguien vuelva a escribir la tabla a mano y el
    // test de arriba deje de cubrir nada porque $Supervised quedó de adorno.
    assert.ok(
        /\$Services\s*=\s*@\(\)/.test(src),
        '$Services debe arrancar vacío y llenarse desde $ScriptMap'
    );
    assert.ok(
        /foreach\s*\(\$svcName in \$Supervised\)/.test(src),
        '$Services debe derivarse recorriendo $Supervised'
    );
    assert.ok(
        !/\$Services\s*=\s*@\(\s*\n?\s*@\{\s*Name/.test(src),
        'quedó una tabla $Services hardcodeada'
    );
});

test('el watchdog invoca el barrido de liveness', () => {
    const src = fuenteWatchdog();
    assert.ok(/service-liveness-run\.js/.test(src), 'el runner tiene que estar cableado');
    assert.ok(/^Invoke-ServiceLivenessSweep\s*$/m.test(src), 'y efectivamente invocado');
    assert.ok(
        fs.existsSync(path.join(PIPELINE_DIR, 'service-liveness-run.js')),
        'el runner que invoca el .ps1 existe en disco'
    );
});

test('el barrido NO ordena relanzamientos (evita el doble spawn por ciclo)', () => {
    // El loop de servicios caídos del .ps1 ya relanza, con double-check
    // anti-TOCTOU. Si además el runner ordenara relanzar, habría dos spawns del
    // mismo servicio en el mismo ciclo.
    const runner = fs.readFileSync(path.join(PIPELINE_DIR, 'service-liveness-run.js'), 'utf8');
    assert.ok(!/ACTION:relaunch/.test(runner), 'el runner no debe emitir órdenes de relanzamiento');
    assert.ok(/ACTION:down:/.test(runner));
    assert.ok(/ACTION:ok/.test(runner));
});

test('el runner usa pid-discovery de la RAÍZ (identidad), no el de lib/', () => {
    // `lib/pid-discovery` sólo expone pidAlive: un PID reciclado por otro
    // proceso daría vivo un servicio muerto (le pasó a svc-emulador.pid).
    const runner = fs.readFileSync(path.join(PIPELINE_DIR, 'service-liveness-run.js'), 'utf8');
    assert.ok(/require\('\.\/pid-discovery'\)/.test(runner));
    assert.ok(!/require\('\.\/lib\/pid-discovery'\)/.test(runner));
});
