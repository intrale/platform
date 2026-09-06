// =============================================================================
// Tests de lib/waiting-operator.js — lector unificado de pendientes de firma
// (#4580, épico #4570).
//
// Cubre el contrato del issue:
//   - REQ-SEC-4580-3: id de issue no numérico → descartado (nunca toca el FS).
//   - REQ-SEC-4580-5: la evidencia se emite redactada (secrets/tokens enmascarados).
//   - CA-1: unifica los tres orígenes (waiting-operator/ · esperando-firma/ ·
//     GATE 3) en un solo array con {issue, origen, phase, pipeline, evidencia,
//     sugerencia, waiting_since}.
//   - La sugerencia consume confidence-index cuando hay criterios; null si no.
//
// Se ejecuta con: node --test .pipeline/lib/__tests__/waiting-operator.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wo = require('../waiting-operator.js');

// Crea un árbol de pipeline temporal y devuelve su raíz (dir `.pipeline`-like).
function makeTmpPipeline() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-test-'));
    return root;
}
function writeMarker(root, pipeline, phase, subdir, name, content = '') {
    const dir = path.join(root, pipeline, phase, subdir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
    return path.join(dir, name);
}
function writeDeliverable(delivDir, issue, obj) {
    fs.mkdirSync(delivDir, { recursive: true });
    fs.writeFileSync(path.join(delivDir, `${issue}.json`), JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// REQ-SEC-4580-3 — validación del id
// ---------------------------------------------------------------------------
test('isValidIssueId acepta enteros positivos y rechaza el resto (REQ-SEC-4580-3)', () => {
    assert.equal(wo.isValidIssueId('1732'), true);
    assert.equal(wo.isValidIssueId('0'), false);      // no positivo
    assert.equal(wo.isValidIssueId('12a'), false);
    assert.equal(wo.isValidIssueId('../etc'), false);
    assert.equal(wo.isValidIssueId('-5'), false);
    assert.equal(wo.isValidIssueId(''), false);
    assert.equal(wo.isValidIssueId('1.2'), false);
});

test('listWaitingOperator descarta markers con id no numérico (REQ-SEC-4580-3)', () => {
    const root = makeTmpPipeline();
    const delivDir = path.join(root, 'deliverables');
    // marker válido y marker con id traversal-like
    writeMarker(root, 'desarrollo', 'criterios', 'waiting-operator', '1732.po');
    writeMarker(root, 'desarrollo', 'criterios', 'waiting-operator', '..%2Fetc.hack');
    writeMarker(root, 'desarrollo', 'criterios', 'waiting-operator', 'abc.skill');

    const list = wo.listWaitingOperator({ pipelineDir: root, pipelines: ['desarrollo'], deliverablesDir: delivDir, now: () => Date.parse('2026-07-10T12:00:00Z') });
    assert.equal(list.length, 1);
    assert.equal(list[0].issue, 1732);
    assert.equal(list[0].skill, 'po');
});

// ---------------------------------------------------------------------------
// REQ-SEC-4580-5 — evidencia redactada
// ---------------------------------------------------------------------------
test('loadEvidence redacta secrets embebidos en la evidencia (REQ-SEC-4580-5)', () => {
    const root = makeTmpPipeline();
    const delivDir = path.join(root, 'deliverables');
    writeDeliverable(delivDir, 4580, {
        issue: 4580,
        entries: [
            { agente: 'security', fase: 'verificacion', tipo: 'document', path: '/secret/path/report.md', motivo: 'token sk-ant-abcdefghijklmnop1234567890', sensible: true, timestamp: '2026-07-10T00:00:00Z' },
        ],
    });
    const ev = wo.loadEvidence('4580', { deliverablesDir: delivDir });
    assert.equal(ev.length, 1);
    // El path absoluto crudo nunca se emite (sólo basename), y el token va redactado.
    const asStr = JSON.stringify(ev);
    assert.ok(!asStr.includes('sk-ant-abcdefghijklmnop1234567890'), 'el token no debe aparecer crudo');
    assert.ok(!asStr.includes('/secret/path/'), 'el path absoluto crudo no debe aparecer');
    assert.equal(ev[0].artefacto, 'report.md');
    assert.equal(ev[0].sensible, true);
});

test('loadEvidence devuelve [] si no hay deliverable', () => {
    const root = makeTmpPipeline();
    const ev = wo.loadEvidence('9999', { deliverablesDir: path.join(root, 'deliverables') });
    assert.deepEqual(ev, []);
});

// ---------------------------------------------------------------------------
// CA-1 — unifica los tres orígenes
// ---------------------------------------------------------------------------
test('listWaitingOperator unifica los tres orígenes con su origen correcto (CA-1)', () => {
    const root = makeTmpPipeline();
    const delivDir = path.join(root, 'deliverables');
    writeMarker(root, 'desarrollo', 'criterios', 'waiting-operator', '100.po');
    writeMarker(root, 'desarrollo', 'aprobacion', 'esperando-firma', '200.architect');
    writeMarker(root, 'desarrollo', 'entrega', 'waiting-operator-autonomo', '300.delivery');

    const now = Date.parse('2026-07-10T12:00:00Z');
    const list = wo.listWaitingOperator({ pipelineDir: root, pipelines: ['desarrollo'], deliverablesDir: delivDir, now: () => now });
    assert.equal(list.length, 3);
    const byIssue = Object.fromEntries(list.map(p => [p.issue, p]));
    assert.equal(byIssue[100].origen, 'waiting-operator-def');
    assert.equal(byIssue[200].origen, 'waiting-operator-acc');
    assert.equal(byIssue[300].origen, 'gate3');
    // Estructura mínima del contrato.
    for (const p of list) {
        assert.ok(typeof p.phase === 'string');
        assert.ok(typeof p.pipeline === 'string');
        assert.ok(Array.isArray(p.evidencia));
        assert.ok('sugerencia' in p);
        assert.ok(typeof p.waiting_since === 'string');
    }
});

test('listWaitingOperator ignora .gitkeep y no rompe con dirs ausentes', () => {
    const root = makeTmpPipeline();
    const delivDir = path.join(root, 'deliverables');
    writeMarker(root, 'desarrollo', 'criterios', 'waiting-operator', '.gitkeep');
    // sólo el .gitkeep → no debe listar nada, ni lanzar.
    const list = wo.listWaitingOperator({ pipelineDir: root, pipelines: ['desarrollo', 'definicion'], deliverablesDir: delivDir, now: () => Date.now() });
    assert.deepEqual(list, []);
});

// ---------------------------------------------------------------------------
// Sugerencia (índice de confiabilidad #4576)
// ---------------------------------------------------------------------------
test('loadSuggestion consume confidence-index cuando hay criterios inyectados', () => {
    const sug = wo.loadSuggestion({
        deps: {
            criteriaSource: {
                criterios: [
                    { key: 'CA-1', text: 'corré ./gradlew :app:test y verificá que pase' }, // máquina
                    { key: 'CA-2', text: 'el diseño se ve lindo y coherente' },  // humano
                ],
                gateResults: { 'CA-1': 'pass' },
            },
        },
    });
    assert.ok(sug, 'debe devolver una sugerencia');
    assert.equal(sug.total, 2);
    assert.equal(sug.solo_humanos, 1);
    assert.equal(sug.verbo, 'revisar'); // hay un criterio solo-humano
    assert.ok(Array.isArray(sug.items));
});

test('loadSuggestion devuelve null sin fuente de criterios', () => {
    assert.equal(wo.loadSuggestion({ deps: {} }), null);
    assert.equal(wo.loadSuggestion({ deps: { criteriaSource: { criterios: [] } } }), null);
});

// ===========================================================================
// #6208 · CA-16 — GATE 1 se llama GATE 1 en todas las superficies.
//
// `waiting-operator.js:58` decía `GATE 0` para `waiting-operator-def`, contra la
// doc canónica (`docs/pipeline/gates-firma-operador.md:167`) y contra la vista,
// que ya decía GATE 1 (H-UX-6199-2). Este test FIJA la tabla para que no vuelva
// a divergir: si alguien la cambia, se entera acá.
// ===========================================================================
test('#6208 · CA-16: la tabla de orígenes fija los nombres de gate y no divergen de la vista', () => {
    const view = require('../../views/dashboard/esperando-firma.js');
    const esperado = {
        'waiting-operator-def': 'GATE 1',
        'waiting-operator-acc': 'GATE 2',
        gate3: 'GATE 3',
    };
    const actual = {};
    for (const s of require('../waiting-operator.js').SOURCES) actual[s.origen] = s.gate;
    assert.deepEqual(actual, esperado);

    // D-3 — `esperando-firma.js:70` YA estaba bien y no se toca: los dos lados
    // dicen lo mismo.
    for (const [origen, gate] of Object.entries(esperado)) {
        assert.ok(
            view.ORIGENES[origen].label.startsWith(gate),
            `${origen}: la vista dice "${view.ORIGENES[origen].label}" y la tabla dice "${gate}"`,
        );
    }
});
