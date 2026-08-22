// =============================================================================
// Tests de la CAPA DE GESTO del timeline de modo descanso (#3964, rebote rev-1).
//
// Regresión que cubrimos:
//   move/resize llaman buildTimeline() en cada pointermove. buildTimeline() hace
//   clearChildren(rm-grid) y crea .rm-tl-body NUEVOS. Si el gesto reusa la
//   referencia cacheada tlGesture.body, tras el primer frame ese body queda
//   DESCONECTADO del DOM y getBoundingClientRect() devuelve top:0 → a partir del
//   frame 2 los minutos se calculan en coordenadas de viewport y el bloque salta.
//
// El fix re-resuelve el .rm-tl-body vivo del DOM (liveTimelineBody) en cada frame.
// Acá lo verificamos evaluando el script cliente real sobre un mini-DOM fake cuyo
// getBoundingClientRect distingue nodo conectado (top fijo) vs desconectado (top:0).
//
// Se ejecuta con: node --test .pipeline/views/dashboard/__tests__/descanso-gesture.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { renderDescansoInner } = require('..' + path.sep + 'descanso.js');

// ---------------------------------------------------------------------------
// Mini-DOM fake. Sólo lo que el script cliente toca durante un gesto move/resize.
// La clave: getBoundingClientRect() de un .rm-tl-body devuelve BODY_TOP si está
// conectado al grid raíz, y 0 si quedó detached (replica el bug del browser).
// ---------------------------------------------------------------------------

const BODY_TOP = 100;          // top simulado de la columna del timeline (px)
const PX_PER_HOUR = 28;        // debe coincidir con TL_PX_PER_HOUR del script

function isConnected(node, root) {
    let n = node;
    while (n) {
        if (n === root) return true;
        n = n.parentNode;
    }
    return false;
}

function makeFakeDocument() {
    let gridRoot = null;
    const byId = {};

    function makeNode(tag) {
        const node = {
            tagName: tag,
            _children: [],
            parentNode: null,
            attrs: {},
            style: {},
            className: '',
            textContent: '',
            id: '',
            hidden: false,
            classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
            setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); },
            getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
            appendChild(c) { c.parentNode = this; this._children.push(c); return c; },
            removeChild(c) {
                const i = this._children.indexOf(c);
                if (i >= 0) { this._children.splice(i, 1); c.parentNode = null; }
                return c;
            },
            addEventListener() {},
            removeEventListener() {},
            get firstChild() { return this._children[0] || null; },
            getBoundingClientRect() {
                const isBody = /\brm-tl-body\b/.test(this.className);
                const top = (isBody && isConnected(this, gridRoot)) ? BODY_TOP : 0;
                return { top, left: 0, right: 0, bottom: 0, width: 0, height: 24 * PX_PER_HOUR };
            },
            // querySelector mínimo: soporta '.clase[attr="valor"]'.
            querySelector(sel) {
                const m = sel.match(/^\.([\w-]+)\[([\w-]+)="([^"]*)"\]$/);
                if (!m) return null;
                const [, cls, attr, val] = m;
                const stack = this._children.slice();
                while (stack.length) {
                    const n = stack.shift();
                    const hasCls = (' ' + (n.className || '') + ' ').indexOf(' ' + cls + ' ') >= 0;
                    if (hasCls && n.getAttribute(attr) === val) return n;
                    for (const c of n._children) stack.push(c);
                }
                return null;
            },
        };
        return node;
    }

    const document = {
        getElementById(id) {
            if (!byId[id]) {
                byId[id] = makeNode('div');
                byId[id].id = id;
                if (id === 'rm-grid') gridRoot = byId[id];
            }
            return byId[id];
        },
        createElement(tag) { return makeNode(tag); },
        addEventListener() {},
        removeEventListener() {},
    };
    return document;
}

// ---------------------------------------------------------------------------
// Evalúa el <script> cliente real de descanso.js en el sandbox fake y expone
// las funciones/estado que el test necesita manipular.
// ---------------------------------------------------------------------------

function loadClientScript() {
    const inner = renderDescansoInner();
    const m = inner.match(/<script[^>]*>([\s\S]*?)<\/script>/);
    assert.ok(m, 'no se encontró el <script> cliente en renderDescansoInner');
    const scriptText = m[1];

    const sandbox = {
        document: makeFakeDocument(),
        setInterval() { return 0; },
        setTimeout() { return 0; },
        clearTimeout() {},
        clearInterval() {},
        fetch() { return Promise.reject(new Error('no-net')); },
        addEventListener() {},
        removeEventListener() {},
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        prompt() { return null; },
        confirm() { return false; },
        alert() {},
        console: { log() {}, warn() {}, error() {} },
        navigator: { userAgent: 'node-test' },
        location: { href: '', search: '' },
        requestAnimationFrame() { return 0; },
    };

    const exportsObj = {};
    // `with(sandbox)` resuelve todos los globals del browser desde el fake; las
    // funciones del script siguen viviendo en el scope de la Function y las
    // re-exportamos al final.
    // eslint-disable-next-line no-new-func
    const run = new Function('sandbox', '__exports', 'with (sandbox) {\n' + scriptText +
        '\n;__exports.onGesturePointerMove = onGesturePointerMove;' +
        '\n;__exports.buildTimeline = buildTimeline;' +
        '\n;__exports.liveTimelineBody = liveTimelineBody;' +
        '\n;__exports.pointerMinInBody = pointerMinInBody;' +
        '\n;__exports.setGesture = function(g){ tlGesture = g; };' +
        '\n;__exports.setScheduleDay = function(day, list){ scheduleState[day] = list; };' +
        '\n;__exports.getScheduleDay = function(day){ return scheduleState[day]; };' +
        '\n}');
    run(sandbox, exportsObj);
    return exportsObj;
}

// clientY que cae en `min` minutos dentro de un body cuyo top es BODY_TOP.
function clientYForMin(min) { return BODY_TOP + (min / 60) * PX_PER_HOUR; }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('move usa el body VIVO del DOM en frame >1 (no la referencia stale)', () => {
    const api = loadClientScript();
    api.setScheduleDay('monday', [{ start: '10:00', end: '12:00' }]); // 600–720
    api.buildTimeline();

    const body0 = api.liveTimelineBody('monday');
    assert.ok(body0, 'buildTimeline no creó el body de monday');

    // Arrastre del bloque agarrándolo desde su borde superior (grabMin = 600).
    api.setGesture({ kind: 'move', day: 'monday', idx: 0, body: body0, grabMin: 600, startS: 600, startE: 720 });

    // Frame 1: mover +60' → 11:00–13:00. (buildTimeline reconstruye la grilla.)
    api.onGesturePointerMove({ clientY: clientYForMin(660) });
    assert.deepEqual(api.getScheduleDay('monday')[0], { start: '11:00', end: '13:00' }, 'frame 1 incorrecto');

    // Frame 2: el body original ya está detached; el fix re-resuelve el vivo.
    // mover +90' respecto al inicio → 11:30–13:30. Con el bug daría top:0 → salto.
    api.onGesturePointerMove({ clientY: clientYForMin(690) });
    assert.deepEqual(api.getScheduleDay('monday')[0], { start: '11:30', end: '13:30' }, 'frame 2 saltó (body stale)');
});

test('resize (borde inferior) sigue correcto en frame >1', () => {
    const api = loadClientScript();
    api.setScheduleDay('monday', [{ start: '10:00', end: '12:00' }]); // 600–720
    api.buildTimeline();
    const body0 = api.liveTimelineBody('monday');

    api.setGesture({ kind: 'resize', day: 'monday', idx: 0, body: body0, edge: 'bottom', startS: 600, startE: 720 });

    // Frame 1: bajar el borde inferior a 13:00 (780').
    api.onGesturePointerMove({ clientY: clientYForMin(780) });
    assert.deepEqual(api.getScheduleDay('monday')[0], { start: '10:00', end: '13:00' }, 'resize frame 1 incorrecto');

    // Frame 2: a 14:00 (840'). Con body stale (top:0) el cómputo se iría a viewport.
    api.onGesturePointerMove({ clientY: clientYForMin(840) });
    assert.deepEqual(api.getScheduleDay('monday')[0], { start: '10:00', end: '14:00' }, 'resize frame 2 saltó (body stale)');
});

test('liveTimelineBody devuelve el nodo fresco tras rebuild; el stale da top:0 (documenta el bug)', () => {
    const api = loadClientScript();
    api.setScheduleDay('monday', [{ start: '10:00', end: '12:00' }]);
    api.buildTimeline();
    const stale = api.liveTimelineBody('monday');

    api.buildTimeline(); // rebuild → nuevo nodo, el anterior queda detached
    const fresh = api.liveTimelineBody('monday');

    assert.notEqual(stale, fresh, 'buildTimeline debería crear un body nuevo');
    // El nodo stale (detached) devuelve top:0 → cómputo erróneo si se reusara.
    assert.notEqual(
        api.pointerMinInBody(stale, clientYForMin(660)),
        api.pointerMinInBody(fresh, clientYForMin(660)),
        'el body stale debería diferir del vivo (top:0 vs top fijo)',
    );
    // El vivo computa el minuto correcto (660 = 11:00).
    assert.equal(api.pointerMinInBody(fresh, clientYForMin(660)), 660, 'body vivo computa mal el minuto');
});
