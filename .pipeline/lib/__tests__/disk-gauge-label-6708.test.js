'use strict';

// =============================================================================
// #6708 (rebote rev-1) — El indicador de disco tiene que decir QUÉ escalón está
// vigente, con TEXTO, en la superficie que el operador ve.
//
// Qué rompió antes: la pill visible (#hdr-resources-disk) mostraba sólo
// "🟢 24.0 GB". El número quedaba sin rotular al lado de CPU/RAM (que sí dicen
// "CPU"/"RAM"), y el escalón (verde/amarillo/naranja/rojo) sólo existía como
// color + tooltip. El color solo no es accesible (WCAG 1.4.1: la información no
// puede depender únicamente del color) y el tooltip no existe en táctil.
// La superficie que SÍ estaba rotulada — la system card — vive dentro de
// #mz-telemetry-sink, que está `hidden` desde #4227: no se ve.
//
// Estos tests fijan el contrato de la corrección para que no vuelva a caerse:
//   1. disk-guard es la única fuente del rótulo y nunca devuelve undefined.
//   2. La pill visible renderiza RÓTULO + VALOR + ESCALÓN como texto.
//   3. La pill vive fuera del sink oculto (si alguien la mueve adentro, falla).
// =============================================================================

const test = require('node:test');
const assert = require('node:assert');

const dg = require('../disk-guard');
const headerMeta = require('../../views/dashboard/header-meta');

// --- 1. Fuente canónica del rótulo ------------------------------------------

test('levelLabel devuelve la etiqueta textual de cada escalón del presupuesto', () => {
    assert.strictEqual(dg.levelLabel('green'), 'NORMAL');
    assert.strictEqual(dg.levelLabel('yellow'), 'ATENCIÓN');
    assert.strictEqual(dg.levelLabel('orange'), 'ALERTA');
    assert.strictEqual(dg.levelLabel('red'), 'CRÍTICO');
});

test('levelLabel degrada a SIN DATO ante un nivel desconocido y nunca devuelve undefined', () => {
    // El estado sale de un JSON en disco: un valor editado a mano o un escalón
    // futuro no puede imprimir "undefined" ni filtrar el id interno a la UI.
    assert.strictEqual(dg.levelLabel('unknown'), 'SIN DATO');
    assert.strictEqual(dg.levelLabel('escalon-que-no-existe'), 'SIN DATO');
    assert.strictEqual(dg.levelLabel(undefined), 'SIN DATO');
    assert.strictEqual(dg.levelLabel(null), 'SIN DATO');
});

test('hay una etiqueta textual por cada nivel declarado en LEVELS', () => {
    // Guard contra el drift: si se agrega un escalón y se olvida el rótulo,
    // este test lo caza antes de que la UI muestre "SIN DATO" en producción.
    for (const level of Object.values(dg.LEVELS)) {
        assert.ok(dg.LEVEL_LABELS[level], 'falta LEVEL_LABELS para el nivel ' + level);
    }
});

// --- 2. Render REAL de la pill visible --------------------------------------

// Ejecuta el script cliente de la pill sobre un DOM falso mínimo y devuelve el
// textContent REAL de #hdr-resources-disk. No inspecciona el código fuente por
// regex: corre la misma función que corre el navegador.
function renderDiskPill(disk) {
    function mkEl() {
        return {
            textContent: '', title: '', style: {},
            classList: {
                _s: new Set(),
                add(...c) { c.forEach((x) => this._s.add(x)); },
                remove(...c) { c.forEach((x) => this._s.delete(x)); },
                contains(c) { return this._s.has(c); },
            },
        };
    }
    const els = {};
    const ids = ['hdr-resources', 'hdr-resources-cpu', 'hdr-resources-mem',
        'hdr-resources-disk', 'hdr-pulpo', 'hdr-clock'];
    for (const id of ids) els[id] = mkEl();

    const win = {};
    const doc = { getElementById: (id) => els[id] || null };
    // El script cliente es un STRING: se evalúa con window/document inyectados.
    const fn = new Function('window', 'document', headerMeta.headerPillsClientScript());
    fn(win, doc);
    win.__hydrateHeaderPills({
        resources: { cpuPercent: 12, memPercent: 30, maxCpu: 70, maxMem: 70, disk },
    });
    return { text: els['hdr-resources-disk'].textContent, pill: els['hdr-resources'] };
}

const BUDGET = { green_gb: 40, yellow_gb: 25, orange_gb: 12 };

test('la pill visible muestra rótulo + valor + etiqueta del escalón como texto', () => {
    const { text } = renderDiskPill({ level: 'red', freeGB: 8.04, totalGB: 236, budget: BUDGET });
    // Lo que pidió el rechazo: "Disco 24.0 GB · CRITICO", no sólo el emoji.
    assert.match(text, /Disco/, 'el dato tiene que estar rotulado "Disco"');
    assert.match(text, /8\.0 GB/, 'tiene que mostrar los GB libres');
    assert.match(text, /CRÍTICO/, 'tiene que mostrar la etiqueta del escalón como TEXTO');
    assert.strictEqual(text, '🔴 Disco 8.0 GB · CRÍTICO');
});

test('cada escalón imprime su propia etiqueta textual en la pill', () => {
    const casos = [
        { level: 'green', freeGB: 124.0, esperado: '🟢 Disco 124.0 GB · NORMAL' },
        { level: 'yellow', freeGB: 31.2, esperado: '🟡 Disco 31.2 GB · ATENCIÓN' },
        { level: 'orange', freeGB: 18.5, esperado: '🟠 Disco 18.5 GB · ALERTA' },
        { level: 'red', freeGB: 8.0, esperado: '🔴 Disco 8.0 GB · CRÍTICO' },
    ];
    for (const c of casos) {
        const { text } = renderDiskPill({ level: c.level, freeGB: c.freeGB, totalGB: 236, budget: BUDGET });
        assert.strictEqual(text, c.esperado, 'escalón ' + c.level);
    }
});

test('la etiqueta del escalón no depende sólo del color: el texto la nombra', () => {
    // WCAG 1.4.1 — dos niveles distintos tienen que distinguirse leyendo el
    // texto, sin percibir el color ni pasar el mouse por el tooltip.
    const naranja = renderDiskPill({ level: 'orange', freeGB: 18.0, budget: BUDGET }).text;
    const rojo = renderDiskPill({ level: 'red', freeGB: 8.0, budget: BUDGET }).text;
    assert.notStrictEqual(naranja, rojo);
    assert.ok(naranja.includes('ALERTA') && !naranja.includes('CRÍTICO'));
    assert.ok(rojo.includes('CRÍTICO') && !rojo.includes('ALERTA'));
});

test('el servidor manda el rótulo y la pill lo prefiere sobre su espejo local', () => {
    // Evita el drift silencioso: si el mapa del servidor cambia, la pill sigue.
    const { text } = renderDiskPill({ level: 'red', freeGB: 8.0, label: 'CRÍTICO', budget: BUDGET });
    assert.strictEqual(text, '🔴 Disco 8.0 GB · CRÍTICO');
});

test('sin medición la pill sigue rotulada y dice SIN DATO, no 0 GB', () => {
    // Un "0.0 GB" acá se leería como "disco lleno" y dispararía una limpieza
    // de urgencia que no corresponde. El hueco tiene que decir que no se midió.
    const { text } = renderDiskPill(null);
    assert.match(text, /Disco/);
    assert.match(text, /SIN DATO/);
    assert.ok(!/\d\.\d GB/.test(text), 'no debe inventar un valor numérico');
});

// --- 3. La pill vive en una superficie SERVIDA y VISIBLE ---------------------

test('la pill de disco se renderiza fuera del sink de telemetría oculto', () => {
    // #4227 dejó #mz-telemetry-sink con `hidden` + display:none. La system card
    // (sys-disk-value) vive adentro y por eso no se ve. La pill tiene que estar
    // AFUERA: si alguien la mueve al sink, el operador vuelve a quedar ciego.
    const html = require('../../views/dashboard/home.js').renderHomeHTML({ state: {} });
    const iPill = html.indexOf('hdr-resources-disk');
    const iSink = html.indexOf('id="mz-telemetry-sink"');
    assert.ok(iPill > -1, 'la pill de disco tiene que existir en el HTML servido');
    assert.ok(iSink > -1, 'el sink oculto tiene que seguir existiendo');
    assert.ok(iPill < iSink, 'la pill de disco no puede vivir dentro del sink oculto');
});

test('el SSR de la pill deja el rótulo "Disco" antes de la primera hidratación', () => {
    const ssr = headerMeta.renderHeaderMetaSsr({ withMode: false });
    assert.match(ssr, /id="hdr-resources-disk"/);
    assert.match(ssr, /Disco/, 'el placeholder ya tiene que estar rotulado');
});
