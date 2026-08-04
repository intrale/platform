// =============================================================================
// split-orphan-reconciler.test.js — Issue #5516
//
// Unit del clasificador PURO `findSplitOrphans` (+ `parentOfSplitOrphan`,
// `groupByParent`): descubre desde una lista de issues de GitHub cuáles son
// hijos de split cuyo padre pertenece a la ola activa.
//
// Cubre los criterios de aceptación del issue:
//   - hijo con padre en la ola → se incorpora
//   - hijo con padre FUERA de la ola → no se toca (default-deny, SO-2)
//   - hijo YA en la ola → no-op idempotente
//   - hijo cerrado → excluido (SO-3)
//   - título malformado → excluido (SO-4)
//   - independencia total de `authorization_ttls` (CA-2): el módulo ni lo recibe
//
// Sin red: el módulo es puro y recibe los issues como parámetro.
//
// Ejecutar:
//   node --test .pipeline/lib/__tests__/split-orphan-reconciler.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sor = require('../split-orphan-reconciler');

// Helper: issue de GitHub con formato canónico de `/planner split`.
function child(number, parent, over = {}) {
    return {
        number,
        title: `[Split de #${parent}] parte de la historia madre`,
        body: `Historia madre: #${parent}\n\n## Criterios\n- algo`,
        state: 'OPEN',
        ...over,
    };
}

function plain(number, over = {}) {
    return { number, title: 'Un issue cualquiera', body: 'sin referencias', state: 'OPEN', ...over };
}

// Atajo: sólo los pares child/parent del resultado.
function pairs(res) {
    return res.orphans.map((o) => [o.child, o.parent]);
}

// -----------------------------------------------------------------------------
// Escenario principal: split hecho por un agente del pipeline
// -----------------------------------------------------------------------------

test('findSplitOrphans: hijos con padre en la ola activa → se incorporan', () => {
    // Escenario Gherkin del issue: #5452 en la ola, hijos #5458/#5459/#5460.
    const issues = [child(5458, 5452), child(5459, 5452), child(5460, 5452)];
    const res = sor.findSplitOrphans(issues, { activeWaveIssues: [5451, 5452, 5453] });
    assert.deepEqual(pairs(res), [[5458, 5452], [5459, 5452], [5460, 5452]]);
    assert.equal(res.truncated, false);
    assert.equal(res.reason, null);
});

test('findSplitOrphans: NO depende de authorization_ttls — no recibe el mapa y descubre igual', () => {
    // CA-2: con `authorization_ttls` vacío (estado real medido) el reconciliador
    // igual descubre los hijos. La firma del módulo ni siquiera acepta el mapa.
    const res = sor.findSplitOrphans([child(5458, 5452)], { activeWaveIssues: [5452] });
    assert.deepEqual(pairs(res), [[5458, 5452]]);
});

test('findSplitOrphans: resultado ordenado por hijo ascendente', () => {
    const issues = [child(5460, 5452), child(5458, 5452), child(5459, 5452)];
    const res = sor.findSplitOrphans(issues, { activeWaveIssues: [5452] });
    assert.deepEqual(res.orphans.map((o) => o.child), [5458, 5459, 5460]);
});

test('findSplitOrphans: hijos de DISTINTOS padres, ambos en la ola → ambos', () => {
    const issues = [child(5458, 5452), child(5419, 5451)];
    const res = sor.findSplitOrphans(issues, { activeWaveIssues: [5451, 5452] });
    assert.deepEqual(pairs(res), [[5419, 5451], [5458, 5452]]);
});

// -----------------------------------------------------------------------------
// SO-2 — default-deny: padre fuera de la ola activa
// -----------------------------------------------------------------------------

test('findSplitOrphans: padre FUERA de la ola activa → NO se incorpora', () => {
    // Escenario Gherkin: #4200 no pertenece a la ola.
    const res = sor.findSplitOrphans([child(4201, 4200)], { activeWaveIssues: [5451, 5452] });
    assert.deepEqual(res.orphans, []);
    assert.equal(res.truncated, false);
});

test('findSplitOrphans: mixto — sólo el hijo cuyo padre está en la ola', () => {
    const issues = [child(5458, 5452), child(4201, 4200)];
    const res = sor.findSplitOrphans(issues, { activeWaveIssues: [5452] });
    assert.deepEqual(pairs(res), [[5458, 5452]]);
});

test('findSplitOrphans: ola activa vacía → nada se incorpora', () => {
    const res = sor.findSplitOrphans([child(5458, 5452)], { activeWaveIssues: [] });
    assert.deepEqual(res.orphans, []);
});

test('findSplitOrphans: sin ctx → nada se incorpora (default-deny)', () => {
    assert.deepEqual(sor.findSplitOrphans([child(5458, 5452)]).orphans, []);
});

// -----------------------------------------------------------------------------
// Idempotencia
// -----------------------------------------------------------------------------

test('findSplitOrphans: hijo YA en la ola → no-op idempotente', () => {
    // Segunda corrida tras una incorporación previa: los hijos ya están en la ola.
    const issues = [child(5458, 5452), child(5459, 5452)];
    const res = sor.findSplitOrphans(issues, { activeWaveIssues: [5452, 5458, 5459] });
    assert.deepEqual(res.orphans, [], 'no debe reincorporar hijos ya presentes');
});

test('findSplitOrphans: corrida idempotente — parcial ya incorporado, sólo el nuevo', () => {
    const issues = [child(5458, 5452), child(5459, 5452)];
    const res = sor.findSplitOrphans(issues, { activeWaveIssues: [5452, 5458] });
    assert.deepEqual(pairs(res), [[5459, 5452]]);
});

test('findSplitOrphans: issue duplicado en el input → una sola incorporación', () => {
    const issues = [child(5458, 5452), child(5458, 5452)];
    const res = sor.findSplitOrphans(issues, { activeWaveIssues: [5452] });
    assert.deepEqual(pairs(res), [[5458, 5452]]);
});

// -----------------------------------------------------------------------------
// SO-3 — sólo issues abiertos
// -----------------------------------------------------------------------------

test('findSplitOrphans: hijo CERRADO → excluido', () => {
    const res = sor.findSplitOrphans([child(5458, 5452, { state: 'CLOSED' })], { activeWaveIssues: [5452] });
    assert.deepEqual(res.orphans, []);
});

test('findSplitOrphans: state en minúscula "open" también cuenta como abierto', () => {
    const res = sor.findSplitOrphans([child(5458, 5452, { state: 'open' })], { activeWaveIssues: [5452] });
    assert.deepEqual(pairs(res), [[5458, 5452]]);
});

test('findSplitOrphans: state ausente o desconocido → excluido (default-deny)', () => {
    const sinState = sor.findSplitOrphans([child(5458, 5452, { state: undefined })], { activeWaveIssues: [5452] });
    assert.deepEqual(sinState.orphans, []);
    const raro = sor.findSplitOrphans([child(5459, 5452, { state: 'MERGED' })], { activeWaveIssues: [5452] });
    assert.deepEqual(raro.orphans, []);
});

// -----------------------------------------------------------------------------
// SO-4 / SO-1 — título malformado, input no confiable
// -----------------------------------------------------------------------------

test('findSplitOrphans: título malformado sin referencia en body → excluido', () => {
    const malos = [
        plain(5470, { title: '[Split de #] falta el numero' }),
        plain(5471, { title: '[Split de #abc] numero no numerico' }),
        plain(5472, { title: 'Split de #5452 sin corchetes ni body' }),
        plain(5473, { title: '' }),
        plain(5474, { title: null }),
    ];
    const res = sor.findSplitOrphans(malos, { activeWaveIssues: [5452] });
    assert.deepEqual(res.orphans, [], 'ningún título malformado debe incorporarse');
});

test('findSplitOrphans: issue sin relación de split → excluido', () => {
    const res = sor.findSplitOrphans([plain(5480)], { activeWaveIssues: [5452] });
    assert.deepEqual(res.orphans, []);
});

test('findSplitOrphans: número de issue inválido → excluido (SO-1)', () => {
    const issues = [
        child(0, 5452),
        child(-3, 5452),
        { number: 'no-numero', title: '[Split de #5452] x', body: '', state: 'OPEN' },
        { number: 1.5, title: '[Split de #5452] x', body: '', state: 'OPEN' },
    ];
    assert.deepEqual(sor.findSplitOrphans(issues, { activeWaveIssues: [5452] }).orphans, []);
});

test('findSplitOrphans: auto-referencia hijo === padre → excluido (SO-6)', () => {
    const res = sor.findSplitOrphans([child(5452, 5452)], { activeWaveIssues: [5452] });
    assert.deepEqual(res.orphans, []);
});

test('findSplitOrphans: input no-array o vacío → resultado vacío sin lanzar', () => {
    assert.deepEqual(sor.findSplitOrphans(null, { activeWaveIssues: [5452] }).orphans, []);
    assert.deepEqual(sor.findSplitOrphans([], { activeWaveIssues: [5452] }).orphans, []);
    assert.deepEqual(sor.findSplitOrphans('nope', { activeWaveIssues: [5452] }).orphans, []);
});

test('findSplitOrphans: entradas basura en la lista no rompen la clasificación', () => {
    const issues = [null, undefined, 42, 'texto', {}, child(5458, 5452)];
    const res = sor.findSplitOrphans(issues, { activeWaveIssues: [5452] });
    assert.deepEqual(pairs(res), [[5458, 5452]]);
});

// -----------------------------------------------------------------------------
// Vía body (segunda vía de descubrimiento)
// -----------------------------------------------------------------------------

test('findSplitOrphans: sin título canónico pero con "Split de #N" en el body → se incorpora', () => {
    const issue = plain(5461, { title: 'Parte 4 de la historia madre', body: 'Split de #5452\n\nCriterios...' });
    const res = sor.findSplitOrphans([issue], { activeWaveIssues: [5452] });
    assert.deepEqual(pairs(res), [[5461, 5452]]);
});

test('findSplitOrphans: "Tracked by #N" en el body también declara padre', () => {
    const issue = plain(5462, { title: 'Parte 5', body: 'Tracked by #5452' });
    const res = sor.findSplitOrphans([issue], { activeWaveIssues: [5452] });
    assert.deepEqual(pairs(res), [[5462, 5452]]);
});

test('findSplitOrphans: body con DOS padres candidatos → ambiguo, excluido (SO-4)', () => {
    const issue = plain(5463, { title: 'Parte 6', body: 'Split de #5452\nTracked by #5451' });
    const res = sor.findSplitOrphans([issue], { activeWaveIssues: [5451, 5452] });
    assert.deepEqual(res.orphans, [], 'ambigüedad de padre debe caer en default-deny');
});

test('parentOfSplitOrphan: el TÍTULO manda sobre el body si difieren', () => {
    const issue = { number: 5464, title: '[Split de #5452] x', body: 'Tracked by #4200', state: 'OPEN' };
    assert.equal(sor.parentOfSplitOrphan(issue), 5452);
});

test('findSplitOrphans: "Closes #N" en el body NO declara padre (no es procedencia)', () => {
    const issue = plain(5465, { title: 'Parte 7', body: 'Closes #5452' });
    assert.deepEqual(sor.findSplitOrphans([issue], { activeWaveIssues: [5452] }).orphans, []);
});

// -----------------------------------------------------------------------------
// SO-5 — amplificación acotada
// -----------------------------------------------------------------------------

test('findSplitOrphans: expansión transitiva — hijo de hijo se incorpora en la misma corrida', () => {
    const issues = [child(5458, 5452), child(5470, 5458)];
    const res = sor.findSplitOrphans(issues, { activeWaveIssues: [5452] });
    assert.deepEqual(pairs(res), [[5458, 5452], [5470, 5458]]);
    assert.equal(res.truncated, false);
});

test('findSplitOrphans: maxDepth corta la expansión transitiva y marca truncated', () => {
    const issues = [child(5458, 5452), child(5470, 5458)];
    const res = sor.findSplitOrphans(issues, { activeWaveIssues: [5452], maxDepth: 1 });
    assert.deepEqual(pairs(res), [[5458, 5452]]);
    assert.equal(res.truncated, true);
    assert.equal(res.reason, 'max_depth');
});

test('findSplitOrphans: la profundidad NO depende del orden del array de entrada', () => {
    // Regresión: si `reachable` se mutara dentro de la misma pasada, el nieto
    // listado DESPUÉS del hijo entraría en la ronda 1 y el listado ANTES no.
    // Cada ronda debe ser un nivel BFS puro → mismo resultado en ambos órdenes.
    const nietoDespues = [child(5458, 5452), child(5470, 5458)];
    const nietoAntes = [child(5470, 5458), child(5458, 5452)];
    const a = sor.findSplitOrphans(nietoDespues, { activeWaveIssues: [5452], maxDepth: 1 });
    const b = sor.findSplitOrphans(nietoAntes, { activeWaveIssues: [5452], maxDepth: 1 });
    assert.deepEqual(pairs(a), [[5458, 5452]]);
    assert.deepEqual(pairs(a), pairs(b), 'el orden del input no debe cambiar la profundidad efectiva');
    assert.equal(a.truncated, b.truncated);
});

test('findSplitOrphans: maxIncorporations acota la cantidad por corrida', () => {
    const issues = [child(5458, 5452), child(5459, 5452), child(5460, 5452)];
    const res = sor.findSplitOrphans(issues, { activeWaveIssues: [5452], maxIncorporations: 2 });
    assert.equal(res.orphans.length, 2);
    assert.equal(res.truncated, true);
    assert.equal(res.reason, 'max_incorporations');
});

test('findSplitOrphans: candidato pendiente con padre fuera de la ola NO marca truncated', () => {
    // Sólo el default-deny debe descartarlo; no es un truncado por profundidad.
    const issues = [child(5458, 5452), child(4201, 4200)];
    const res = sor.findSplitOrphans(issues, { activeWaveIssues: [5452], maxDepth: 1 });
    assert.deepEqual(pairs(res), [[5458, 5452]]);
    assert.equal(res.truncated, false, 'padre fuera de la ola es deny, no truncado');
    assert.equal(res.reason, null);
});

test('findSplitOrphans: maxDepth/maxIncorporations se clampean a los caps absolutos', () => {
    const issues = [child(5458, 5452)];
    // Valores absurdos no deben romper ni desbordar.
    const bajo = sor.findSplitOrphans(issues, { activeWaveIssues: [5452], maxDepth: -5, maxIncorporations: 0 });
    assert.deepEqual(pairs(bajo), [[5458, 5452]]);
    const alto = sor.findSplitOrphans(issues, {
        activeWaveIssues: [5452],
        maxDepth: 99999,
        maxIncorporations: 99999,
    });
    assert.deepEqual(pairs(alto), [[5458, 5452]]);
});

test('findSplitOrphans: ciclo padre↔hijo declarado no cuelga', () => {
    // #A dice ser hijo de #B y #B dice ser hijo de #A, ninguno en la ola.
    const issues = [child(6001, 6002), child(6002, 6001)];
    const res = sor.findSplitOrphans(issues, { activeWaveIssues: [5452] });
    assert.deepEqual(res.orphans, []);
});

// -----------------------------------------------------------------------------
// groupByParent
// -----------------------------------------------------------------------------

test('groupByParent: agrupa hijos por padre, ordenado y sin duplicados', () => {
    const orphans = [
        { child: 5460, parent: 5452 },
        { child: 5458, parent: 5452 },
        { child: 5419, parent: 5451 },
        { child: 5458, parent: 5452 },
    ];
    assert.deepEqual(sor.groupByParent(orphans), [
        { parent: 5451, children: [5419] },
        { parent: 5452, children: [5458, 5460] },
    ]);
});

test('groupByParent: input inválido → lista vacía sin lanzar', () => {
    assert.deepEqual(sor.groupByParent(null), []);
    assert.deepEqual(sor.groupByParent([{ child: 0, parent: 5452 }, null, 7]), []);
});

// -----------------------------------------------------------------------------
// Wire-up estructural en pulpo.js (sin ejecutar el Pulpo ni tocar la red)
// -----------------------------------------------------------------------------

test('#5516 estructural: pulpo.js cablea el reconciliador en el ciclo periódico', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const PULPO_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');

    assert.match(PULPO_SRC, /require\('\.\/lib\/split-orphan-reconciler'\)/);
    assert.match(PULPO_SRC, /function reconcileSplitOrphansFromGithub\(/);
    // Se dispara SÓLO por opt-in explícito desde el loop de producción: ni el
    // boot ni los unit tests de #4439/#4525 deben pegarle a GitHub.
    assert.match(PULPO_SRC, /opts\.reconcileSplitOrphans === true/);
    assert.match(PULPO_SRC, /evaluateDesyncAndMaybeRealign\('periodic',\s*\{\s*reconcileSplitOrphans:\s*true\s*\}\)/);
    // Incorporación por las APIs existentes, nunca escribiendo los JSON a mano.
    assert.match(PULPO_SRC, /waves\.addIssueToWave\(active\.number/);
    assert.match(PULPO_SRC, /source:\s*'split-github-reconcile'/);
    // No debe existir un write directo a los archivos de estado en este camino.
    assert.doesNotMatch(PULPO_SRC, /writeFileSync\([^)]*partial-pause\.json/);
});

test('#5516 estructural: el boot NO dispara la consulta a GitHub', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const PULPO_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
    // El call de boot sigue sin opts → el reconciliador queda inhibido ahí.
    assert.match(PULPO_SRC, /evaluateDesyncAndMaybeRealign\('boot'\)/);
    assert.doesNotMatch(PULPO_SRC, /evaluateDesyncAndMaybeRealign\('boot',\s*\{[^}]*reconcileSplitOrphans/);
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

test('toPositiveInt: sanitiza el input no confiable', () => {
    assert.equal(sor.toPositiveInt(5452), 5452);
    assert.equal(sor.toPositiveInt(' 5452 '), 5452);
    assert.equal(sor.toPositiveInt('5452abc'), null);
    assert.equal(sor.toPositiveInt('0'), null);
    assert.equal(sor.toPositiveInt(-1), null);
    assert.equal(sor.toPositiveInt(1.5), null);
    assert.equal(sor.toPositiveInt(null), null);
    assert.equal(sor.toPositiveInt({}), null);
    assert.equal(sor.toPositiveInt('1e3'), null, 'notación exponencial no es un número de issue');
});

test('isOpenIssue: sólo "open"/"OPEN" cuenta como abierto', () => {
    assert.equal(sor.isOpenIssue({ state: 'OPEN' }), true);
    assert.equal(sor.isOpenIssue({ state: 'open' }), true);
    assert.equal(sor.isOpenIssue({ state: ' Open ' }), true);
    assert.equal(sor.isOpenIssue({ state: 'CLOSED' }), false);
    assert.equal(sor.isOpenIssue({}), false);
    assert.equal(sor.isOpenIssue(null), false);
});
