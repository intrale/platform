// =============================================================================
// desync-pill-5724.test.js — Issue #5724 CA-4 (+ guidelines UX-1..UX-4, UX-7)
//
// El pill de sync allowlist↔ola ya existía (#4375), pero comunicaba el síntoma
// interno ("Divergencia bloqueada") en vez de la consecuencia operativa: el
// dispatch está suspendido y no se lanza ningún agente. Sin antigüedad, un
// bloqueo de 10 horas se veía igual que uno de 10 minutos; y el tope de 6 chips
// truncaba la divergencia en silencio.
//
// Cubre:
//   UX-1  el estado bloqueante nombra la consecuencia + la causa concreta.
//   UX-2  role="alert" (assertive) sólo cuando el dispatch está frenado.
//   UX-3  antigüedad visible, tomada del `detected_at` del slice.
//   UX-4  indicador de overflow cuando la divergencia supera los 6 issues.
//   UX-7  sin colores hardcodeados ni íconos fuera del sprite.
//   + regresión: los estados no bloqueantes conservan su copy y su role.
//
// Ejecutar:
//   node --test .pipeline/views/dashboard/__tests__/desync-pill-5724.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const pipeline = require(path.resolve(__dirname, '..', 'pipeline.js'));

function fakeIc(name) { return `<svg class="pl-ic"><use href="#ic-${name}"/></svg>`; }

// `now` fijo para que la antigüedad sea determinística.
const AHORA = Date.parse('2026-08-09T22:12:00.000Z');
const HACE_10H = '2026-08-09T12:12:00.000Z';

function render(desync, now) {
    return pipeline.renderDesyncPill({ ic: fakeIc, desync, now: now === undefined ? AHORA : now });
}

// --- UX-1 / UX-2 / UX-3 -------------------------------------------------------

test('UX-1: el bloqueo nombra la consecuencia (dispatch suspendido), no el archivo', () => {
    const html = render({
        estado: 'divergencia_bloqueada', bloqueado: true,
        added: [], removed: [5689, 5690, 5691], count: 91, detected_at: HACE_10H,
    });
    assert.match(html, /Dispatch suspendido/);
    assert.match(html, /3 issues de la ola fuera de la allowlist/);
    assert.match(html, /no se lanza ningún agente/);
    assert.doesNotMatch(html, /ambiguo o flag de desync activo/, 'el copy viejo no debe sobrevivir');
});

test('UX-2: role="alert" cuando el dispatch está suspendido', () => {
    const html = render({
        estado: 'divergencia_bloqueada', bloqueado: true,
        added: [], removed: [5689], count: 10, detected_at: HACE_10H,
    });
    assert.match(html, /role="alert"/);
    assert.doesNotMatch(html, /role="status"/);
});

test('UX-2: divergencia detectada pero NO bloqueante mantiene role="status"', () => {
    const html = render({
        estado: 'divergencia_bloqueada', bloqueado: false,
        added: [7777], removed: [], count: 10, detected_at: null,
    });
    assert.match(html, /role="status"/);
    assert.doesNotMatch(html, /role="alert"/);
    assert.doesNotMatch(html, /no se lanza ningún agente/, 'sin flag no se afirma que el dispatch está frenado');
});

test('UX-3: muestra la antigüedad del bloqueo tomada de detected_at', () => {
    const html = render({
        estado: 'divergencia_bloqueada', bloqueado: true,
        added: [], removed: [5689], count: 10, detected_at: HACE_10H,
    });
    assert.match(html, /hace 10 h/);
});

test('UX-3: sin detected_at no se inventa antigüedad', () => {
    const html = render({
        estado: 'divergencia_bloqueada', bloqueado: true,
        added: [], removed: [5689], count: 10, detected_at: null,
    });
    assert.match(html, /Dispatch suspendido/);
    assert.doesNotMatch(html, /hace \d/);
});

test('UX-3: la antigüedad sobrevive a la doble normalización del call-site', () => {
    // El view normaliza en el montaje Y adentro del render: si normalize no
    // fuera idempotente, `detected_at` se perdería en la segunda pasada.
    const normalizado = pipeline.normalizeDesyncStatus({
        estado: 'divergencia_bloqueada', bloqueado: true,
        added: [], removed: [5689], count: 10, detected_at: HACE_10H,
    });
    const html = render(normalizado);
    assert.match(html, /hace 10 h/);
});

// --- UX-4 ---------------------------------------------------------------------

test('UX-4: con más de 6 issues divergentes aparece el indicador de overflow', () => {
    const removed = [1, 2, 3, 4, 5, 6, 7, 8, 9]; // 9 → 6 visibles + 3 ocultos
    const html = render({
        estado: 'divergencia_bloqueada', bloqueado: true,
        added: [], removed, count: 20, detected_at: HACE_10H,
    });
    assert.match(html, /\+3 más/);
    assert.match(html, /9 issues de la ola fuera de la allowlist/, 'el conteo total no se trunca');
});

test('UX-4: con 6 o menos no hay indicador de overflow', () => {
    const html = render({
        estado: 'divergencia_bloqueada', bloqueado: true,
        added: [], removed: [1, 2, 3], count: 20, detected_at: HACE_10H,
    });
    assert.doesNotMatch(html, /más</);
});

// --- UX-7 + regresiones -------------------------------------------------------

test('UX-7: el pill no introduce colores hardcodeados', () => {
    const html = render({
        estado: 'divergencia_bloqueada', bloqueado: true,
        added: [4444], removed: [5689], count: 10, detected_at: HACE_10H,
    });
    assert.doesNotMatch(html, /#[0-9a-fA-F]{6}\b/, 'sin hex: los colores vienen de las clases dss-*');
    assert.doesNotMatch(html, /rgba?\(/);
});

test('UX-7: los íconos usados existen en el sprite del design system', () => {
    const sprite = fs.readFileSync(
        path.resolve(__dirname, '..', '..', '..', 'assets', 'icons', 'sprite.svg'), 'utf8');
    for (const estado of ['sincronizado', 'realineado_reductivo', 'divergencia_bloqueada', 'desconocido']) {
        for (const bloqueado of [true, false]) {
            const html = render({ estado, bloqueado, added: [], removed: [], count: 1, detected_at: HACE_10H });
            const usados = [...html.matchAll(/href="#(ic-[a-z0-9-]+)"/g)].map((m) => m[1]);
            assert.ok(usados.length > 0, `el pill de ${estado} debe pintar un ícono`);
            for (const id of usados) {
                assert.ok(sprite.includes(`id="${id}"`), `el sprite debe tener ${id}`);
            }
        }
    }
});

test('regresión: los estados no bloqueantes conservan su copy', () => {
    const ok = render({ estado: 'sincronizado', bloqueado: false, added: [], removed: [], count: 88 });
    assert.match(ok, /Sincronizado/);
    assert.match(ok, /88 issues alineados/);

    const reductivo = render({ estado: 'realineado_reductivo', bloqueado: false, added: [], removed: [1], count: 5 });
    assert.match(reductivo, /Realineado/);
    assert.match(reductivo, /no bloquea/);

    const sinDatos = render({ estado: 'desconocido', bloqueado: false, added: [], removed: [], count: 0 });
    assert.match(sinDatos, /Sin datos/);
});

test('regresión CA-8: los issue numbers siguen filtrados a enteros', () => {
    const html = render({
        estado: 'divergencia_bloqueada', bloqueado: true,
        added: ['<script>alert(1)</script>', 4444], removed: [null, 5689],
        count: 10, detected_at: HACE_10H,
    });
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /\+#4444/);
    assert.match(html, /−#5689/);
});
