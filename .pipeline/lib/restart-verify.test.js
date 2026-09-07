'use strict';

// Tests de restart-verify.js + cableado en restart.js (#6441, CA-1/CA-2).
// node --test .pipeline/lib/restart-verify.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const rv = require('./restart-verify');

const PIPELINE_DIR = path.resolve(__dirname, '..');
const COMPONENTES = ['pulpo', 'listener', 'svc-github', 'svc-reconciler'];
const SUPERVISADOS = require('./stale-services').SUPERVISED_COMPONENTS;

// ---------------------------------------------------------------------------
// CA-1 — el resultado se reporta POR SERVICIO.
// ---------------------------------------------------------------------------

test('CA-1: la verificación reporta vivo/muerto servicio por servicio', () => {
    const vivo = (n) => n !== 'svc-reconciler';
    const r = rv.evaluarArranque(COMPONENTES, vivo, SUPERVISADOS);

    assert.deepStrictEqual(r.vivos, ['pulpo', 'listener', 'svc-github']);
    assert.deepStrictEqual(r.muertos, ['svc-reconciler']);
    assert.strictEqual(r.degradado, true);

    const lineas = rv.lineasLog(r);
    assert.strictEqual(lineas.length, 4, 'una línea por servicio, sin excepciones');
    assert.ok(lineas.some(l => l.includes('OK') && l.includes('pulpo')));
    assert.ok(lineas.some(l => l.includes('FAIL') && l.includes('svc-reconciler')));
});

test('CA-3: con todos vivos no hay degradado ni aviso, pero sí reporte', () => {
    const r = rv.evaluarArranque(COMPONENTES, () => true, SUPERVISADOS);
    assert.deepStrictEqual(r.muertos, []);
    assert.strictEqual(r.degradado, false);
    assert.strictEqual(rv.textoAlerta(r.muertos), '', 'cero ruido en el camino feliz');
    assert.strictEqual(rv.lineasLog(r).length, 4, 'el camino feliz igual deja evidencia por servicio');
});

test('una sonda que explota cuenta como muerto (fail-closed)', () => {
    // El fail-open acá es justo el silencio que el issue viene a cerrar: si no
    // podemos comprobar que está vivo, no podemos declararlo sano.
    const r = rv.evaluarArranque(['pulpo'], () => { throw new Error('wmic no responde'); }, SUPERVISADOS);
    assert.deepStrictEqual(r.muertos, ['pulpo']);
    assert.strictEqual(r.degradado, true);
});

test('entradas inválidas no se cuelan como servicios', () => {
    const r = rv.evaluarArranque([null, '', { name: 'pulpo' }, undefined], () => true, SUPERVISADOS);
    assert.deepStrictEqual(r.vivos, ['pulpo']);
    assert.deepStrictEqual(r.muertos, []);
});

test('sin componentes lanzados el resultado no es degradado', () => {
    for (const entrada of [[], null, undefined]) {
        const r = rv.evaluarArranque(entrada, () => false, SUPERVISADOS);
        assert.strictEqual(r.degradado, false);
    }
});

// ---------------------------------------------------------------------------
// CA-2 — el aviso nombra los servicios.
// ---------------------------------------------------------------------------

test('CA-2: el aviso al operador nombra cada servicio que no levantó', () => {
    const txt = rv.textoAlerta(['svc-reconciler', 'svc-drive']);
    assert.ok(txt.includes('svc-reconciler'));
    assert.ok(txt.includes('svc-drive'));
    assert.ok(/degradado/i.test(txt), 'el operador tiene que leer que el restart NO fue exitoso');
    assert.ok(!/exitoso|todo bien/i.test(txt));
});

test('el aviso concuerda en número (un servicio vs varios)', () => {
    assert.ok(/no levantó/.test(rv.textoAlerta(['pulpo'])));
    assert.ok(/no levantaron/.test(rv.textoAlerta(['pulpo', 'listener'])));
});

// ---------------------------------------------------------------------------
// Cableado real en restart.js. Es un script con `main` de nivel superior: no se
// puede requerir sin arrancar el pipeline, así que se verifica sobre la fuente
// que las decisiones del issue están efectivamente conectadas.
// ---------------------------------------------------------------------------

function fuenteRestart() {
    return fs.readFileSync(path.join(PIPELINE_DIR, 'restart.js'), 'utf8');
}

test('CA-2: restart.js marca exitCode ≠ 0 cuando un servicio no levanta', () => {
    const src = fuenteRestart();
    const m = src.match(/function launchAllVerificado\(\)\s*\{[\s\S]*?\n\}/);
    assert.ok(m, 'existe launchAllVerificado()');
    const fn = m[0];
    assert.ok(/res\.degradado/.test(fn), 'decide sobre el resultado de la verificación');
    assert.ok(/process\.exitCode\s*=\s*1/.test(fn), 'el restart degradado NO puede salir con 0');
    assert.ok(/enqueueTelegramAlert\(restartVerify\.textoAlerta/.test(fn), 'avisa al operador');
    // Se ignoran los comentarios: el propio código explica por qué NO usa
    // process.exit(), y esa mención no puede hacer fallar la comprobación.
    const codigo = fn.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');
    assert.ok(
        !/process\.exit\(/.test(codigo),
        'process.exit() cortaría el smoke test, el avance del tag y el rollback que vienen después'
    );
});

test('ninguna rama posterior pisa el exitCode degradado con 0', () => {
    const src = fuenteRestart();
    const asignaciones = [...src.matchAll(/process\.exitCode\s*=\s*([^;]+);/g)].map(m => m[1].trim());
    for (const v of asignaciones) {
        assert.notStrictEqual(v, '0', 'una asignación a 0 borraría el estado degradado');
    }
});

test('los pendientes de "código viejo" se bajan con los VIVOS, no con los spawneados', () => {
    const src = fuenteRestart();
    // Fail-open que cierra CA: bajar del registro un servicio que no arrancó lo
    // deja con código viejo para siempre y en silencio.
    assert.ok(
        !/limpiarPendientesRelanzados\(launchAll\(\)\)/.test(src),
        'launchAll() devuelve los spawneados, no los verificados vivos'
    );
    assert.ok(/limpiarPendientesRelanzados\(res\.vivos\)/.test(src));
});

test('el reintento usa el mismo spawn sin shell y sólo nombres de COMPONENTS', () => {
    const src = fuenteRestart();
    const m = src.match(/function verificarArranque\(lanzados\)\s*\{[\s\S]*?\n\}/);
    assert.ok(m, 'existe verificarArranque()');
    const fn = m[0];
    assert.ok(/porNombre\.get\(name\)/.test(fn), 'el componente se resuelve contra COMPONENTS');
    assert.ok(/if \(!comp\) continue/.test(fn), 'un nombre fuera de COMPONENTS no spawnea nada');
    assert.ok(/lanzarComponente\(comp, logsDir, false\)/.test(fn), 'reusa el spawn de launchAll');
    assert.ok(!/exec\(|execSync\(|shell:\s*true/.test(fn), 'nada de shell en el reintento');
});

test('el reintento NO trunca el log del primer intento', () => {
    const src = fuenteRestart();
    const m = src.match(/function lanzarComponente\([\s\S]*?\n\}/);
    assert.ok(m);
    assert.ok(/truncarLog !== false/.test(m[0]),
        'truncar en el reintento borraría el stack que explica por qué no arrancó');
});

// ---------------------------------------------------------------------------
// La clasificación `supervisado` decide qué frena el restart (y qué no).
// ---------------------------------------------------------------------------

test('svc-emulador caído se REPORTA pero no deja el restart en degradado', () => {
    // Sólo corre en la ventana QA. Si su ausencia degradara el restart, cada
    // /restart terminaría con un aviso — y un aviso que suena siempre deja de
    // significar algo, que es el modo de falla que este issue viene a cerrar.
    const r = rv.evaluarArranque(
        ['pulpo', 'svc-emulador'], (n) => n !== 'svc-emulador', SUPERVISADOS
    );
    assert.deepStrictEqual(r.muertos, ['svc-emulador'], 'se lo ve');
    assert.deepStrictEqual(r.muertosSupervisados, [], 'pero no frena');
    assert.strictEqual(r.degradado, false);
    assert.strictEqual(rv.textoAlerta(r.muertosSupervisados), '', 'cero ruido');

    const lineas = rv.lineasLog(r);
    assert.strictEqual(lineas.length, 2, 'CA-1: igual hay una línea por servicio');
    assert.ok(lineas.some(l => l.includes('svc-emulador') && l.includes('ausencia esperada')));
    assert.ok(!lineas.some(l => l.includes('FAIL')), 'no se reporta como FAIL');
});

test('un supervisado caído sí degrada, aunque haya no-supervisados caídos también', () => {
    const r = rv.evaluarArranque(
        ['pulpo', 'svc-emulador', 'svc-reconciler'],
        (n) => n === 'pulpo',
        SUPERVISADOS
    );
    assert.deepStrictEqual(r.muertosSupervisados, ['svc-reconciler']);
    assert.strictEqual(r.degradado, true);
    assert.ok(!rv.textoAlerta(r.muertosSupervisados).includes('svc-emulador'),
        'el aviso no menciona lo que no es un problema');
});

test('sin la clasificación, TODO cuenta (fail-closed)', () => {
    // Si `stale-services` no se pudiera cargar, preferimos un falso degradado
    // antes que dejar pasar un servicio caído en silencio.
    const r = rv.evaluarArranque(['svc-emulador'], () => false, undefined);
    assert.strictEqual(r.degradado, true);
    assert.deepStrictEqual(r.muertosSupervisados, ['svc-emulador']);
});

test('restart.js pasa la clasificación y falla cerrado si no puede leerla', () => {
    const src = fuenteRestart();
    const m = src.match(/function verificarArranque\(lanzados\)\s*\{[\s\S]*?\n\}/);
    const fn = m[0];
    assert.ok(/SUPERVISED_COMPONENTS/.test(fn), 'usa la misma clasificación que el barrido');
    assert.ok(/supervisados = undefined/.test(fn), 'si no la puede leer, exige que levanten todos');
    assert.ok(/res\.muertosSupervisados/.test(fn), 'sólo reintenta los supervisados');
});
