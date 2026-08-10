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

// SO-7 — Autor CONFIABLE por defecto en las fixtures. Los hijos de split reales
// los abre el pipeline con el token del operador: verificado en vivo sobre los
// huérfanos del incidente 2026-08-03 (#5458/#5459/#5460, #5419, #5203), todos
// `author_association: MEMBER`, `user.login: leitolarreta`. Sin estos campos el
// default-deny de SO-7 excluiría cada fixture y los tests dejarían de ejercitar
// la lógica de padre/ola que en realidad quieren cubrir.
const TRUSTED_AUTHOR = Object.freeze({
    author_association: 'MEMBER',
    user: Object.freeze({ login: 'leitolarreta' }),
});

// Autor SIN relación con el repo: el caso que SO-7 tiene que frenar.
const UNTRUSTED_AUTHOR = Object.freeze({
    author_association: 'NONE',
    user: Object.freeze({ login: 'randomuser' }),
});

// SO-8 — `labels` es OBLIGATORIO en el payload: sin el campo el default-deny
// excluye al candidato (un wire-up que se olvide de pedirlo desactivaría el
// guard en silencio). Las fixtures traen la lista VACÍA salvo que el test
// quiera ejercitar justamente un label de bloqueo.
const NO_LABELS = Object.freeze({ labels: Object.freeze([]) });

// Helper: issue de GitHub con formato canónico de `/planner split`.
function child(number, parent, over = {}) {
    return {
        number,
        title: `[Split de #${parent}] parte de la historia madre`,
        body: `Historia madre: #${parent}\n\n## Criterios\n- algo`,
        state: 'OPEN',
        ...TRUSTED_AUTHOR,
        ...NO_LABELS,
        ...over,
    };
}

function plain(number, over = {}) {
    return {
        number,
        title: 'Un issue cualquiera',
        body: 'sin referencias',
        state: 'OPEN',
        ...TRUSTED_AUTHOR,
        ...NO_LABELS,
        ...over,
    };
}

// Helper: issue de GitHub con labels explícitos (SO-8).
function childWithLabels(number, parent, labels, over = {}) {
    return child(number, parent, { labels: labels.map((name) => ({ name })), ...over });
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

test('findSplitOrphans: título malformado → excluido', () => {
    const malos = [
        plain(5470, { title: '[Split de #] falta el numero' }),
        plain(5471, { title: '[Split de #abc] numero no numerico' }),
        plain(5472, { title: 'Split de #5452 sin corchetes' }),
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
// SO-4 — el BODY NO es criterio de descubrimiento (decisión del operador
// 2026-08-05, ratificada 2026-08-06). El único criterio es el título canónico.
//
// Contexto: contrastado contra los datos reales de la ola, los 7 matches por
// body eran TODOS falsos positivos (línea de `git log`, título de otro issue
// entrecomillado, prosa "TRAMO 4 del split de #N") y el 100 % de los hijos
// legítimos matcheaba por título. Estos tests son la RED que impide que la vía
// por body se reintroduzca por descuido en un refactor futuro.
// -----------------------------------------------------------------------------

test('SO-4: sin título canónico, "Split de #N" en el body NO alcanza → excluido', () => {
    const issue = plain(5461, { title: 'Parte 4 de la historia madre', body: 'Split de #5452\n\nCriterios...' });
    const res = sor.findSplitOrphans([issue], { activeWaveIssues: [5452] });
    assert.deepEqual(res.orphans, [], 'el body no debe ser criterio de descubrimiento');
});

test('SO-4: "Tracked by #N" en el body NO declara padre', () => {
    const issue = plain(5462, { title: 'Parte 5', body: 'Tracked by #5452' });
    assert.deepEqual(sor.findSplitOrphans([issue], { activeWaveIssues: [5452] }).orphans, []);
});

test('SO-4: "Closes #N" en el body NO declara padre', () => {
    const issue = plain(5465, { title: 'Parte 7', body: 'Closes #5452' });
    assert.deepEqual(sor.findSplitOrphans([issue], { activeWaveIssues: [5452] }).orphans, []);
});

test('SO-4: falso positivo real — línea de git log en el body → excluido', () => {
    // Caso observado en la ola: el body pegaba un `git log` cuyo asunto contenía
    // la referencia. Por título no matchea, así que ahora queda afuera.
    const issue = plain(5466, {
        title: 'Auditoría de commits de la ola',
        body: 'abc1234 [Split de #5452] Guardas contra re-commit de paths sensibles',
    });
    assert.deepEqual(sor.findSplitOrphans([issue], { activeWaveIssues: [5452] }).orphans, []);
});

test('SO-4: falso positivo real — prosa "TRAMO 4 del split de #N" → excluido', () => {
    const issue = plain(5467, {
        title: 'Seguimiento de avance',
        body: 'Este issue cubre el TRAMO 4 del split de #5452 pero no es un hijo.',
    });
    assert.deepEqual(sor.findSplitOrphans([issue], { activeWaveIssues: [5452] }).orphans, []);
});

test('SO-4: falso positivo real — título de otro issue entrecomillado en el body → excluido', () => {
    const issue = plain(5468, {
        title: 'Consolidado de dependencias',
        body: 'Depende de "[Split de #5452] Resolución vault-only" que sigue abierto.',
    });
    assert.deepEqual(sor.findSplitOrphans([issue], { activeWaveIssues: [5452] }).orphans, []);
});

test('SO-4: el título canónico manda y el body es IRRELEVANTE aunque contradiga', () => {
    const issue = { number: 5464, title: '[Split de #5452] x', body: 'Tracked by #4200', state: 'OPEN' };
    assert.equal(sor.parentOfSplitOrphan(issue), 5452);
});

test('SO-4: hijo legítimo SIN body igual se incorpora (el body no aporta nada)', () => {
    // El 100 % de los hijos legítimos matchea por título, así que la ausencia de
    // body no puede impedir la incorporación.
    for (const body of [undefined, null, '', 123, {}]) {
        const issue = child(5458, 5452, { body });
        const res = sor.findSplitOrphans([issue], { activeWaveIssues: [5452] });
        assert.deepEqual(pairs(res), [[5458, 5452]], `body=${JSON.stringify(body)} no debe afectar`);
    }
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
// SO-7 — origen confiable (el repo es público: los issues son input hostil)
// -----------------------------------------------------------------------------

test('SO-7: autor SIN relación con el repo → NO se incorpora aunque el padre esté en la ola', () => {
    // El ataque que cierra SO-7: `#N` es público, así que cualquiera puede abrir
    // "[Split de #N]" y hacerse meter en la allowlist, que es el gate de dispatch.
    const res = sor.findSplitOrphans([child(9001, 5452, UNTRUSTED_AUTHOR)], { activeWaveIssues: [5452] });
    assert.deepEqual(res.orphans, [], 'un tercero no puede auto-incorporarse al alcance del pipeline');
});

test('SO-7: el candidato excluido se REPORTA, nunca se descarta en silencio', () => {
    const res = sor.findSplitOrphans([child(9001, 5452, UNTRUSTED_AUTHOR)], { activeWaveIssues: [5452] });
    assert.deepEqual(res.rejectedUntrusted, [
        { child: 9001, parent: 5452, login: 'randomuser', association: 'NONE' },
    ]);
});

test('SO-7: sólo se reporta quien DECLARA un padre, no los issues normales del repo', () => {
    // Si reportáramos antes de parsear el padre, la alerta traería cientos de
    // issues comunes por ciclo y dejaría de leerse.
    const issues = [plain(9100, UNTRUSTED_AUTHOR), plain(9101, UNTRUSTED_AUTHOR)];
    const res = sor.findSplitOrphans(issues, { activeWaveIssues: [5452] });
    assert.deepEqual(res.rejectedUntrusted, [], 'sin padre declarado no hay intento de entrada');
});

test('SO-7: padre FUERA de la ola + autor no confiable → excluido y SIN alerta engañosa', () => {
    // El repo es PÚBLICO: cualquiera puede abrir "[Split de #4200] ..." apuntando
    // a un issue ajeno a la ola. Ese candidato ya cae por SO-2 sin importar quién
    // lo escriba, así que NO es un intento de entrar al alcance del pipeline.
    // Reportarlo dispararía una alerta de seguridad que afirma "declaran un padre
    // de la ola activa" — literalmente falso — una vez por issue, por siempre.
    const res = sor.findSplitOrphans([child(9001, 4200, UNTRUSTED_AUTHOR)], { activeWaveIssues: [5452] });
    assert.deepEqual(res.orphans, []);
    assert.deepEqual(res.rejectedUntrusted, [], 'padre fuera de la ola no es un intento de entrada');
});

test('SO-7: se reporta al no confiable cuyo padre está EN la ola, aunque no haya orphans', () => {
    // Contraste del test anterior: mismo autor no confiable, pero el padre SÍ
    // pertenece a la ola. Acá la alerta es verdadera y debe dispararse.
    const res = sor.findSplitOrphans([child(9001, 5452, UNTRUSTED_AUTHOR)], { activeWaveIssues: [5452] });
    assert.deepEqual(res.orphans, []);
    assert.deepEqual(res.rejectedUntrusted, [
        { child: 9001, parent: 5452, login: 'randomuser', association: 'NONE' },
    ]);
});

test('SO-7: el reporte incluye al que apunta a un padre alcanzable TRANSITIVAMENTE', () => {
    // #5458 (confiable) se incorpora por padre #5452 ∈ ola. Un tercero apunta a
    // #5458 como padre: en la ronda siguiente #5458 ya es alcanzable, así que ese
    // intento SÍ apunta al alcance del pipeline y debe alertarse.
    const issues = [child(5458, 5452), child(9001, 5458, UNTRUSTED_AUTHOR)];
    const res = sor.findSplitOrphans(issues, { activeWaveIssues: [5452] });
    assert.deepEqual(pairs(res), [[5458, 5452]]);
    assert.deepEqual(res.rejectedUntrusted.map((r) => [r.child, r.parent]), [[9001, 5458]]);
});

test('SO-7: mezcla — sólo se alerta por los que apuntan al alcance de la ola', () => {
    const issues = [
        child(9001, 5452, UNTRUSTED_AUTHOR),   // padre EN la ola → se alerta
        child(9002, 4200, UNTRUSTED_AUTHOR),   // padre fuera     → ruido, se filtra
        child(9003, 7777, UNTRUSTED_AUTHOR),   // padre fuera     → ruido, se filtra
        child(5458, 5452),                     // confiable       → se incorpora
    ];
    const res = sor.findSplitOrphans(issues, { activeWaveIssues: [5452] });
    assert.deepEqual(pairs(res), [[5458, 5452]]);
    assert.deepEqual(res.rejectedUntrusted.map((r) => r.child), [9001]);
});

test('SO-7: OWNER, MEMBER y COLLABORATOR son confiables', () => {
    for (const assoc of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
        const res = sor.findSplitOrphans(
            [child(5458, 5452, { author_association: assoc })],
            { activeWaveIssues: [5452] }
        );
        assert.deepEqual(pairs(res), [[5458, 5452]], `${assoc} debe ser confiable`);
    }
});

test('SO-7: CONTRIBUTOR / FIRST_TIMER / MANNEQUIN / NONE NO son confiables', () => {
    // Exactamente los valores que puede tener alguien sin permisos sobre el repo.
    for (const assoc of ['NONE', 'CONTRIBUTOR', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR', 'MANNEQUIN']) {
        const res = sor.findSplitOrphans(
            [child(5458, 5452, { author_association: assoc })],
            { activeWaveIssues: [5452] }
        );
        assert.deepEqual(res.orphans, [], `${assoc} NO debe ser confiable`);
    }
});

test('SO-7: campo de autor ausente o inválido → excluido (fail-closed, no fail-open)', () => {
    const sinAutor = { number: 5458, title: '[Split de #5452] x', body: '', state: 'OPEN' };
    assert.deepEqual(sor.findSplitOrphans([sinAutor], { activeWaveIssues: [5452] }).orphans, []);

    const raros = [
        child(5459, 5452, { author_association: undefined, user: undefined }),
        child(5460, 5452, { author_association: '', user: undefined }),
        child(5461, 5452, { author_association: 42, user: undefined }),
        child(5462, 5452, { author_association: 'ADMIN_INVENTADO', user: undefined }),
    ];
    assert.deepEqual(sor.findSplitOrphans(raros, { activeWaveIssues: [5452] }).orphans, []);
});

test('SO-7: acepta la forma GraphQL (authorAssociation + author.login), no sólo REST', () => {
    const issue = {
        number: 5458,
        title: '[Split de #5452] x',
        body: '',
        state: 'OPEN',
        authorAssociation: 'MEMBER',
        author: { login: 'leitolarreta' },
        labels: [],                                            // SO-8
    };
    assert.deepEqual(pairs(sor.findSplitOrphans([issue], { activeWaveIssues: [5452] })), [[5458, 5452]]);
});

test('SO-7: allowlist de logins habilita cuentas de bot sin asociación con el repo', () => {
    const bot = child(5458, 5452, { author_association: 'NONE', user: { login: 'intrale-bot' } });
    const sinAllow = sor.findSplitOrphans([bot], { activeWaveIssues: [5452] });
    assert.deepEqual(sinAllow.orphans, [], 'sin allowlist manda la asociación');

    const conAllow = sor.findSplitOrphans([bot], {
        activeWaveIssues: [5452],
        trustedLogins: ['intrale-bot'],
    });
    assert.deepEqual(pairs(conAllow), [[5458, 5452]]);
});

test('SO-7: la allowlist de logins normaliza mayúsculas, espacios y "@"', () => {
    const bot = child(5458, 5452, { author_association: 'NONE', user: { login: 'Intrale-Bot' } });
    const res = sor.findSplitOrphans([bot], {
        activeWaveIssues: [5452],
        trustedLogins: ['  @INTRALE-BOT '],
    });
    assert.deepEqual(pairs(res), [[5458, 5452]]);
});

test('SO-7: allowlist con basura no rompe ni abre la puerta', () => {
    const bot = child(5458, 5452, { author_association: 'NONE', user: { login: 'intrale-bot' } });
    const res = sor.findSplitOrphans([bot], {
        activeWaveIssues: [5452],
        trustedLogins: [null, 42, '', '   ', {}],
    });
    assert.deepEqual(res.orphans, []);
});

test('SO-7: predicado inyectado por el wire-up manda sobre el criterio default', () => {
    const issue = child(5458, 5452, UNTRUSTED_AUTHOR);
    const res = sor.findSplitOrphans([issue], {
        activeWaveIssues: [5452],
        isTrustedAuthor: () => true,
    });
    assert.deepEqual(pairs(res), [[5458, 5452]]);
});

test('SO-7: un predicado inyectado que TIRA no tumba el tick del Pulpo → excluye', () => {
    const res = sor.findSplitOrphans([child(5458, 5452)], {
        activeWaveIssues: [5452],
        isTrustedAuthor: () => { throw new Error('boom'); },
    });
    assert.deepEqual(res.orphans, [], 'excepción del predicado = no confiable');
});

test('SO-7: un retorno truthy que no es `true` NO cuenta como confianza probada', () => {
    for (const truthy of ['si', 1, {}, []]) {
        const res = sor.findSplitOrphans([child(5458, 5452, UNTRUSTED_AUTHOR)], {
            activeWaveIssues: [5452],
            isTrustedAuthor: () => truthy,
        });
        assert.deepEqual(res.orphans, [], `retorno ${JSON.stringify(truthy)} no debe habilitar`);
    }
});

test('SO-7: la expansión transitiva también exige origen confiable en el nieto', () => {
    // El hijo es confiable, el nieto no: el nieto NO puede colarse por herencia.
    const issues = [child(5458, 5452), child(5470, 5458, UNTRUSTED_AUTHOR)];
    const res = sor.findSplitOrphans(issues, { activeWaveIssues: [5452] });
    assert.deepEqual(pairs(res), [[5458, 5452]], 'la confianza no se hereda del padre');
});

test('isTrustedAuthor: unidad del predicado default', () => {
    assert.equal(sor.isTrustedAuthor({ author_association: 'OWNER' }), true);
    assert.equal(sor.isTrustedAuthor({ authorAssociation: 'member' }), true, 'normaliza a mayúsculas');
    assert.equal(sor.isTrustedAuthor({ author_association: 'NONE' }), false);
    assert.equal(sor.isTrustedAuthor({}), false);
    assert.equal(sor.isTrustedAuthor(null), false);
    assert.equal(
        sor.isTrustedAuthor({ user: { login: 'bot' } }, { trustedLogins: ['bot'] }),
        true
    );
});

test('authorAssociationOf / authorLoginOf: extracción tolerante a la fuente', () => {
    assert.equal(sor.authorAssociationOf({ author_association: ' member ' }), 'MEMBER');
    assert.equal(sor.authorAssociationOf({ authorAssociation: 'OWNER' }), 'OWNER');
    assert.equal(sor.authorAssociationOf({ author_association: '' }), null);
    assert.equal(sor.authorAssociationOf({}), null);
    assert.equal(sor.authorAssociationOf(null), null);

    assert.equal(sor.authorLoginOf({ author: { login: 'Leito' } }), 'leito');
    assert.equal(sor.authorLoginOf({ user: { login: 'Leito' } }), 'leito');
    assert.equal(sor.authorLoginOf({ author: 'Leito' }), 'leito');
    assert.equal(sor.authorLoginOf({}), null);
    assert.equal(sor.authorLoginOf(null), null);
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

test('#5516 estructural: SO-7 — el wire-up trae el autor y filtra PRs', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const PULPO_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');

    // `gh issue list --json` NO expone authorAssociation: el descubrimiento debe
    // ir por la API HTTP, que sí trae author_association + user.login + labels.
    // Si alguien vuelve al camino viejo, SO-7 degradaría a excluir todo (o peor,
    // a fail-open) y SO-8 se quedaría sin `labels`.
    // La query se resuelve una vez por corrida en `searchQ` (antes era la
    // constante `SPLIT_ORPHAN_SEARCH_Q`, con el repo hardcodeado); lo que importa
    // acá es que el camino siga siendo `search/issues`.
    assert.match(PULPO_SRC, /search\/issues\?q=\$\{searchQ\}/);
    assert.match(PULPO_SRC, /const searchQ = splitOrphanSearchQuery\(\);/);
    assert.doesNotMatch(
        PULPO_SRC,
        /issue list --repo intrale\/platform --state open/,
        'el camino viejo sin dato de autor no debe volver'
    );
    // La búsqueda de issues devuelve también PRs: un PR "[Split de #N]" no es un hijo.
    assert.match(PULPO_SRC, /pull_request === undefined/);
    // Los candidatos excluidos por SO-7 se alertan, no se tragan en silencio.
    assert.match(PULPO_SRC, /rejectedUntrusted/);
    assert.match(PULPO_SRC, /splitOrphanTrustedLogins\(\)/);
});

// -----------------------------------------------------------------------------
// GATE DE MODO del wire-up (rebote rev-1) — el reconciliador NO puede mutar
// `waves.json` fuera de `partial_pause`.
//
// Cadena del bug que cierra este bloque:
//   1. `checkPauseFile()` sólo setea el flag `paused`; el tick de desync corre
//      igual (el gate `if (!paused && ...)` gatea el DISPATCH, más abajo).
//   2. `.paused` NO borra `.partial-pause.json`: coexisten.
//   3. Con ambos presentes `getPipelineMode()` devuelve `paused`, así que el
//      paso 5 no escribía la allowlist — pero el paso 3 YA había mutado la ola.
//   4. `desync-detector` lee `.partial-pause.json` directo del disco, ignora
//      `.paused`: ve `removed:[huérfanos]` → `resoluble_reductivo`.
//   5. Ese reductivo sólo se auto-resuelve si TODOS los divergentes están
//      cerrados; los huérfanos recién sumados están ABIERTOS → flag +
//      human-block. El pipeline se auto-infligía el bloqueo que #5516 elimina.
//
// Los stubs reemplazan `partial-pause` y `waves` en la caché de módulos: los
// tests NUNCA tocan `.paused` ni los JSON de estado reales (crear `.paused` en
// el repo pausaría el pipeline de producción).
// -----------------------------------------------------------------------------

const path = require('node:path');
process.env.PULPO_NO_AUTOSTART = '1';
const partialPauseMod = require('../partial-pause');
const wavesMod = require('../waves');
const pulpo = require(path.join(__dirname, '..', '..', 'pulpo.js'));

/**
 * Corre `reconcileSplitOrphansFromGithub` con el modo forzado, contando cuántas
 * veces se tocó `waves`. `getActiveWave` es la PRIMERA lectura de estado después
 * del gate: si quedó en 0, el gate cortó antes de leer (y por ende de mutar) nada.
 */
function runWithMode(modeFn) {
    const origMode = partialPauseMod.getPipelineMode;
    const origActive = wavesMod.getActiveWave;
    const origAdd = wavesMod.addIssueToWave;
    const calls = { getActiveWave: 0, addIssueToWave: 0 };
    partialPauseMod.getPipelineMode = modeFn;
    wavesMod.getActiveWave = () => { calls.getActiveWave++; return null; };
    wavesMod.addIssueToWave = () => {
        calls.addIssueToWave++;
        throw new Error('el reconciliador NO debe mutar waves.json en este modo');
    };
    try {
        return { res: pulpo.reconcileSplitOrphansFromGithub('test'), calls };
    } finally {
        partialPauseMod.getPipelineMode = origMode;
        wavesMod.getActiveWave = origActive;
        wavesMod.addIssueToWave = origAdd;
    }
}

test('#5516 gate: pipeline PAUSADO (.paused) → no-op total, ni ola ni allowlist', () => {
    // `.paused` con `.partial-pause.json` coexistiendo: el caso exacto del rebote.
    const { res, calls } = runWithMode(() => ({
        mode: 'paused', allowedIssues: [], allowedSkills: [],
    }));
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'not_partial_pause');
    assert.deepEqual(res.incorporated, []);
    assert.equal(calls.addIssueToWave, 0, 'waves.json NO se muta con el pipeline pausado');
    assert.equal(calls.getActiveWave, 0, 'el gate corta ANTES de leer la ola (y antes de gh)');
});

test('#5516 gate: modo RUNNING → no-op total (sin allowlist no hay dispatch, #5060)', () => {
    // En `running` sumar a la ola no habilita nada (`isIssueAllowedInState` es
    // fail-closed) y escribir la allowlist metería al pipeline en pausa parcial
    // con SÓLO estos hijos → corte total del resto del backlog.
    const { res, calls } = runWithMode(() => ({
        mode: 'running', allowedIssues: [], allowedSkills: [],
    }));
    assert.equal(res.reason, 'not_partial_pause');
    assert.equal(calls.addIssueToWave, 0);
    assert.equal(calls.getActiveWave, 0);
});

test('#5516 gate: partial_pause con allowed_issues VACÍO → no-op total', () => {
    // Ventana abierta sólo por `allowed_skills` (#3680): la unión del paso 5 no se
    // escribiría y la ola quedaría mutada sin respaldo → misma divergencia.
    const { res, calls } = runWithMode(() => ({
        mode: 'partial_pause', allowedIssues: [], allowedSkills: ['qa'],
    }));
    assert.equal(res.reason, 'not_partial_pause');
    assert.equal(calls.addIssueToWave, 0);
    assert.equal(calls.getActiveWave, 0);
});

test('#5516 gate: getPipelineMode que TIRA → fail-closed, no-op', () => {
    const { res, calls } = runWithMode(() => { throw new Error('json corrupto'); });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'mode_unreadable');
    assert.equal(calls.getActiveWave, 0, 'modo indeterminado nunca habilita mutar la ola');
});

test('#5516 gate: partial_pause con allowlist → el gate NO corta, sigue el flujo', () => {
    // Control negativo: sin esto, un gate demasiado estricto volvería el
    // reconciliador un no-op permanente y el issue quedaría sin efecto.
    // `getActiveWave` stubeado a null corta en el paso siguiente con otro motivo:
    // eso prueba que la ejecución PASÓ el gate.
    const { res, calls } = runWithMode(() => ({
        mode: 'partial_pause', allowedIssues: [5452], allowedSkills: [],
    }));
    assert.equal(res.reason, 'no_active_wave');
    assert.equal(calls.getActiveWave, 1, 'en partial_pause el reconciliador sigue trabajando');
});

test('#5516 estructural: el gate de modo está ANTES de la consulta a gh y del write', () => {
    const fs = require('node:fs');
    const PULPO_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
    const fn = PULPO_SRC.slice(PULPO_SRC.indexOf('function reconcileSplitOrphansFromGithub('));
    const iGate = fn.indexOf("reason: 'not_partial_pause'");
    const iGh = fn.indexOf('search/issues?q=');
    const iAdd = fn.indexOf('waves.addIssueToWave(active.number');
    assert.ok(iGate > 0 && iGh > 0 && iAdd > 0, 'las tres marcas deben existir');
    assert.ok(iGate < iGh, 'el gate de modo debe cortar antes de pegarle a GitHub');
    assert.ok(iGate < iAdd, 'el gate de modo debe cortar antes de mutar waves.json');
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

// =============================================================================
// SO-8 — GUARD POR LABELS (punto 2 del alcance del operador, rebote 2026-08-10)
//
// Un hijo con `needs-human`, `tipo:recomendacion` o `source:recommendation` está
// frenado A PROPÓSITO: por decisión humana el primero, por el gate de aprobación
// de #2653 los otros dos. El reconciliador los sumaba a la ola Y a la allowlist,
// o sea los habilitaba para dispatch — se convertía en un bypass del gate que lo
// debería contener.
//
// Medido contra GitHub real el 2026-08-07 (rechazo del PO): 3 de 11 hijos
// descubiertos entraban pese a llevar `needs-human` (#5209, #5421, #5462).
// =============================================================================

test('SO-8: hijo con `needs-human` → NO se incorpora y se reporta', () => {
    const issues = [childWithLabels(5462, 5451, ['bug', 'needs-human'])];
    const res = sor.findSplitOrphans(issues, { activeWaveIssues: [5451] });

    assert.deepEqual(res.orphans, [], 'un issue frenado por decisión humana no entra a la ola');
    assert.deepEqual(res.rejectedByLabel, [
        { child: 5462, parent: 5451, labels: ['needs-human'], reason: 'blocking_label' },
    ], 'la exclusión se reporta, nunca se descarta en silencio');
});

test('SO-8: hijo con `tipo:recomendacion` → NO se incorpora (gate #2653)', () => {
    const res = sor.findSplitOrphans(
        [childWithLabels(5556, 5451, ['tipo:recomendacion'])],
        { activeWaveIssues: [5451] }
    );
    assert.deepEqual(res.orphans, []);
    assert.equal(res.rejectedByLabel[0].reason, 'blocking_label');
});

test('SO-8: hijo con `source:recommendation` → NO se incorpora (gate #2653)', () => {
    const res = sor.findSplitOrphans(
        [childWithLabels(5557, 5451, ['source:recommendation'])],
        { activeWaveIssues: [5451] }
    );
    assert.deepEqual(res.orphans, []);
    assert.equal(res.rejectedByLabel[0].reason, 'blocking_label');
});

test('SO-8: los 3 casos REALES que el PO midió el 2026-08-07 quedan excluidos', () => {
    // #5209 (hijo de #5126), #5421 (de #5401), #5462 (de #5451): los tres con
    // `needs-human` y los tres se incorporaban antes de este guard.
    const issues = [
        childWithLabels(5209, 5126, ['needs-human', 'area:infra']),
        childWithLabels(5421, 5401, ['needs-human']),
        childWithLabels(5462, 5451, ['needs-human', 'qa:passed']),
    ];
    const res = sor.findSplitOrphans(issues, { activeWaveIssues: [5126, 5401, 5451] });

    assert.deepEqual(res.orphans, [], 'ninguno de los 3 debe entrar');
    assert.deepEqual(
        res.rejectedByLabel.map((r) => r.child).sort((a, b) => a - b),
        [5209, 5421, 5462]
    );
});

test('SO-8: hijo con labels NORMALES sí se incorpora (el guard no es un bloqueo general)', () => {
    const issues = [childWithLabels(5458, 5452, ['bug', 'Ready', 'area:pipeline', 'size:medium'])];
    const res = sor.findSplitOrphans(issues, { activeWaveIssues: [5452] });
    assert.deepEqual(pairs(res), [[5458, 5452]]);
    assert.deepEqual(res.rejectedByLabel, []);
});

test('SO-8: payload SIN `labels` → excluido (fail-closed, no fail-open)', () => {
    // Un wire-up que se olvide de pedir `labels` desactivaría el guard en
    // silencio. Preferimos no incorporar antes que incorporar algo bloqueado.
    const sinLabels = { ...child(5458, 5452) };
    delete sinLabels.labels;

    const res = sor.findSplitOrphans([sinLabels], { activeWaveIssues: [5452] });
    assert.deepEqual(res.orphans, [], 'sin labels no se puede probar que esté habilitado');
    assert.deepEqual(res.rejectedByLabel, [
        { child: 5458, parent: 5452, labels: null, reason: 'labels_unavailable' },
    ]);
});

test('SO-8: `labels` con forma inválida → excluido con `labels_unavailable`', () => {
    for (const labels of [null, 'needs-human', 42, {}, { nodes: 'x' }]) {
        const res = sor.findSplitOrphans([child(5458, 5452, { labels })], { activeWaveIssues: [5452] });
        assert.deepEqual(res.orphans, [], `labels=${JSON.stringify(labels)} debe excluir`);
        assert.equal(res.rejectedByLabel[0].reason, 'labels_unavailable');
    }
});

test('SO-8: acepta las 3 formas de payload de labels (REST, GraphQL y strings)', () => {
    const rest = child(5458, 5452, { labels: [{ name: 'needs-human' }] });
    const graphql = child(5459, 5452, { labels: { nodes: [{ name: 'needs-human' }] } });
    const strings = child(5460, 5452, { labels: ['needs-human'] });

    for (const issue of [rest, graphql, strings]) {
        const res = sor.findSplitOrphans([issue], { activeWaveIssues: [5452] });
        assert.deepEqual(res.orphans, [], `forma ${JSON.stringify(issue.labels)} debe bloquear`);
    }
});

test('SO-8: la comparación de labels es case-insensitive y tolera espacios', () => {
    for (const name of ['NEEDS-HUMAN', ' Needs-Human ', 'Tipo:Recomendacion']) {
        const res = sor.findSplitOrphans([child(5458, 5452, { labels: [{ name }] })], {
            activeWaveIssues: [5452],
        });
        assert.deepEqual(res.orphans, [], `"${name}" debe bloquear igual`);
    }
});

test('SO-8: entradas basura dentro de una lista válida se ignoran, no invalidan el resto', () => {
    const issue = child(5458, 5452, { labels: [null, 42, {}, { name: 'Ready' }] });
    const res = sor.findSplitOrphans([issue], { activeWaveIssues: [5452] });
    assert.deepEqual(pairs(res), [[5458, 5452]], 'la lista es válida aunque traiga entradas raras');
});

test('SO-8: un hijo bloqueado NO habilita a sus propios hijos (la rama queda frenada)', () => {
    // #5207 bloqueado por `needs-human`; #5212 dice ser hijo de #5207. Si #5207
    // está frenado por decisión humana, su sub-split tampoco debe entrar.
    const issues = [
        childWithLabels(5207, 5126, ['needs-human']),
        child(5212, 5207),
    ];
    const res = sor.findSplitOrphans(issues, { activeWaveIssues: [5126] });
    assert.deepEqual(res.orphans, [], 'ni el bloqueado ni su descendencia');
});

test('SO-8: padre FUERA de la ola → no se reporta en rejectedByLabel (sin ruido)', () => {
    // Igual que SO-7: sólo se reporta lo que estaba EN ALCANCE. Un bloqueado cuyo
    // padre ni pertenece a la ola habría caído por SO-2 de todos modos.
    const res = sor.findSplitOrphans(
        [childWithLabels(9001, 4200, ['needs-human'])],
        { activeWaveIssues: [5451, 5452] }
    );
    assert.deepEqual(res.orphans, []);
    assert.deepEqual(res.rejectedByLabel, [], 'no ensuciar el reporte con lo que ya caía por SO-2');
});

test('SO-8: SO-7 tiene prioridad — autor no confiable se reporta como untrusted', () => {
    // Un issue de un tercero CON label de bloqueo: la señal grave es el origen,
    // no el label. No debe quedar tapada en el bucket de labels.
    const issue = childWithLabels(9002, 5452, ['needs-human'], { ...UNTRUSTED_AUTHOR });
    const res = sor.findSplitOrphans([issue], { activeWaveIssues: [5452] });

    assert.deepEqual(res.orphans, []);
    assert.equal(res.rejectedUntrusted.length, 1, 'la alerta de seguridad manda');
    assert.deepEqual(res.rejectedByLabel, []);
});

test('SO-8: `ctx.blockingLabels` permite override sin tocar el módulo', () => {
    const issue = child(5458, 5452, { labels: [{ name: 'wip' }] });
    const conDefault = sor.findSplitOrphans([issue], { activeWaveIssues: [5452] });
    assert.deepEqual(pairs(conDefault), [[5458, 5452]], '`wip` no bloquea por default');

    const conOverride = sor.findSplitOrphans([issue], {
        activeWaveIssues: [5452],
        blockingLabels: ['wip'],
    });
    assert.deepEqual(conOverride.orphans, []);
});

test('SO-8: BLOCKING_LABELS expone exactamente los 3 que pidió el operador', () => {
    assert.deepEqual(
        [...sor.BLOCKING_LABELS].sort(),
        ['needs-human', 'source:recommendation', 'tipo:recomendacion']
    );
});

// -----------------------------------------------------------------------------
// NO-REGRESIÓN — los hijos legítimos siguen entrando por título
// -----------------------------------------------------------------------------

test('no-regresión: los 7 hijos legítimos de la ola siguen incorporándose por título', () => {
    // Los mismos que citó el operador al fijar el alcance: #5458/#5459/#5460 (de
    // #5452), #5461/#5462 (de #5451), #5421 (de #5401) y #5440 (de #5340).
    // Acá van SIN labels de bloqueo (su estado legítimo): ni SO-8 ni la
    // eliminación del descubrimiento por body pueden dejarlos afuera.
    const issues = [
        childWithLabels(5458, 5452, ['Ready']),
        childWithLabels(5459, 5452, ['Ready']),
        childWithLabels(5460, 5452, ['Ready']),
        childWithLabels(5461, 5451, ['Ready']),
        childWithLabels(5462, 5451, ['Ready']),
        childWithLabels(5421, 5401, ['Ready']),
        childWithLabels(5440, 5340, ['Ready']),
    ];
    const res = sor.findSplitOrphans(issues, {
        activeWaveIssues: [5340, 5401, 5451, 5452],
    });

    assert.deepEqual(pairs(res), [
        [5421, 5401], [5440, 5340], [5458, 5452], [5459, 5452],
        [5460, 5452], [5461, 5451], [5462, 5451],
    ], 'los 7 hijos legítimos entran');
    assert.equal(res.truncated, false);
    assert.deepEqual(res.rejectedByLabel, []);
    assert.deepEqual(res.rejectedUntrusted, []);
});

// =============================================================================
// PUNTO 4 — TRUNCADO POR VENTANA DE DESCUBRIMIENTO
//
// El corte por paginado era SILENCIOSO: el loop del wire-up agotaba las páginas
// sin marcar nada y `found.truncated` sólo salía de los caps del módulo puro.
// Medido el 2026-08-10 contra GitHub real: de 126 hijos con título canónico en el
// repo, la ventana de 3 páginas alcanzaba 17 → 109 quedaban afuera SIN señal,
// incluida la cadena de #5126 (#5207, #5208, #5209, #5212, #5214).
// =============================================================================

test('punto 4: última página LLENA al agotar maxPages → truncated `discovery_window`', () => {
    assert.deepEqual(
        sor.classifyDiscoveryWindow({ pagesFetched: 3, lastBatchSize: 100, pageSize: 100, maxPages: 3 }),
        { truncated: true, reason: 'discovery_window' },
        'página llena en el tope ⇒ hay más resultados afuera de la ventana'
    );
});

test('punto 4: última página a medio llenar → NO es truncado (llegamos al final)', () => {
    // Caso real de hoy: 136 resultados → 2 páginas (100 + 36) con tope de 5.
    assert.deepEqual(
        sor.classifyDiscoveryWindow({ pagesFetched: 2, lastBatchSize: 36, pageSize: 100, maxPages: 5 }),
        { truncated: false, reason: null }
    );
});

test('punto 4: página llena pero SIN agotar maxPages → no es truncado todavía', () => {
    assert.deepEqual(
        sor.classifyDiscoveryWindow({ pagesFetched: 1, lastBatchSize: 100, pageSize: 100, maxPages: 5 }),
        { truncated: false, reason: null },
        'el loop sigue: recién importa si agota el tope'
    );
});

test('punto 4: `incomplete_results` de GitHub → truncated `search_incomplete`', () => {
    assert.deepEqual(
        sor.classifyDiscoveryWindow({
            pagesFetched: 1, lastBatchSize: 10, pageSize: 100, maxPages: 5, incompleteResults: true,
        }),
        { truncated: true, reason: 'search_incomplete' },
        'GitHub cortó la búsqueda por timeout: el conjunto es parcial'
    );
});

test('punto 4: el truncado del módulo y el de la ventana se combinan, no se pisan', () => {
    assert.deepEqual(
        sor.combineTruncation({
            moduleTruncated: true, moduleReason: 'max_incorporations',
            windowTruncated: true, windowReason: 'discovery_window',
        }),
        { truncated: true, reason: 'max_incorporations+discovery_window' }
    );
    assert.deepEqual(
        sor.combineTruncation({ moduleTruncated: true, moduleReason: 'max_depth' }),
        { truncated: true, reason: 'max_depth' }
    );
    assert.deepEqual(
        sor.combineTruncation({ windowTruncated: true, windowReason: 'discovery_window' }),
        { truncated: true, reason: 'discovery_window' }
    );
    assert.deepEqual(sor.combineTruncation({}), { truncated: false, reason: null });
});

test('punto 4: un motivo de módulo presente pero con truncated=false no se filtra', () => {
    assert.deepEqual(
        sor.combineTruncation({
            moduleTruncated: false, moduleReason: 'max_depth',
            windowTruncated: true, windowReason: 'discovery_window',
        }),
        { truncated: true, reason: 'discovery_window' }
    );
});

test('#5516 estructural: el wire-up cablea el truncado de ventana y lo avisa', () => {
    const fs = require('node:fs');
    const PULPO_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
    const fn = PULPO_SRC.slice(PULPO_SRC.indexOf('function reconcileSplitOrphansFromGithub('));

    // Usa los helpers puros (nada de lógica de truncado duplicada en el wire-up).
    assert.match(fn, /classifyDiscoveryWindow\(\{/);
    assert.match(fn, /combineTruncation\(\{/);

    // La señal de truncado debe evaluarse ANTES del return que informa
    // `no_orphans`: el caso peligroso es justamente "la ventana cortó y adentro no
    // había nada". El marcador es el string del `reason`, no `reason: 'no_orphans'`
    // literal: desde el fix de SO-9 ese reason sale de un ternario (el return dejó
    // de ser un early return y ahora vive al final, después del paso 5).
    const iTrunc = fn.indexOf('classifyDiscoveryWindow({');
    const iNoOrphans = fn.indexOf("'no_orphans'");
    assert.ok(iTrunc > 0 && iNoOrphans > 0, 'las dos marcas deben existir');
    assert.ok(iTrunc < iNoOrphans, 'el truncado se evalúa antes de devolver no_orphans');

    // Y se avisa por Telegram (con dedupe para no alertar cada ciclo).
    assert.match(fn, /Descubrimiento de hijos de split TRUNCADO/);
    assert.match(fn, /_splitOrphanTruncAlert/);
});

test('#5516 estructural: el wire-up pide labels y reporta SO-8', () => {
    const fs = require('node:fs');
    const PULPO_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
    const fn = PULPO_SRC.slice(PULPO_SRC.indexOf('function reconcileSplitOrphansFromGithub('));
    // `search/issues` trae `labels` en el payload; los excluidos por SO-8 se loguean.
    assert.match(fn, /rejectedByLabel/);
    assert.match(fn, /SO-8/);
});

// =============================================================================
// SO-9 — Convergencia ola→allowlist RE-DERIVADA DEL ESTADO
//
// Regresión del rechazo de review del 2026-08-10 (bloqueante). El paso 5 del
// wire-up construía la unión de la allowlist desde `incorporated` ("lo que
// agregué en ESTA corrida"). Si la escritura de la ola salía bien y la de la
// allowlist fallaba, el ciclo siguiente NO podía reintentar: `findSplitOrphans`
// excluye al hijo por `inWave.has(child)`, devolvía `[]`, y el wire-up hacía early
// return por `no_orphans` ANTES del paso 5 → divergencia reductiva PERMANENTE →
// flag + human-block, o sea el bloqueo humano que #5516 existe para eliminar.
//
// `splitChildrenMissingFromAllowlist` re-deriva la brecha del ESTADO, así que el
// ciclo N+1 la cierra solo sin importar por qué se abrió.
// =============================================================================

test('#5516 SO-9 ciclo N+1: la ola tiene el hijo y la allowlist no → la brecha se detecta', () => {
    const corpus = [child(5440, 5340)];
    // Ciclo N: el descubrimiento ya no lo ve (correcto: ya está en la ola).
    const orph = sor.findSplitOrphans(corpus, { activeWaveIssues: [5340, 1111, 5440] });
    assert.deepEqual(orph.orphans, [], 'el descubrimiento no reintenta — por eso hace falta SO-9');

    // Ciclo N+1: la convergencia SÍ lo ve, y por eso la brecha se cierra sola.
    const gap = sor.splitChildrenMissingFromAllowlist({
        issues: corpus,
        waveIssues: [5340, 1111, 5440],
        allowlistIssues: [5340, 1111],
    });
    assert.deepEqual(gap.missing, [5440], 'la brecha ola→allowlist se re-deriva del estado');
    assert.equal(gap.truncated, false);
});

test('#5516 SO-9 idempotente: ola y allowlist en sync → brecha vacía, sin escrituras', () => {
    const corpus = [child(5440, 5340)];
    const gap = sor.splitChildrenMissingFromAllowlist({
        issues: corpus,
        waveIssues: [5340, 5440],
        allowlistIssues: [5340, 5440],
    });
    assert.deepEqual(gap.missing, [], 'sin brecha no se escribe ni se notifica');
    assert.deepEqual(gap.rejectedByLabel, []);
});

test('#5516 SO-9 sólo mira la ola: un hijo fuera de la ola no entra a la allowlist', () => {
    // #5440 es hijo de #5340 pero NO está en la ola. La convergencia es
    // ola→allowlist: si no está en la ola, no hay nada que converger.
    const gap = sor.splitChildrenMissingFromAllowlist({
        issues: [child(5440, 5340)],
        waveIssues: [5340],
        allowlistIssues: [5340],
    });
    assert.deepEqual(gap.missing, []);
});

test('#5516 SO-9 alcance acotado: un issue de la ola SIN título de split no se toca', () => {
    // Importante para no convertir esto en un realign general de la allowlist:
    // sólo convergen HIJOS DE SPLIT (título canónico, SO-4).
    const gap = sor.splitChildrenMissingFromAllowlist({
        issues: [plain(7001)],
        waveIssues: [5340, 7001],
        allowlistIssues: [5340],
    });
    assert.deepEqual(gap.missing, []);
});

test('#5516 SO-9 mantiene SO-8: un hijo de la ola con needs-human NO se habilita', () => {
    // Sumarlo a la allowlist lo habilitaría para dispatch, salteando el gate de
    // #2653 — la misma razón por la que SO-8 existe en el descubrimiento.
    const gap = sor.splitChildrenMissingFromAllowlist({
        issues: [child(5426, 5339, { labels: [{ name: 'needs-human' }] })],
        waveIssues: [5339, 5426],
        allowlistIssues: [5339],
    });
    assert.deepEqual(gap.missing, [], 'no se auto-habilita un issue frenado a propósito');
    assert.equal(gap.rejectedByLabel.length, 1);
    assert.equal(gap.rejectedByLabel[0].child, 5426);
    assert.equal(gap.rejectedByLabel[0].reason, 'blocking_label');
});

test('#5516 SO-9 mantiene SO-8 fail-closed: payload sin labels → excluido y reportado', () => {
    const sinLabels = child(5440, 5340);
    delete sinLabels.labels;
    const gap = sor.splitChildrenMissingFromAllowlist({
        issues: [sinLabels],
        waveIssues: [5340, 5440],
        allowlistIssues: [5340],
    });
    assert.deepEqual(gap.missing, []);
    assert.equal(gap.rejectedByLabel[0].reason, 'labels_unavailable');
});

test('#5516 SO-9 mantiene SO-7: autor no confiable de la ola no entra a la allowlist', () => {
    const gap = sor.splitChildrenMissingFromAllowlist({
        issues: [child(6001, 5340, { ...UNTRUSTED_AUTHOR })],
        waveIssues: [5340, 6001],
        allowlistIssues: [5340],
    });
    assert.deepEqual(gap.missing, [], 'default-deny por origen no confiable');
});

test('#5516 SO-9 mantiene SO-3: un hijo CERRADO de la ola no entra a la allowlist', () => {
    const gap = sor.splitChildrenMissingFromAllowlist({
        issues: [child(5440, 5340, { state: 'CLOSED' })],
        waveIssues: [5340, 5440],
        allowlistIssues: [5340],
    });
    assert.deepEqual(gap.missing, []);
});

test('#5516 SO-9 cierra la brecha de VARIOS hijos, ordenada y sin duplicados', () => {
    const corpus = [child(5460, 5452), child(5458, 5452), child(5459, 5452), child(5458, 5452)];
    const gap = sor.splitChildrenMissingFromAllowlist({
        issues: corpus,
        waveIssues: [5452, 5458, 5459, 5460],
        allowlistIssues: [5452],
    });
    assert.deepEqual(gap.missing, [5458, 5459, 5460], 'orden asc, sin duplicados');
});

test('#5516 SO-9 respeta el cap SO-5 y REPORTA el truncado', () => {
    const corpus = [];
    const wave = [5000];
    for (let i = 1; i <= 8; i++) { corpus.push(child(6000 + i, 5000)); wave.push(6000 + i); }
    const gap = sor.splitChildrenMissingFromAllowlist({
        issues: corpus, waveIssues: wave, allowlistIssues: [5000], maxIncorporations: 3,
    });
    assert.equal(gap.missing.length, 3, 'corta en el cap');
    assert.equal(gap.truncated, true);
    assert.equal(gap.reason, 'max_incorporations');
});

test('#5516 SO-9 entradas basura no rompen ni cuelan nada', () => {
    for (const bad of [undefined, null, {}, { issues: null }, { issues: 'x', waveIssues: 3 }]) {
        const gap = sor.splitChildrenMissingFromAllowlist(bad);
        assert.deepEqual(gap.missing, []);
        assert.equal(gap.truncated, false);
    }
    const gap = sor.splitChildrenMissingFromAllowlist({
        issues: [null, 42, 'x', {}, { number: 0 }, { number: -1 }],
        waveIssues: [1, 2], allowlistIssues: [],
    });
    assert.deepEqual(gap.missing, []);
});

// --- Estructurales del wire-up: los 3 caminos que review encontró rotos -------

test('#5516 estructural: el paso 5 es ALCANZABLE — no hay early return antes', () => {
    const fs = require('node:fs');
    const PULPO_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
    const fn = PULPO_SRC.slice(PULPO_SRC.indexOf('function reconcileSplitOrphansFromGithub('));
    const body = fn.slice(0, fn.indexOf('\nfunction '));

    const iOrphans = body.indexOf('const orphans =');
    const iPaso5 = body.indexOf('splitChildrenMissingFromAllowlist');
    assert.ok(iOrphans > 0 && iPaso5 > iOrphans, 'el paso 5 usa el helper puro SO-9');

    // Los DOS early returns que hacían inalcanzable al paso 5 ya no pueden estar
    // ANTES de él. Ésta es la regresión exacta del rechazo de review.
    const entre = body.slice(iOrphans, iPaso5);
    assert.doesNotMatch(entre, /return\s*\{[^}]*reason:\s*'no_orphans'/,
        'no_orphans NO debe retornar antes del paso 5 (dejaba la brecha sin reintento)');
    assert.doesNotMatch(entre, /return\s*\{[^}]*reason:\s*'nothing_added'/,
        'nothing_added NO debe retornar antes del paso 5 (segundo camino del doble cinturón)');
});

test('#5516 estructural: los WARN del paso 5 no prometen un reintento inexistente', () => {
    const fs = require('node:fs');
    const PULPO_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
    const fn = PULPO_SRC.slice(PULPO_SRC.indexOf('function reconcileSplitOrphansFromGithub('));
    const body = fn.slice(0, fn.indexOf('\nfunction '));
    // Cada aviso de allowlist NO actualizada debe explicar el mecanismo REAL
    // (re-derivación del estado / SO-9), no un "se reintenta" sin sustento.
    const warns = body.split('\n').filter((l) => /allowlist NO actualizada|modo cambió a|fallo al actualizar allowlist/.test(l));
    assert.ok(warns.length >= 3, `se esperaban los 3 caminos de fallo, hay ${warns.length}`);
    const blob = body.slice(body.indexOf('splitChildrenMissingFromAllowlist'));
    assert.match(blob, /SO-9/, 'los WARN referencian el mecanismo que sí existe');
});

test('#5516 estructural: el Telegram no afirma dependencia declarada si falló', () => {
    const fs = require('node:fs');
    const PULPO_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
    const fn = PULPO_SRC.slice(PULPO_SRC.indexOf('function reconcileSplitOrphansFromGithub('));
    const body = fn.slice(0, fn.indexOf('\nfunction '));
    // El fallo de `addDependency` se registra y la afirmación queda condicionada.
    assert.match(body, /dependencyFailures/, 'los fallos de addDependency se registran');
    assert.match(body, /dependencyFailures\.length === 0[\s\S]{0,120}Dependencia padre→hijos declarada/,
        'la afirmación es condicional al éxito real');
});

test('#5516 estructural: la query de búsqueda sale de repo-target, no hardcodeada', () => {
    const fs = require('node:fs');
    const PULPO_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
    // Convención #4693 CA-0: `lib/repo-target` es la fuente de verdad única.
    assert.match(PULPO_SRC, /function splitOrphanSearchQuery\(\)/);
    const q = PULPO_SRC.slice(PULPO_SRC.indexOf('function splitOrphanSearchQuery()'));
    const qBody = q.slice(0, q.indexOf('\n}'));
    assert.match(qBody, /repoTarget\.getPrimaryRepo\(\)/, 'usa la fuente de verdad única');
    assert.match(qBody, /SPLIT_ORPHAN_REPO_RE\.test/, 'valida el valor antes de interpolarlo');
    // Y la constante vieja con el repo hardcodeado ya no existe.
    assert.doesNotMatch(PULPO_SRC, /const SPLIT_ORPHAN_SEARCH_Q\s*=\s*\n?\s*'repo%3Aintrale/,
        'la query hardcodeada quedó eliminada');
});

test('#5516 estructural: el wire-up pide labels de verdad en la query REST', () => {
    // Refuerzo del test débil que review señaló: antes sólo afirmaba que los
    // strings `rejectedByLabel`/`SO-8` aparecían, así que una regresión a una
    // query con campos limitados (que desactivaría SO-8 en silencio, porque el
    // default-deny excluiría TODO) pasaba desapercibida.
    const fs = require('node:fs');
    const PULPO_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
    const fn = PULPO_SRC.slice(PULPO_SRC.indexOf('function reconcileSplitOrphansFromGithub('));
    const body = fn.slice(0, fn.indexOf('\nfunction '));

    // La fuente debe ser `search/issues`, que devuelve el issue COMPLETO
    // (incluido `labels`), y no una variante con selección de campos.
    assert.match(body, /search\/issues\?q=/, 'usa el índice de búsqueda');
    assert.doesNotMatch(body, /--json\s/, 'no usa `gh issue list --json`, que no trae authorAssociation');
    // Ningún recorte de campos (`--jq`, `&fields=`) sobre el payload de búsqueda:
    // recortar `labels` o `author_association` desactivaría SO-8/SO-7 en silencio.
    const cmd = body.slice(body.indexOf('search/issues?q='), body.indexOf('search/issues?q=') + 400);
    assert.doesNotMatch(cmd, /--jq|--template|&fields=/,
        'sin recorte de campos: labels y author_association deben llegar completos');
    // Y el guard se alimenta de ese payload.
    assert.match(body, /rejectedByLabel/);
    assert.match(body, /SO-8/);
});
