// =============================================================================
// doc-create.test.js — Cobertura del camino determinístico de creación de
// issues desde el Telegram Commander (#3819).
//
// Estructura:
//   1. inferLabels — garantiza los 5 labels base + inferencia por keyword.
//   2. deriveTitle — extracción/capado de título, strip de preámbulo de pedido.
//   3. buildBody — body estandarizado con secciones obligatorias.
//   4. resolveBacklog — backlog por app.
//   5. createIssue — happy path, duplicado, error, fail-safe (nunca cuelga),
//      audit log, sanitización, alta en Project V2 best-effort.
//   6. formatResultMessage — siempre string accionable.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const dc = require('../doc-create');

// -----------------------------------------------------------------------------
// 1. inferLabels
// -----------------------------------------------------------------------------

test('inferLabels: siempre devuelve los 5 grupos de labels base', () => {
    const r = dc.inferLabels('algo genérico sin keywords claras');
    assert.ok(r.labels.some((l) => l.startsWith('area:')), 'tiene area:*');
    assert.ok(r.labels.some((l) => l.startsWith('priority:')), 'tiene priority:*');
    assert.ok(r.labels.some((l) => l.startsWith('size:')), 'tiene size:*');
    assert.ok(r.labels.includes('bug') || r.labels.includes('enhancement'), 'tiene tipo');
    assert.ok(
        r.labels.includes('needs-definition') || r.labels.includes('Ready'),
        'tiene admisión'
    );
});

test('inferLabels: default sin keyword → area:infra, enhancement, medium, needs-definition', () => {
    const r = dc.inferLabels('texto neutro');
    assert.equal(r.area, 'area:infra');
    assert.equal(r.type, 'enhancement');
    assert.equal(r.priority, 'priority:medium');
    assert.equal(r.size, 'size:medium');
    assert.equal(r.admission, 'needs-definition');
});

test('inferLabels: detecta bug por keyword', () => {
    assert.equal(dc.inferLabels('hay un error en el login que no funciona').type, 'bug');
    assert.equal(dc.inferLabels('arreglar el crash del carrito').type, 'bug');
    assert.equal(dc.inferLabels('agregar filtro de búsqueda').type, 'enhancement');
});

test('inferLabels: detecta area:pipeline y area:pagos', () => {
    assert.equal(dc.inferLabels('el pulpo del pipeline se cuelga').area, 'area:pipeline');
    assert.equal(dc.inferLabels('mejorar el checkout de pagos con tarjeta').area, 'area:pagos');
});

test('inferLabels: detecta prioridad y tamaño', () => {
    assert.equal(dc.inferLabels('esto es urgente y crítico').priority, 'priority:high');
    assert.equal(dc.inferLabels('cuando puedas, baja prioridad').priority, 'priority:low');
    assert.equal(dc.inferLabels('tarea simple y rápida').size, 'size:small');
    assert.equal(dc.inferLabels('es un épico grande y complejo').size, 'size:large');
});

test('inferLabels: detecta app y admisión Ready explícita', () => {
    const r = dc.inferLabels('feature para el cliente, ya está listo para desarrollo');
    assert.ok(r.app.includes('app:client'));
    assert.equal(r.admission, 'Ready');
});

test('inferLabels: labels sin duplicados', () => {
    const r = dc.inferLabels('infra de infra infraestructura');
    assert.equal(new Set(r.labels).size, r.labels.length);
});

// -----------------------------------------------------------------------------
// 2. deriveTitle
// -----------------------------------------------------------------------------

test('deriveTitle: strip del preámbulo de pedido', () => {
    const t = dc.deriveTitle('creá un issue para eliminar referencias a ElevenLabs');
    assert.ok(/eliminar referencias a ElevenLabs/i.test(t));
    assert.ok(!/^cre[aá]/i.test(t));
});

test('deriveTitle: primera oración y capitalización', () => {
    const t = dc.deriveTitle('mejorar el dashboard. Otra oración que no entra.');
    assert.equal(t, 'Mejorar el dashboard');
});

test('deriveTitle: capa a 80 chars con elipsis', () => {
    const long = 'a'.repeat(200);
    const t = dc.deriveTitle(long);
    assert.ok(t.length <= 81, `len=${t.length}`);
    assert.ok(t.endsWith('…'));
});

test('deriveTitle: nunca vacío', () => {
    assert.ok(dc.deriveTitle('').length > 0);
    assert.ok(dc.deriveTitle('   ').length > 0);
});

// -----------------------------------------------------------------------------
// 3. buildBody
// -----------------------------------------------------------------------------

test('buildBody: incluye secciones estándar obligatorias', () => {
    const body = dc.buildBody({ description: 'desc x', from: 'leo', labels: ['area:infra'] });
    for (const sec of ['## Objetivo', '## Contexto', '## Cambios requeridos', '## Criterios de aceptación', '## Notas técnicas']) {
        assert.ok(body.includes(sec), `falta ${sec}`);
    }
    assert.ok(body.includes('desc x'));
    assert.ok(body.includes('`area:infra`'));
});

// -----------------------------------------------------------------------------
// 4. resolveBacklog
// -----------------------------------------------------------------------------

test('resolveBacklog: por app', () => {
    assert.equal(dc.resolveBacklog(['app:client']), 'Backlog CLIENTE');
    assert.equal(dc.resolveBacklog(['app:business']), 'Backlog NEGOCIO');
    assert.equal(dc.resolveBacklog(['app:delivery']), 'Backlog DELIVERY');
    assert.equal(dc.resolveBacklog([]), 'Backlog Tecnico');
});

// -----------------------------------------------------------------------------
// 5. createIssue
// -----------------------------------------------------------------------------

function makeDeps(overrides = {}) {
    const auditCalls = [];
    return {
        deps: {
            pipelineDir: '/tmp/fake-pipeline',
            now: (() => { let n = 1000; return () => (n += 100); })(),
            log: () => {},
            logAudit: (entry) => auditCalls.push(entry),
            runDuplicateCheck: () => ({ hasDuplicate: false, matches: [] }),
            runGhCreate: () => ({ url: 'https://github.com/intrale/platform/issues/4321', issueNumber: 4321 }),
            runAddToProject: () => ({ status: 'ok', itemId: 'PVTI_x' }),
            ...overrides,
        },
        auditCalls,
    };
}

test('createIssue: happy path crea issue, labels base, project, audit success', () => {
    const { deps, auditCalls } = makeDeps();
    const r = dc.createIssue({ description: 'agregar filtro de productos para el cliente', ...deps });
    assert.equal(r.status, 'created');
    assert.equal(r.issueNumber, 4321);
    assert.equal(r.projectAdded, true);
    assert.ok(r.labels.some((l) => l.startsWith('area:')));
    assert.ok(r.labels.includes('needs-definition'));
    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0].skillResult, require('../issue-creation').SKILL_RESULT_SUCCESS);
    assert.equal(auditCalls[0].issueCreated, 4321);
});

test('createIssue: duplicado → status duplicate, no crea, audit blocked', () => {
    let createCalled = false;
    const { deps, auditCalls } = makeDeps({
        runDuplicateCheck: () => ({ hasDuplicate: true, matches: [{ number: 99, title: 'parecido', score: 0.85 }] }),
        runGhCreate: () => { createCalled = true; return { issueNumber: 1 }; },
    });
    const r = dc.createIssue({ description: 'algo parecido a otro', ...deps });
    assert.equal(r.status, 'duplicate');
    assert.equal(createCalled, false, 'no debe crear si hay duplicado');
    assert.equal(r.matches[0].number, 99);
    assert.equal(auditCalls[0].skillResult, require('../issue-creation').SKILL_RESULT_BLOCKED);
});

test('createIssue: force ignora el duplicado y crea', () => {
    const { deps } = makeDeps({
        runDuplicateCheck: () => ({ hasDuplicate: true, matches: [{ number: 99 }] }),
    });
    const r = dc.createIssue({ description: 'algo', force: true, ...deps });
    assert.equal(r.status, 'created');
});

test('createIssue: gh falla → status error, nunca lanza (fail-safe)', () => {
    const { deps, auditCalls } = makeDeps({
        runGhCreate: () => { throw new Error('gh boom'); },
    });
    let r;
    assert.doesNotThrow(() => { r = dc.createIssue({ description: 'algo', ...deps }); });
    assert.equal(r.status, 'error');
    assert.ok(/gh_create_failed/.test(r.error));
    assert.equal(auditCalls[0].skillResult, require('../issue-creation').SKILL_RESULT_ERROR);
});

test('createIssue: dup-check que tira excepción NO bloquea la creación', () => {
    const { deps } = makeDeps({
        runDuplicateCheck: () => { throw new Error('sin red'); },
    });
    const r = dc.createIssue({ description: 'algo', ...deps });
    assert.equal(r.status, 'created');
});

test('createIssue: alta en Project falla → igual created (best-effort) con projectAdded false', () => {
    const { deps } = makeDeps({
        runAddToProject: () => { throw new Error('graphql down'); },
    });
    const r = dc.createIssue({ description: 'algo', ...deps });
    assert.equal(r.status, 'created');
    assert.equal(r.projectAdded, false);
});

test('createIssue: descripción vacía → error invalid_args sin crear', () => {
    let createCalled = false;
    const { deps } = makeDeps({
        runGhCreate: () => { createCalled = true; return { issueNumber: 1 }; },
    });
    const r = dc.createIssue({ description: '   ', ...deps });
    assert.equal(r.status, 'error');
    assert.equal(r.error, 'descripcion_vacia');
    assert.equal(createCalled, false);
});

test('createIssue: gh devuelve sin issueNumber → error skill_failed', () => {
    const { deps, auditCalls } = makeDeps({
        runGhCreate: () => ({ url: 'x', issueNumber: null }),
    });
    const r = dc.createIssue({ description: 'algo', ...deps });
    assert.equal(r.status, 'error');
    assert.equal(r.error, 'gh_create_no_issue_number');
    assert.equal(auditCalls[0].skillResult, require('../issue-creation').SKILL_RESULT_SKILL_FAILED);
});

test('createIssue: siempre escribe exactamente una línea de audit log', () => {
    for (const scenario of [
        { description: 'ok normal' },
        { description: '   ' },
        { runGhCreate: () => { throw new Error('x'); }, description: 'boom' },
        { runDuplicateCheck: () => ({ hasDuplicate: true, matches: [] }), description: 'dup' },
    ]) {
        const { description, ...ov } = scenario;
        const { deps, auditCalls } = makeDeps(ov);
        dc.createIssue({ description, ...deps });
        assert.equal(auditCalls.length, 1, `audit únicó para: ${description}`);
    }
});

// -----------------------------------------------------------------------------
// 6. formatResultMessage
// -----------------------------------------------------------------------------

test('formatResultMessage: created incluye número, labels, backlog', () => {
    const msg = dc.formatResultMessage({ status: 'created', issueNumber: 10, title: 'T', labels: ['area:infra'], backlog: 'Backlog Tecnico', url: 'u', projectAdded: true });
    assert.ok(msg.includes('#10'));
    assert.ok(msg.includes('area:infra'));
    assert.ok(msg.includes('Backlog Tecnico'));
});

test('formatResultMessage: created con projectAdded false avisa', () => {
    const msg = dc.formatResultMessage({ status: 'created', issueNumber: 10, title: 'T', labels: [], backlog: 'x', projectAdded: false });
    assert.ok(/Project V2/.test(msg));
});

test('formatResultMessage: duplicate y error son accionables', () => {
    assert.ok(/parecido/i.test(dc.formatResultMessage({ status: 'duplicate', matches: [{ number: 5, title: 'x', score: 0.9 }] })));
    assert.ok(/falló/i.test(dc.formatResultMessage({ status: 'error', error: 'x' })));
    assert.ok(dc.formatResultMessage(null).length > 0);
});
