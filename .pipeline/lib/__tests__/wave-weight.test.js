'use strict';

// =============================================================================
// Tests de la ponderación del avance de ola (#5836).
//
// Cubren los 6 criterios de aceptación del issue:
//   CA-1  partir un issue no mueve el avance (±1 pp)
//   CA-2  el avance pondera por `size:*`
//   CA-3  un padre cubierto por sus hijos no aporta peso propio
//   CA-4  la cascada de dos niveles no multiplica el peso
//   CA-5  la caída por altas se distingue del retroceso y se anota
//   CA-6  regresión con la topología real #5340 → #5440 → … → #5805
//
// FIXTURES HARDCODEADOS, A PROPÓSITO. La topología de CA-6 existe hoy en
// `waves.json`, pero leerla en runtime haría el test flaky por construcción: la
// ola muta a diario y los issues se cierran. Acá se congela la genealogía tal
// como fue medida en la fase `validacion` (2026-08-12).
// =============================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const waveWeight = require('../wave-weight');
const waveProgress = require('../wave-progress');
const waveRenderer = require('../wave-renderer');

const { computeWaveWeights, weightedProgress } = waveWeight;
const { renderProgressDeltaNote } = waveRenderer._internal;

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Construye un issue con la forma que emite `wave-snapshot.buildWaveSnapshot`
 * en `issuesOut` (id + title + labels + pct + isClosed son los únicos campos
 * que la ponderación mira).
 */
function mkIssue(id, opts = {}) {
    const { parent = null, size = null, pct = 0, closed = false } = opts;
    return {
        id,
        title: parent === null ? `Issue ${id}` : `[Split de #${parent}] Trabajo de ${id}`,
        labels: size ? [size] : [],
        pct: closed ? 100 : pct,
        isClosed: closed,
    };
}

/** Atajo: peso + avance en una sola pasada, como hace el snapshot real. */
function progressOf(issues) {
    const w = computeWaveWeights(issues);
    return { ...weightedProgress(issues, w.weights), weighting: w };
}

// =============================================================================
// CA-1 — partir un issue NO mueve el avance de la ola
// =============================================================================

test('CA-1: partir un issue abierto en 3 hijos deja el avance idéntico', () => {
    // Escenario Gherkin literal: 10 issues, 5 cerrados, avance 50%.
    const base = [];
    for (let i = 1; i <= 5; i += 1) base.push(mkIssue(100 + i, { size: 'size:medium', closed: true }));
    for (let i = 1; i <= 5; i += 1) base.push(mkIssue(200 + i, { size: 'size:medium' }));

    const antes = progressOf(base);
    assert.strictEqual(antes.totalPct, 50, 'la ola arranca en 50%');

    // Se parte #201 en 3 hijos que se agregan a la ola. El padre queda ABIERTO
    // y dentro de la ola (es exactamente lo que hace el pipeline hoy).
    const despues = base.concat([
        mkIssue(301, { parent: 201, size: 'size:medium' }),
        mkIssue(302, { parent: 201, size: 'size:medium' }),
        mkIssue(303, { parent: 201, size: 'size:medium' }),
    ]);

    const post = progressOf(despues);
    assert.strictEqual(post.totalPct, 50, 'partir no mueve la aguja');
    // Y no es casualidad de redondeo: el denominador es EXACTAMENTE el mismo.
    assert.strictEqual(post.totalWeight, antes.totalWeight,
        'el peso total se conserva: un split reparte trabajo, no lo crea');
});

test('CA-1: partir en hijos de tamaños distintos tampoco mueve el avance', () => {
    // El padre es `size:grande` (5) y los hijos declaran 2+2+1 = 5: el reparto
    // es proporcional y el subárbol sigue pesando lo mismo que pesaba el padre.
    const base = [
        mkIssue(1, { size: 'size:medium', closed: true }),
        mkIssue(2, { size: 'size:grande' }),
    ];
    const antes = progressOf(base);

    const despues = base.concat([
        mkIssue(10, { parent: 2, size: 'size:medium' }),
        mkIssue(11, { parent: 2, size: 'size:medium' }),
        mkIssue(12, { parent: 2, size: 'size:simple' }),
    ]);
    const post = progressOf(despues);

    assert.strictEqual(post.totalPct, antes.totalPct);
    assert.strictEqual(post.totalWeight, antes.totalWeight);
});

test('CA-1: la cascada de un split de un split tampoco mueve la aguja', () => {
    // El caso que motivó el issue: los hijos se vuelven a partir. Cada nivel
    // extra debería ser neutro, si no la cascada multiplica el denominador.
    const base = [
        mkIssue(1, { size: 'size:medium', closed: true }),
        mkIssue(2, { size: 'size:medium' }),
    ];
    const nivel1 = base.concat([
        mkIssue(10, { parent: 2, size: 'size:medium' }),
        mkIssue(11, { parent: 2, size: 'size:medium' }),
    ]);
    const nivel2 = nivel1.concat([
        mkIssue(100, { parent: 10, size: 'size:medium' }),
        mkIssue(101, { parent: 10, size: 'size:medium' }),
        mkIssue(102, { parent: 10, size: 'size:medium' }),
    ]);

    const p0 = progressOf(base);
    const p1 = progressOf(nivel1);
    const p2 = progressOf(nivel2);

    assert.strictEqual(p1.totalPct, p0.totalPct);
    assert.strictEqual(p2.totalPct, p0.totalPct);
    assert.strictEqual(p2.totalWeight, p0.totalWeight);
});

// =============================================================================
// CA-2 — el avance pondera por tamaño
// =============================================================================

test('CA-2: cerrar un size:grande mueve más la aguja que cerrar un size:simple', () => {
    // Gherkin: una ola con un `size:grande` y un `size:simple`, ambos abiertos.
    const grandeCerrado = [
        mkIssue(1, { size: 'size:grande', closed: true }),
        mkIssue(2, { size: 'size:simple' }),
    ];
    const simpleCerrado = [
        mkIssue(1, { size: 'size:grande' }),
        mkIssue(2, { size: 'size:simple', closed: true }),
    ];

    const conGrande = progressOf(grandeCerrado).totalPct;
    const conSimple = progressOf(simpleCerrado).totalPct;

    // 5/(5+1) = 83% vs 1/(5+1) = 17%.
    assert.ok(conGrande > 50, `cerrar el grande deja el avance > 50% (fue ${conGrande})`);
    assert.ok(conSimple < 50, `cerrar el simple deja el avance < 50% (fue ${conSimple})`);
    assert.ok(conGrande > conSimple, 'el grande pesa más que el simple');
    // Con conteo plano ambos habrían dado exactamente 50% — ese era el bug.
    assert.notStrictEqual(conGrande, 50);
});

test('CA-2: `size:large` y `size:grande` pesan IGUAL (mismo bucket L)', () => {
    // Medido en la ola viva: 10 issues con `size:large` y 6 con `size:grande`.
    // Si se trataran como buckets distintos, esos 16 quedarían mal pesados.
    const conLarge = progressOf([
        mkIssue(1, { size: 'size:large', closed: true }),
        mkIssue(2, { size: 'size:simple' }),
    ]).totalPct;
    const conGrande = progressOf([
        mkIssue(1, { size: 'size:grande', closed: true }),
        mkIssue(2, { size: 'size:simple' }),
    ]).totalPct;

    assert.strictEqual(conLarge, conGrande, '`large` y `grande` colapsan al mismo peso');
});

test('CA-2: un issue sin `size:*` pesa como medium y se contabiliza', () => {
    const sinSize = progressOf([
        mkIssue(1, { closed: true }),
        mkIssue(2, { size: 'size:simple' }),
    ]);
    const conMedium = progressOf([
        mkIssue(1, { size: 'size:medium', closed: true }),
        mkIssue(2, { size: 'size:simple' }),
    ]);

    assert.strictEqual(sinSize.totalPct, conMedium.totalPct,
        'el peso default empata con medium (acordado por PO/UX/guru)');
    // Y el operador puede verlo: el contador viaja al renderer.
    assert.strictEqual(sinSize.weighting.sinSize, 1);
    assert.strictEqual(conMedium.weighting.sinSize, 0);
});

// =============================================================================
// CA-3 — un padre cubierto por sus hijos no aporta peso propio
// =============================================================================

test('CA-3: el padre pesa 0 y aparece en coveredParents', () => {
    const issues = [
        mkIssue(1, { size: 'size:grande' }),
        mkIssue(10, { parent: 1, size: 'size:medium' }),
        mkIssue(11, { parent: 1, size: 'size:medium' }),
    ];
    const w = computeWaveWeights(issues);

    assert.strictEqual(w.weights.get(1), 0, 'el padre no aporta peso propio');
    assert.deepStrictEqual(w.coveredParents, [1]);
    assert.strictEqual(w.totalWeight, 5, 'el subárbol sigue pesando lo del padre');
});

test('CA-3: el avance del padre NO se suma aparte al de los hijos', () => {
    // El padre está a mitad de camino por su fase, pero su trabajo real ya vive
    // en los hijos. Contarlo aparte sería doble conteo (es el bug del issue).
    const issues = [
        mkIssue(1, { size: 'size:medium', pct: 80 }),
        mkIssue(10, { parent: 1, size: 'size:medium', pct: 0 }),
        mkIssue(11, { parent: 1, size: 'size:medium', pct: 0 }),
    ];
    const p = progressOf(issues);
    assert.strictEqual(p.totalPct, 0,
        'el avance del subárbol es el de los hijos, no el del padre');
});

test('CA-3: un hijo cuyo padre NO está en la ola conserva su peso propio', () => {
    // Default-deny al revés: sin el padre presente, el hijo es una raíz. Si lo
    // pusiéramos en 0 el trabajo desaparecería del denominador.
    const issues = [
        mkIssue(10, { parent: 999, size: 'size:medium' }),
        mkIssue(11, { parent: 999, size: 'size:medium' }),
    ];
    const w = computeWaveWeights(issues);
    assert.strictEqual(w.totalWeight, 4);
    assert.deepStrictEqual(w.coveredParents, []);
});

// =============================================================================
// CA-4 — la cascada de dos niveles no multiplica el peso
// =============================================================================

test('CA-4: con padre → 3 hijos → 3 nietos c/u, sólo los 9 nietos pesan', () => {
    // Gherkin del escenario de error, literal.
    const issues = [mkIssue(1, { size: 'size:grande' })];
    for (const hijo of [10, 11, 12]) {
        issues.push(mkIssue(hijo, { parent: 1, size: 'size:medium' }));
        for (let k = 0; k < 3; k += 1) {
            issues.push(mkIssue(hijo * 10 + k, { parent: hijo, size: 'size:medium' }));
        }
    }
    assert.strictEqual(issues.length, 13, 'padre + 3 hijos + 9 nietos');

    const w = computeWaveWeights(issues);

    // Ni el padre ni los 3 hijos suman peso propio al denominador.
    assert.strictEqual(w.weights.get(1), 0);
    for (const hijo of [10, 11, 12]) {
        assert.strictEqual(w.weights.get(hijo), 0, `el hijo ${hijo} no aporta peso propio`);
    }
    // Sólo los 9 nietos aportan, y en conjunto pesan lo que pesaba el padre.
    // Los pesos POR ISSUE conservan precisión completa a propósito (son ratios);
    // la cuantización se aplica al total publicado, así que acá comparamos con
    // tolerancia y dejamos la igualdad exacta para `totalWeight`.
    const pesoNietos = [...w.weights.entries()]
        .filter(([id]) => id > 99)
        .reduce((acc, [, v]) => acc + v, 0);
    assert.ok(Math.abs(pesoNietos - 5) < 1e-9, `los 9 nietos pesan 5 (fue ${pesoNietos})`);
    assert.strictEqual(w.totalWeight, 5, 'la cascada NO multiplica el peso');
    assert.deepStrictEqual(w.coveredParents.sort((a, b) => a - b), [1, 10, 11, 12]);
});

test('CA-4: un nodo que es hijo Y padre a la vez no aporta peso propio', () => {
    // El caso #5800: es split de #5793 y a la vez padre de #5803/#5804/#5805.
    // Una implementación ingenua de "el nivel más profundo aporta" se rompe acá.
    const issues = [
        mkIssue(1, { size: 'size:medium' }),
        mkIssue(10, { parent: 1, size: 'size:medium' }),
        mkIssue(100, { parent: 10, size: 'size:medium' }),
        mkIssue(101, { parent: 10, size: 'size:medium' }),
    ];
    const w = computeWaveWeights(issues);
    assert.strictEqual(w.weights.get(1), 0);
    assert.strictEqual(w.weights.get(10), 0, '#10 es intermedio: no aporta peso propio');
    assert.strictEqual(w.weights.get(100) + w.weights.get(101), 2);
    assert.strictEqual(w.totalWeight, 2);
});

// =============================================================================
// Conservación de peso (cambio requerido 3) — re-estimación, no retroceso
// =============================================================================

test('los hijos que declaran MÁS peso que el padre no inflan el denominador', () => {
    // El padre es `size:simple` (1) y los hijos declaran 2+2+2 = 6. El split
    // revela que el padre estaba subestimado, pero eso NO puede aparecer como
    // una caída de la ola: se reparte proporcionalmente y se deja registro.
    const issues = [
        mkIssue(1, { size: 'size:simple' }),
        mkIssue(10, { parent: 1, size: 'size:medium' }),
        mkIssue(11, { parent: 1, size: 'size:medium' }),
        mkIssue(12, { parent: 1, size: 'size:medium' }),
    ];
    const w = computeWaveWeights(issues);

    assert.strictEqual(w.totalWeight, 1, 'el denominador NO se infla');
    assert.strictEqual(w.inflations.length, 1, 'pero queda registrado para el histórico');
    assert.deepStrictEqual(w.inflations[0], { parent: 1, declared: 6, own: 1 });
});

test('hijos sin `size:*` reparten el peso del padre en partes iguales', () => {
    const issues = [
        mkIssue(1, { size: 'size:grande' }),
        mkIssue(10, { parent: 1 }),
        mkIssue(11, { parent: 1 }),
    ];
    const w = computeWaveWeights(issues);
    assert.strictEqual(w.totalWeight, 5);
    assert.strictEqual(w.weights.get(10), 2.5);
    assert.strictEqual(w.weights.get(11), 2.5);
});

// =============================================================================
// Robustez — el pipeline no puede morir por el cálculo del indicador
// =============================================================================

test('un ciclo de parentesco no cuelga ni evapora peso del denominador', () => {
    // A dice ser split de B y B dice ser split de A. Sin guard, ninguno sería
    // alcanzable desde una raíz y su peso desaparecería — el bug que este
    // issue combate, por otra puerta.
    const issues = [
        { id: 1, title: '[Split de #2] A', labels: ['size:medium'], pct: 0, isClosed: false },
        { id: 2, title: '[Split de #1] B', labels: ['size:medium'], pct: 0, isClosed: false },
    ];
    const w = computeWaveWeights(issues);
    assert.ok(w.totalWeight > 0, 'el peso no se evapora');
    assert.strictEqual(w.weights.size, 2);
});

test('un issue que se declara split de sí mismo se trata como raíz', () => {
    const issues = [{ id: 1, title: '[Split de #1] yo mismo', labels: [], pct: 0, isClosed: false }];
    const w = computeWaveWeights(issues);
    assert.strictEqual(w.totalWeight, waveWeight.DEFAULT_WEIGHT);
});

test('el peso total se cuantiza: el residuo de float no se filtra al indicador', () => {
    // Un padre de peso 5 repartido entre 3 hijos vuelve a sumar 4.999999999999999
    // en IEEE-754. Sin cuantizar, ese residuo llegaba a `classifyProgressDelta`
    // y un split neutro se reportaba como "caída por altas".
    const w = computeWaveWeights([
        mkIssue(1, { size: 'size:grande' }),
        mkIssue(10, { parent: 1 }),
        mkIssue(11, { parent: 1 }),
        mkIssue(12, { parent: 1 }),
    ]);
    assert.strictEqual(w.totalWeight, 5, 'el peso total es exacto, sin cola de float');
});

test('un split neutro NO se clasifica como caída por altas (regresión de float)', () => {
    const antes = computeWaveWeights([mkIssue(1, { size: 'size:grande' })]);
    const despues = computeWaveWeights([
        mkIssue(1, { size: 'size:grande' }),
        mkIssue(10, { parent: 1 }),
        mkIssue(11, { parent: 1 }),
        mkIssue(12, { parent: 1 }),
    ]);

    const d = waveProgress.classifyProgressDelta(
        { avancePct: 50, totalWeight: antes.totalWeight, issueCount: 1, formulaV: 2 },
        { avancePct: 49, totalWeight: despues.totalWeight, issueCount: 1, formulaV: 2 },
    );
    assert.strictEqual(d.kind, 'retroceso',
        'el denominador no creció: la baja es real, no una alta fantasma');
});

test('entrada inválida degrada sin throw', () => {
    for (const bad of [null, undefined, 'no soy un array', 42, {}]) {
        const w = computeWaveWeights(bad);
        assert.strictEqual(w.totalWeight, 0);
        assert.strictEqual(weightedProgress(bad, w.weights).totalPct, 0);
    }
    // Issues con id basura se descartan sin romper el resto.
    const w2 = computeWaveWeights([
        { id: 'x', labels: [] },
        { id: -1, labels: [] },
        mkIssue(1, { size: 'size:medium' }),
    ]);
    assert.strictEqual(w2.totalWeight, 2);
});

test('el pct se clampea a [0,100] y un pct basura cuenta como 0', () => {
    const issues = [
        { id: 1, title: '', labels: ['size:medium'], pct: 500, isClosed: false },
        { id: 2, title: '', labels: ['size:medium'], pct: 'NaN', isClosed: false },
    ];
    const p = progressOf(issues);
    assert.strictEqual(p.totalPct, 50, '(100 + 0) / 2');
});

// =============================================================================
// CA-6 — REGRESIÓN con la topología real (#5340 → #5440 → … → #5805)
// =============================================================================

// Genealogía congelada tal como fue medida en `validacion` el 2026-08-12.
// OJO: NO es la del enunciado del issue (que decía 13 nodos / 3 niveles). La
// medición encontró 17 nodos y 5 niveles, porque #5440 es a su vez split de
// #5340 y porque #5800 es hijo de #5793 Y padre de #5803/#5804/#5805.
const TOPOLOGIA_5440 = [
    { id: 5340, parent: null, size: 'size:medium' },
    { id: 5440, parent: 5340, size: null },
    { id: 5791, parent: 5440, size: null },
    { id: 5797, parent: 5791, size: null },
    { id: 5798, parent: 5791, size: null },
    { id: 5799, parent: 5791, size: null },
    { id: 5792, parent: 5440, size: null },
    { id: 5794, parent: 5792, size: 'size:simple' },
    { id: 5795, parent: 5792, size: null, closed: true },
    { id: 5796, parent: 5792, size: null },
    { id: 5793, parent: 5440, size: null },
    { id: 5801, parent: 5793, size: null },
    { id: 5802, parent: 5793, size: null },
    { id: 5800, parent: 5793, size: null },
    { id: 5803, parent: 5800, size: null },
    { id: 5804, parent: 5800, size: null, closed: true },
    { id: 5805, parent: 5800, size: null },
];

function topologiaIssues(hasta = TOPOLOGIA_5440.length) {
    return TOPOLOGIA_5440.slice(0, hasta).map((n) => mkIssue(n.id, {
        parent: n.parent,
        size: n.size,
        closed: !!n.closed,
    }));
}

test('CA-6: la topología real tiene 17 nodos y 5 niveles', () => {
    const issues = topologiaIssues();
    assert.strictEqual(issues.length, 17);
    const w = computeWaveWeights(issues);
    // #5340 → #5440 → #5793 → #5800 → #5803 = profundidad 4 (0-indexada).
    assert.strictEqual(w.maxDepth, 4, 'la cascada tiene 5 niveles, no 3');
});

test('CA-6: sólo las hojas aportan peso; los 6 nodos internos pesan 0', () => {
    const w = computeWaveWeights(topologiaIssues());

    const internos = [5340, 5440, 5791, 5792, 5793, 5800];
    for (const id of internos) {
        assert.strictEqual(w.weights.get(id), 0, `#${id} es intermedio y no debe aportar peso`);
    }
    assert.deepStrictEqual(w.coveredParents.sort((a, b) => a - b), internos);

    // Las 11 hojas se reparten EXACTAMENTE el peso propio de la raíz #5340.
    const hojas = [5794, 5795, 5796, 5797, 5798, 5799, 5801, 5802, 5803, 5804, 5805];
    assert.strictEqual(hojas.length, 11);
    for (const id of hojas) {
        assert.ok(w.weights.get(id) > 0, `#${id} es hoja y debe aportar peso`);
    }
    assert.ok(Math.abs(w.totalWeight - 2) < 1e-9,
        `17 entradas pesan lo que pesaba #5340 (2), no 17 — fue ${w.totalWeight}`);
});

test('CA-6: el avance es estable ANTES y DESPUÉS del split (regresión del incidente)', () => {
    // Reproduce el incidente del 2026-08-11: la ola tenía otros issues y el
    // subárbol de #5340 se fue partiendo en cascada. Con conteo plano, cada
    // alta hundía el indicador; con ponderación tiene que quedar clavado.
    const resto = [];
    for (let i = 1; i <= 5; i += 1) resto.push(mkIssue(900 + i, { size: 'size:medium', closed: true }));
    for (let i = 1; i <= 4; i += 1) resto.push(mkIssue(950 + i, { size: 'size:medium' }));

    // Estado inicial: sólo la raíz #5340, sin partir.
    const antes = progressOf(resto.concat([mkIssue(5340, { size: 'size:medium' })]));

    // Estado final: los 17 nodos de la cascada. #5795 y #5804 cerrados son
    // trabajo REAL terminado, así que el avance debe SUBIR, nunca bajar.
    const despues = progressOf(resto.concat(topologiaIssues()));

    assert.strictEqual(antes.totalWeight, despues.totalWeight,
        'el denominador NO se infla: 17 entradas pesan lo mismo que 1');
    assert.ok(despues.totalPct >= antes.totalPct,
        `partir + cerrar 2 hijos no puede bajar el avance (${antes.totalPct}% → ${despues.totalPct}%)`);

    // Y el bug original: con conteo plano el indicador se desplomaba.
    const planoAntes = Math.round((5 * 100) / 10);
    const planoDespues = Math.round(((5 + 2) * 100) / 26);
    assert.ok(planoDespues < planoAntes,
        'sanity: el conteo plano SÍ se desploma (50% → 27%), que es lo que arreglamos');
});

test('CA-6: cada alta intermedia del split mantiene el denominador constante', () => {
    // Se va agregando la topología nodo por nodo, como pasó en la realidad.
    // El peso total no puede moverse en ningún paso intermedio.
    let esperado = null;
    for (let n = 1; n <= TOPOLOGIA_5440.length; n += 1) {
        const w = computeWaveWeights(topologiaIssues(n));
        if (esperado === null) esperado = w.totalWeight;
        assert.ok(Math.abs(w.totalWeight - esperado) < 1e-9,
            `con ${n} nodos el peso total cambió (${w.totalWeight} vs ${esperado})`);
    }
});

// =============================================================================
// CA-5 — distinguir caída por altas de retroceso, y anotarlo
// =============================================================================

test('CA-5: caída con denominador creciendo se clasifica como `altas`', () => {
    const prev = { avancePct: 57, totalWeight: 200, issueCount: 95, formulaV: 2 };
    const curr = { avancePct: 52, totalWeight: 230, issueCount: 113, formulaV: 2 };
    const d = waveProgress.classifyProgressDelta(prev, curr);

    assert.strictEqual(d.kind, 'altas');
    assert.strictEqual(d.deltaPp, -5);
    assert.strictEqual(d.deltaIssues, 18);
});

test('CA-5: caída SIN crecer el denominador se clasifica como `retroceso`', () => {
    const prev = { avancePct: 57, totalWeight: 200, issueCount: 95, formulaV: 2 };
    const curr = { avancePct: 52, totalWeight: 200, issueCount: 95, formulaV: 2 };
    assert.strictEqual(waveProgress.classifyProgressDelta(prev, curr).kind, 'retroceso');
});

test('CA-5: puntos de fórmulas distintas se marcan como corte de serie', () => {
    // Un punto viejo (conteo plano, sin `formulaV`) contra uno nuevo: no son
    // comparables. Recalcular el viejo sería inventar el peso que nunca guardó.
    const prev = { avancePct: 57 };                              // legacy → v1
    const curr = { avancePct: 52, totalWeight: 230, formulaV: 2 };
    const d = waveProgress.classifyProgressDelta(prev, curr);

    assert.strictEqual(d.kind, 'series-break');
    assert.strictEqual(d.deltaWeight, null, 'no se atribuye causa entre fórmulas distintas');
});

test('CA-5: subida y estabilidad no se confunden con altas ni retroceso', () => {
    const base = { avancePct: 50, totalWeight: 100, issueCount: 10, formulaV: 2 };
    assert.strictEqual(
        waveProgress.classifyProgressDelta(base, { ...base, avancePct: 60 }).kind, 'avance');
    assert.strictEqual(
        waveProgress.classifyProgressDelta(base, { ...base }).kind, 'estable');
});

test('CA-5: sin peso ni conteo, una caída queda `unknown` (no se inventa causa)', () => {
    const prev = { avancePct: 57, formulaV: 2 };
    const curr = { avancePct: 52, formulaV: 2 };
    assert.strictEqual(waveProgress.classifyProgressDelta(prev, curr).kind, 'unknown');
});

test('CA-5: entradas inválidas no rompen la clasificación', () => {
    for (const bad of [null, undefined, 42, 'x', {}]) {
        assert.strictEqual(waveProgress.classifyProgressDelta(bad, bad).kind, 'unknown');
    }
});

// ─── Copy de la nota (CA-5, guidelines de UX) ──────────────────────────────

test('CA-5: la nota dice magnitud, unidad y causa, y niega el retroceso', () => {
    const nota = renderProgressDeltaNote({ kind: 'altas', deltaPp: -5, deltaIssues: 18 });

    assert.match(nota, /5 pp/, 'usa "pp" y no "%": la variación no es el valor');
    assert.match(nota, /18/, 'dice cuántas altas hubo');
    assert.match(nota, /no retroceso/, 'el texto porta la señal, no el color ni un emoji');
    assert.ok(nota.includes('−'), 'usa el minus real U+2212, no el guión ASCII');
});

test('CA-5: sólo se anota cuando la nota agrega información', () => {
    // Una subida o un movimiento normal no necesitan glosa.
    assert.strictEqual(renderProgressDeltaNote({ kind: 'avance', deltaPp: 3 }), '');
    assert.strictEqual(renderProgressDeltaNote({ kind: 'estable', deltaPp: 0 }), '');
    assert.strictEqual(renderProgressDeltaNote({ kind: 'retroceso', deltaPp: -3 }), '');
    assert.strictEqual(renderProgressDeltaNote({ kind: 'unknown', deltaPp: -3 }), '');
    assert.strictEqual(renderProgressDeltaNote(null), '');
    assert.strictEqual(renderProgressDeltaNote(undefined), '');
    // El corte de serie SÍ se avisa.
    assert.match(renderProgressDeltaNote({ kind: 'series-break', deltaPp: -9 }), /corte de serie/);
});

test('CA-5: sin conteo de altas la nota sigue siendo legible', () => {
    const nota = renderProgressDeltaNote({ kind: 'altas', deltaPp: -4, deltaIssues: null });
    assert.match(nota, /4 pp/);
    assert.match(nota, /no retroceso/);
});

// ─── Cableado end-to-end del delta ─────────────────────────────────────────

function tmpRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-test-'));
    fs.mkdirSync(path.join(root, '.pipeline'), { recursive: true });
    return root;
}

test('CA-5: appendSnapshotWithDelta compara contra el punto ANTERIOR, no contra sí mismo', () => {
    const root = tmpRoot();

    // Primer punto de la ola: no hay con qué comparar.
    const p1 = waveProgress.appendSnapshotWithDelta({
        pipelineRoot: root, waveKey: 9, avancePct: 57, now: 1000,
        totalWeight: 200, issueCount: 95, formulaV: 2,
    });
    assert.strictEqual(p1.written, true);
    assert.strictEqual(p1.delta, null, 'sin histórico previo no hay nota');

    // Segundo punto: baja el avance pero crece el denominador → altas.
    const p2 = waveProgress.appendSnapshotWithDelta({
        pipelineRoot: root, waveKey: 9, avancePct: 52, now: 2000,
        totalWeight: 230, issueCount: 113, formulaV: 2,
    });
    assert.strictEqual(p2.delta.kind, 'altas');
    assert.strictEqual(p2.delta.deltaPp, -5);
    assert.strictEqual(p2.delta.deltaIssues, 18);

    // Los dos puntos quedaron persistidos con su metadata.
    const snaps = waveProgress.readSnapshots({ pipelineRoot: root, waveKey: 9 });
    assert.strictEqual(snaps.length, 2);
    assert.strictEqual(snaps[1].totalWeight, 230);
    assert.strictEqual(snaps[1].formulaV, 2);
});

test('CA-5: appendSnapshotWithDelta ignora los puntos de OTRA ola', () => {
    const root = tmpRoot();
    waveProgress.appendSnapshotWithDelta({
        pipelineRoot: root, waveKey: 8, avancePct: 90, now: 1000,
        totalWeight: 10, issueCount: 5, formulaV: 2,
    });
    const p = waveProgress.appendSnapshotWithDelta({
        pipelineRoot: root, waveKey: 9, avancePct: 52, now: 2000,
        totalWeight: 230, issueCount: 113, formulaV: 2,
    });
    assert.strictEqual(p.delta, null, 'la ola 9 arranca su propia serie');
});

test('CA-5: un input inválido no escribe ni inventa delta', () => {
    const root = tmpRoot();
    const p = waveProgress.appendSnapshotWithDelta({
        pipelineRoot: root, waveKey: 0, avancePct: 52, now: 1000,
    });
    assert.strictEqual(p.written, false);
    assert.strictEqual(p.delta, null);
});

// ─── Compatibilidad hacia atrás del store ──────────────────────────────────

test('los registros viejos (sin peso ni formulaV) se siguen leyendo', () => {
    const root = tmpRoot();
    const file = path.join(root, '.pipeline', 'wave-progress.jsonl');
    fs.writeFileSync(file, [
        JSON.stringify({ ts: 1, waveKey: 9, avancePct: 57 }),          // legacy
        JSON.stringify({ ts: 2, waveKey: 9, avancePct: 52, totalWeight: 230, issueCount: 113, formulaV: 2 }),
    ].join('\n') + '\n');

    const snaps = waveProgress.readSnapshots({ pipelineRoot: root, waveKey: 9 });
    assert.strictEqual(snaps.length, 2, 'la serie vieja no se descarta');
    // El punto legacy conserva su forma exacta: los campos nuevos son aditivos.
    assert.deepStrictEqual(snaps[0], { ts: 1, waveKey: 9, avancePct: 57 });
    assert.strictEqual(snaps[1].formulaV, 2);
});
