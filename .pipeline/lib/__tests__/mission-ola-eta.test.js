// =============================================================================
// mission-ola-eta.test.js — #4296
//
// Cobertura del accessor compartido del banner de ola (avance %, velocidad %/h,
// ETA). Es la fuente ÚNICA que consumen TODAS las ventanas del dashboard, así
// que su comportamiento en los dos modos (`velocity` y `fallback`) define lo que
// se ve en HOME y subventanas por igual (CA-1..CA-4).
//
// node --test .pipeline/lib/__tests__/mission-ola-eta.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { deriveMissionOlaEta, missionOlaEtaClientScript, MISSION_INSUFFICIENT_DATA } = require('../mission-ola-eta');

test('payload nulo/indefinido degrada a estructura neutra sin romper', () => {
    for (const input of [null, undefined, 42, 'x']) {
        const m = deriveMissionOlaEta(input);
        assert.deepEqual(m, {
            avancePct: null,
            velocityPctPerHour: null,
            etaRemainingMin: null,
            etaFromVelocity: false,
            hasVelocity: false,
            velocityState: 'sin datos suficientes', // #4325 CA-4: estado explícito, no mudo
            throughputPerDay: null,                 // #4450 — throughput sin dato
            throughputState: 'insufficient',        // #4450 — estado explícito
        });
    }
});

test('modo velocity: expone avance %, velocidad %/h y ETA por velocidad', () => {
    const m = deriveMissionOlaEta({
        etaSource: 'velocity',
        totalPct: 61.7,
        totalP50: 120,
        velocityETA: { source: 'velocity', velocityPctPerMin: 0.25, remainingMs: 7200000, totalPct: 61.7 },
    });
    assert.equal(m.avancePct, 62);                 // totalPct redondeado
    assert.equal(m.hasVelocity, true);
    assert.equal(m.velocityPctPerHour, 15);        // 0.25 × 60
    assert.equal(m.etaFromVelocity, true);
    assert.equal(m.etaRemainingMin, 120);          // 7200000ms / 60000
});

test('modo fallback: avance % vivo desde totalPct aunque velocityETA sea null', () => {
    // Este es el caso que dejaba el banner "fosilizado"/vacío en subventanas:
    // sin ritmo medido velocityETA es null, pero el totalPct determinístico está
    // presente y DEBE mostrarse (alineado con la HOME).
    const m = deriveMissionOlaEta({
        etaSource: 'fallback',
        totalPct: 40,
        totalP50: 90,
        velocityETA: null,
    });
    assert.equal(m.avancePct, 40);                 // avance vivo, NO null
    assert.equal(m.hasVelocity, false);
    assert.equal(m.velocityPctPerHour, null);      // "— %/h" en la vista
    assert.equal(m.etaFromVelocity, false);
    assert.equal(m.etaRemainingMin, 90);           // cae a la mediana teórica p50
});

test('velocity con velocityPctPerMin <= 0 no cuenta como ritmo medido', () => {
    const m = deriveMissionOlaEta({
        etaSource: 'velocity',
        totalPct: 10,
        totalP50: 200,
        velocityETA: { source: 'velocity', velocityPctPerMin: 0, remainingMs: 999 },
    });
    assert.equal(m.hasVelocity, false);
    assert.equal(m.velocityPctPerHour, null);
    assert.equal(m.etaRemainingMin, 200);          // fallback a p50, no remainingMs
});

test('totalPct no finito (NaN/undefined) → avancePct null (no se muestra basura)', () => {
    assert.equal(deriveMissionOlaEta({ etaSource: 'fallback' }).avancePct, null);
    assert.equal(deriveMissionOlaEta({ etaSource: 'fallback', totalPct: NaN }).avancePct, null);
    assert.equal(deriveMissionOlaEta({ etaSource: 'fallback', totalPct: '50' }).avancePct, null);
});

test('etaSource velocity pero sin remainingMs finito → ETA cae a p50', () => {
    const m = deriveMissionOlaEta({
        etaSource: 'velocity',
        totalPct: 30,
        totalP50: 75,
        velocityETA: { source: 'velocity', velocityPctPerMin: 0.5 },
    });
    assert.equal(m.hasVelocity, true);
    assert.equal(m.velocityPctPerHour, 30);
    assert.equal(m.etaFromVelocity, false);
    assert.equal(m.etaRemainingMin, 75);
});

// -----------------------------------------------------------------------------
// #4449 — piso teórico: la velocidad optimista no puede pisar el presupuesto
// teórico del trabajo RESTANTE (totalP50 ya excluye cerrados desde dashboard.js).
// -----------------------------------------------------------------------------

test('#4449 CA-1/CA-2: ola con issues sin definir + velocidad reciente alta → ETA = piso teórico', () => {
    // velocityETA proyecta ~4 min (remainingMs chico) pero totalP50 (restante) es
    // grande porque quedan issues por definir con lifecycle completo. El piso gana.
    const m = deriveMissionOlaEta({
        etaSource: 'velocity',
        totalPct: 30,
        totalP50: 480,                                   // 8h de trabajo restante
        velocityETA: { source: 'velocity', velocityPctPerMin: 5, remainingMs: 240000 }, // ~4 min
    });
    assert.equal(m.hasVelocity, true);
    assert.equal(m.etaFromVelocity, true);
    assert.equal(m.etaRemainingMin, 480);                // max(4, 480) = 480 (piso teórico)
});

test('#4449 CA-2: velocidad realista mayor al piso → gana la velocidad', () => {
    const m = deriveMissionOlaEta({
        etaSource: 'velocity',
        totalPct: 80,
        totalP50: 30,                                    // presupuesto restante chico
        velocityETA: { source: 'velocity', velocityPctPerMin: 0.1, remainingMs: 6000000 }, // 100 min
    });
    assert.equal(m.etaRemainingMin, 100);                // max(100, 30) = 100 (velocidad)
});

test('#4449 CA-2: hay velocidad pero falta totalP50 → ETA = velocidad (sin piso)', () => {
    const m = deriveMissionOlaEta({
        etaSource: 'velocity',
        totalPct: 50,
        velocityETA: { source: 'velocity', velocityPctPerMin: 0.5, remainingMs: 1800000 }, // 30 min
    });
    assert.equal(m.etaRemainingMin, 30);                 // sin budget → velocidad sola
});

test('#4449 CA-5: remainingMs Infinity/NaN/negativo sin totalP50 → etaRemainingMin null', () => {
    for (const bad of [Infinity, NaN, -1]) {
        const m = deriveMissionOlaEta({
            etaSource: 'velocity',
            totalPct: 10,
            velocityETA: { source: 'velocity', velocityPctPerMin: 0.5, remainingMs: bad },
        });
        // remainingMs no finito → etaFromVelocity false → sin budget → null.
        assert.equal(m.etaRemainingMin, null, `remainingMs=${bad} debe caer a null`);
    }
});

test('#4449 CA-5: totalP50 negativo/NaN → etaRemainingMin null (blindaje del render)', () => {
    assert.equal(deriveMissionOlaEta({ etaSource: 'fallback', totalPct: 10, totalP50: -5 }).etaRemainingMin, null);
    assert.equal(deriveMissionOlaEta({ etaSource: 'fallback', totalPct: 10, totalP50: NaN }).etaRemainingMin, null);
});

test('el emisor de script cliente reusa la función pura y es self-wiring/idempotente', () => {
    const src = missionOlaEtaClientScript();
    assert.equal(typeof src, 'string');
    // DRY: la lógica viaja serializada, no reimplementada.
    assert.ok(src.includes('function deriveMissionOlaEta'));
    // Hidrata los tres ids del banner compartido.
    assert.ok(src.includes('mission-avance-pct'));
    assert.ok(src.includes('mission-vel-value'));
    assert.ok(src.includes('mission-eta-value'));
    // Consume la fuente viva única.
    assert.ok(src.includes('/api/dash/ola-eta'));
    // Guard de idempotencia + poll periódico.
    assert.ok(src.includes('__missionOlaEtaWired'));
    assert.ok(src.includes('setInterval'));
    // #4450 — la celda de velocidad ahora expresa throughput en issues/día, no %/h.
    assert.ok(src.includes('issues/día'));
    assert.ok(!src.includes('%/h'));
    assert.ok(!src.includes('iss/h'));
});

// -----------------------------------------------------------------------------
// #4325 (CA-4) — estado explícito "sin datos suficientes" cuando no hay ritmo
// medido, en vez del guion mudo o un 0 silencioso.
// -----------------------------------------------------------------------------

test('etaSource fallback → velocityState expone "sin datos suficientes" (no "—" ni 0)', () => {
    const m = deriveMissionOlaEta({ etaSource: 'fallback', totalPct: 66 });
    assert.equal(m.hasVelocity, false);
    assert.equal(m.velocityPctPerHour, null);            // sigue null (no se inventa un valor)
    assert.equal(m.velocityState, 'sin datos suficientes');
    assert.equal(m.velocityState, MISSION_INSUFFICIENT_DATA); // misma cadena exportada
    assert.notEqual(m.velocityState, '—');
    assert.notEqual(m.velocityState, 0);
});

test('etaSource velocity con ritmo medido → velocityState "measured"', () => {
    const m = deriveMissionOlaEta({
        etaSource: 'velocity',
        totalPct: 40,
        velocityETA: { source: 'velocity', velocityPctPerMin: 0.5, remainingMs: 600000 },
    });
    assert.equal(m.hasVelocity, true);
    assert.equal(m.velocityState, 'measured');
});

test('el script cliente renderiza la leyenda explícita (velocityState) en vez del guion', () => {
    const src = missionOlaEtaClientScript();
    // El cliente traduce el estado a la leyenda cuando no hay ritmo medido.
    assert.ok(src.includes('velocityState'));
    // La cadena viaja dentro de la función serializada (self-contained, sin ref a
    // constante de módulo que rompería el eval del cliente).
    assert.ok(src.includes('sin datos suficientes'));
});

// -----------------------------------------------------------------------------
// #4450 — throughput de entrega (issues/día) en la celda 🚀 VELOCIDAD.
// deriveMissionOlaEta expone throughputPerDay/throughputState; el client script
// pinta "issues/día" (measured, incluye 0.0) o la leyenda "sin datos suficientes"
// (insufficient). Render XSS-safe (sin innerHTML sobre mission-vel-value).
// -----------------------------------------------------------------------------

test('deriveMissionOlaEta expone throughput measured (issues/día) desde el payload', () => {
    const m = deriveMissionOlaEta({
        etaSource: 'fallback',
        totalPct: 25,
        throughputPerDay: 1.4,
        throughputState: 'measured',
    });
    assert.equal(m.throughputPerDay, 1.4);
    assert.equal(m.throughputState, 'measured');
});

test('deriveMissionOlaEta: throughput 0.0 con estado measured es cero legítimo', () => {
    const m = deriveMissionOlaEta({ throughputPerDay: 0, throughputState: 'measured' });
    assert.equal(m.throughputPerDay, 0);
    assert.equal(m.throughputState, 'measured');
});

test('deriveMissionOlaEta: throughput sin dato / no finito → insufficient (nunca measured con null)', () => {
    // Todos estos casos deben resolver a insufficient (sin valor confiable).
    for (const payload of [
        {},                                                    // sin campos
        { throughputState: 'measured' },                       // estado sin valor finito
        { throughputPerDay: NaN, throughputState: 'measured' },// valor no finito
        { throughputPerDay: 2, throughputState: 'insufficient' }, // estado gana: insufficient
        { throughputPerDay: '3', throughputState: 'measured' },// tipo inválido
    ]) {
        const m = deriveMissionOlaEta(payload);
        assert.equal(m.throughputState, 'insufficient');
    }
    // El valor no finito se normaliza a null.
    assert.equal(deriveMissionOlaEta({ throughputPerDay: NaN }).throughputPerDay, null);
    assert.equal(deriveMissionOlaEta({ throughputPerDay: '3' }).throughputPerDay, null);
});

test('el script cliente pinta issues/día (throughput) y la leyenda "sin datos suficientes"', () => {
    const src = missionOlaEtaClientScript();
    assert.ok(src.includes("'issues/día'"));            // unidad de throughput
    assert.ok(src.includes('throughputState'));         // gate por estado
    assert.ok(src.includes('throughputPerDay'));        // valor pintado
    assert.ok(src.includes('sin datos suficientes'));   // leyenda insufficient
});

test('el script cliente NO usa innerHTML para pintar mission-vel-value (R-1 / G-UX-6)', () => {
    const src = missionOlaEtaClientScript();
    // Fuente única XSS-safe: nodo de texto + span de unidad por DOM, nunca una
    // asignación `.innerHTML = ...` (la palabra puede aparecer en comentarios).
    assert.ok(!/\.innerHTML\s*=/.test(src), 'no debe asignar innerHTML');
    assert.ok(src.includes('createTextNode'));
    assert.ok(src.includes('setMzValueUnit'));
});

// -----------------------------------------------------------------------------
// #4452 — la barra del encabezado representa EXCLUSIVAMENTE el % de avance de la
// ola (fuente única `avancePct`), desacoplada de la distribución por estado. El
// client script fija `#mission-bar-progress`.style.width desde avancePct
// clampeado [0,100] (null → 0%). Se evalúa el script en un DOM falso y se
// verifica el ancho resultante (CA-1/CA-4).
// -----------------------------------------------------------------------------

test('__applyMissionOlaEta fija el ancho de #mission-bar-progress desde avancePct clampeado [0,100]', () => {
    const src = missionOlaEtaClientScript();
    const bar = { style: { width: '0%' } };
    const pctEl = { textContent: '' };
    const elements = { 'mission-bar-progress': bar, 'mission-avance-pct': pctEl };
    const fakeDoc = {
        getElementById: (id) => (Object.prototype.hasOwnProperty.call(elements, id) ? elements[id] : null),
        createTextNode: (t) => ({ nodeValue: String(t) }),
        createElement: () => ({ className: '', textContent: '', appendChild() {} }),
    };
    const fakeWin = {};
    const noop = () => 0;
    // Ejecuta el IIFE del client script inyectando window/document/setInterval
    // controlados (setInterval no-op para no dejar timers vivos en el runner).
    const runner = new Function('window', 'document', 'setInterval', src);
    runner(fakeWin, fakeDoc, noop);
    assert.equal(typeof fakeWin.__applyMissionOlaEta, 'function');

    // 42 → "42%"
    fakeWin.__applyMissionOlaEta({ etaSource: 'fallback', totalPct: 42 });
    assert.equal(bar.style.width, '42%');

    // 150 → "100%" (clamp superior)
    fakeWin.__applyMissionOlaEta({ etaSource: 'fallback', totalPct: 150 });
    assert.equal(bar.style.width, '100%');

    // avancePct null (totalPct ausente) → "0%"
    fakeWin.__applyMissionOlaEta({ etaSource: 'fallback' });
    assert.equal(bar.style.width, '0%');

    // valor negativo → clamp inferior "0%"
    fakeWin.__applyMissionOlaEta({ etaSource: 'fallback', totalPct: -10 });
    assert.equal(bar.style.width, '0%');
});

test('el client script fija la barra por style.width numérico, nunca innerHTML (SEC #1,#2)', () => {
    const src = missionOlaEtaClientScript();
    assert.ok(src.includes('mission-bar-progress'));
    assert.ok(src.includes('bar.style.width'));
    // ningún id segmentado por distribución sobrevive en el emisor del banner.
    assert.ok(!src.includes('mission-bar-done'));
    assert.ok(!src.includes('mission-bar-active'));
    assert.ok(!src.includes('mission-bar-blocked'));
    assert.ok(!src.includes('mission-bar-queue'));
});

// -----------------------------------------------------------------------------
// #4450 (AC-5) — verificación estática de fuente única: el ÚNICO writer JS del id
// `mission-vel-value` es el client script de este módulo. Ninguna vista debe
// escribir ese id por su cuenta (evita reintroducir la divergencia de #4296).
// -----------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');

test('ninguna vista escribe mission-vel-value por JS (fuente única = mission-ola-eta.js)', () => {
    const viewsDir = path.join(__dirname, '..', '..', 'views', 'dashboard');
    const files = fs.readdirSync(viewsDir).filter((f) => f.endsWith('.js'));
    // Un writer JS toma el nodo por id y lo muta. El markup estático (SSR) que
    // sólo declara `id="mission-vel-value"` y los comentarios NO cuentan.
    const jsWriterRe = /getElementById\(['"]mission-vel-value['"]\)/;
    for (const f of files) {
        const src = fs.readFileSync(path.join(viewsDir, f), 'utf8');
        assert.ok(!jsWriterRe.test(src), `la vista ${f} no debe escribir mission-vel-value por JS`);
    }
});

// -----------------------------------------------------------------------------
// #4500 — Timeline: marcador "ahora", anotación de velocidad y sparkline de ritmo.
// El client script posiciona el marcador (#mission-tl-now) y la anotación de
// velocidad (#mission-vel-annot) por avancePct clampeado, y dibuja el sparkline
// de ritmo (delta) client-side por DOM/SVG. Se evalúa el script en un DOM falso.
// -----------------------------------------------------------------------------

function fakeNode() {
    return {
        _attrs: {}, _children: [], className: '', textContent: '', style: {},
        get firstChild() { return this._children.length ? this._children[0] : null; },
        appendChild(c) { this._children.push(c); return c; },
        removeChild(c) { const i = this._children.indexOf(c); if (i >= 0) this._children.splice(i, 1); return c; },
        setAttribute(k, v) { this._attrs[k] = String(v); },
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    };
}

function bootClientScript(elements) {
    const src = missionOlaEtaClientScript();
    const fakeDoc = {
        getElementById: (id) => (Object.prototype.hasOwnProperty.call(elements, id) ? elements[id] : null),
        createTextNode: (t) => ({ nodeValue: String(t) }),
        createElement: () => fakeNode(),
        createElementNS: () => fakeNode(),
    };
    const fakeWin = {};
    const runner = new Function('window', 'document', 'setInterval', src);
    runner(fakeWin, fakeDoc, () => 0);
    return fakeWin;
}

test('#4500 — el marcador "ahora" se posiciona por avancePct clampeado [0,100] con aria-label textual', () => {
    const nowMark = fakeNode();
    const velAnnot = fakeNode();
    const elements = {
        'mission-bar-progress': { style: { width: '0%' } },
        'mission-avance-pct': fakeNode(),
        'mission-tl-now': nowMark,
        'mission-vel-annot': velAnnot,
        'mission-spark-plot': fakeNode(),
        'mission-spark-note': fakeNode(),
        'mission-spark': fakeNode(),
    };
    const win = bootClientScript(elements);

    win.__applyMissionOlaEta({ etaSource: 'fallback', totalPct: 64 });
    assert.equal(nowMark.style.left, '64%');
    assert.equal(velAnnot.style.left, '64%', 'la anotación de velocidad ancla al marcador');
    assert.equal(nowMark.getAttribute('aria-label'), 'Avance de la ola: 64%');
    assert.equal(nowMark.getAttribute('title'), 'Avance de la ola: 64%');

    win.__applyMissionOlaEta({ etaSource: 'fallback', totalPct: 150 });
    assert.equal(nowMark.style.left, '100%', 'clamp superior');

    // null (totalPct ausente) → cerca del inicio (0%) + label "sin dato aún"
    win.__applyMissionOlaEta({ etaSource: 'fallback' });
    assert.equal(nowMark.style.left, '0%');
    assert.equal(nowMark.getAttribute('aria-label'), 'Avance de la ola: sin dato aún');
});

test('#4500 — sparkline: <2 puntos degrada a placeholder "datos insuficientes" sin romper', () => {
    const plot = fakeNode();
    const note = fakeNode();
    const spark = fakeNode();
    const elements = {
        'mission-bar-progress': { style: { width: '0%' } },
        'mission-avance-pct': fakeNode(),
        'mission-tl-now': fakeNode(),
        'mission-spark-plot': plot,
        'mission-spark-note': note,
        'mission-spark': spark,
    };
    const win = bootClientScript(elements);

    // Sin serie → placeholder (línea punteada + nota).
    win.__applyMissionOlaEta({ etaSource: 'fallback', totalPct: 5 });
    assert.equal(note.textContent, 'datos insuficientes');
    assert.equal(plot._children.length, 1, 'dibuja el rail placeholder');
    assert.equal(spark.getAttribute('aria-label'), 'Ritmo de entrega: datos insuficientes');

    // Un solo punto (0 deltas) → sigue placeholder.
    win.__applyMissionOlaEta({ etaSource: 'fallback', totalPct: 5, series: [{ ts: 1, avancePct: 5 }] });
    assert.equal(note.textContent, 'datos insuficientes');
});

test('#4500 — sparkline: con serie suficiente dibuja polyline y calcula tendencia', () => {
    const plot = fakeNode();
    const note = fakeNode();
    const spark = fakeNode();
    const elements = {
        'mission-bar-progress': { style: { width: '0%' } },
        'mission-avance-pct': fakeNode(),
        'mission-tl-now': fakeNode(),
        'mission-spark-plot': plot,
        'mission-spark-note': note,
        'mission-spark': spark,
    };
    const win = bootClientScript(elements);

    // Deltas crecientes (2,3,10,20) → acelerando.
    const series = [
        { ts: 1, avancePct: 0 },
        { ts: 2, avancePct: 2 },
        { ts: 3, avancePct: 5 },
        { ts: 4, avancePct: 15 },
        { ts: 5, avancePct: 35 },
    ];
    win.__applyMissionOlaEta({ etaSource: 'fallback', totalPct: 35, series });
    assert.equal(plot._children.length, 1, 'un <svg> con la polyline');
    const svg = plot._children[0];
    assert.equal(svg._children.length, 1);
    const poly = svg._children[0];
    assert.ok(poly.getAttribute('points'), 'la polyline tiene puntos');
    assert.equal(note.textContent, 'acelerando');
    assert.equal(spark.getAttribute('aria-label'), 'Ritmo de entrega: acelerando');
});

// -----------------------------------------------------------------------------
// #4500 — Guardias estáticas: el markup del banner conserva los IDs hidratables
// y suma los nodos nuevos del Timeline (marcador, anotaciones, sparkline). Se
// verifica sobre el SSR canónico (pipeline-redesign.js) y el fallback (home.js),
// que deben declarar los mismos IDs para no divergir (#4499).
// -----------------------------------------------------------------------------

test('#4500 — el banner (SSR y fallback) conserva los IDs hidratables y suma los del Timeline', () => {
    const viewsDir = path.join(__dirname, '..', '..', 'views', 'dashboard');
    const requiredIds = [
        // hidratables preexistentes (no se pueden perder)
        'mission-started-value', 'mission-eta-value', 'mission-vel-value',
        'mission-delivered-value', 'mission-avance-pct', 'mission-bar-progress',
        'mission-leg-done', 'mission-leg-active', 'mission-leg-blocked', 'mission-leg-queue',
        // nuevos del Timeline
        'mission-timeline', 'mission-tl-now', 'mission-vel-annot',
        'mission-spark', 'mission-spark-plot', 'mission-spark-note',
    ];
    for (const f of ['pipeline-redesign.js', 'home.js']) {
        const src = fs.readFileSync(path.join(viewsDir, f), 'utf8');
        for (const id of requiredIds) {
            assert.ok(src.includes(`id="${id}"`), `${f} debe declarar id="${id}"`);
        }
        // las 4 stat-cards viejas ya no se renderizan como tiles independientes.
        assert.ok(!src.includes('class="mz-mission-metrics"'), `${f} no debe conservar .mz-mission-metrics`);
    }
});

test('#4500 — guardia CSS: toda copia que estiliza .mz-mission también estiliza el Timeline', () => {
    // El bloque COMPLETO del CSS del banner (no un override de media-query suelto)
    // está duplicado en theme.css + 4 vistas (lección #4499/#4492). Se ancla por
    // `.mz-prog-bar {`, presente sólo en las copias completas; cada una DEBE
    // declarar también `.mz-timeline {` y `.mz-spark {` o el Timeline se ve roto
    // en esa ventana. Las vistas satélite con sólo un override toman el CSS del
    // theme global, ya cubierto.
    const viewsDir = path.join(__dirname, '..', '..', 'views', 'dashboard');
    const files = fs.readdirSync(viewsDir).filter((f) => f.endsWith('.js') || f.endsWith('.css'));
    let copies = 0;
    for (const f of files) {
        const src = fs.readFileSync(path.join(viewsDir, f), 'utf8');
        if (!src.includes('.mz-prog-bar {')) continue; // no tiene el bloque completo → no aplica
        copies++;
        assert.ok(src.includes('.mz-timeline {'), `${f} tiene el bloque del banner pero le falta .mz-timeline`);
        assert.ok(src.includes('.mz-spark {'), `${f} tiene el bloque del banner pero le falta .mz-spark`);
    }
    assert.ok(copies >= 5, `se esperaban ≥5 copias completas del CSS del banner, se hallaron ${copies}`);
});
