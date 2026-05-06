// #3035 — Tests del slice recentlyFinished + flag onlyRejected.
// El filtro server-side asegura que el cliente NO recibe la lista completa
// para filtrar localmente (defense-in-depth, ver security review del issue).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const slices = require('../lib/dashboard-slices');

function makeEntry(skill, estado, resultado, updatedAt) {
    return {
        skill,
        estado,
        resultado,
        pipeline: 'desarrollo',
        fase: 'verificacion',
        durationMs: 60000,
        updatedAt,
        hasLog: true,
        logFile: `${skill}.log`,
    };
}

function buildState() {
    // Histórico mezclado: 12 finalizados (5 aprobados, 4 rechazados, 3 sin
    // resultado) más uno en estado `trabajando` que NO debe aparecer.
    const now = Date.now();
    const min = (n) => now - n * 60000; // minutos atrás
    return {
        issueMatrix: {
            '100': {
                title: 'Issue 100',
                fases: {
                    'desarrollo/verificacion': [
                        makeEntry('tester', 'procesado', 'aprobado', min(60)),
                        makeEntry('qa', 'procesado', 'rechazado', min(50)),
                    ],
                },
            },
            '101': {
                title: 'Issue 101',
                fases: {
                    'desarrollo/verificacion': [
                        makeEntry('tester', 'procesado', 'rechazado', min(40)),
                        makeEntry('qa', 'procesado', 'aprobado', min(30)),
                    ],
                },
            },
            '102': {
                title: 'Issue 102',
                fases: {
                    'desarrollo/build': [
                        makeEntry('build', 'procesado', 'rechazado', min(20)),
                    ],
                    'desarrollo/dev': [
                        makeEntry('pipeline-dev', 'procesado', 'aprobado', min(15)),
                    ],
                },
            },
            '103': {
                title: 'Issue 103',
                fases: {
                    'desarrollo/aprobacion': [
                        makeEntry('review', 'listo', 'rechazado', min(10)),
                        makeEntry('po', 'procesado', 'aprobado', min(5)),
                    ],
                },
            },
            '104': {
                title: 'Issue 104 sin resultado',
                fases: {
                    'desarrollo/dev': [
                        makeEntry('pipeline-dev', 'procesado', null, min(70)),
                        makeEntry('android-dev', 'procesado', null, min(80)),
                        makeEntry('backend-dev', 'procesado', null, min(90)),
                    ],
                    'desarrollo/build': [
                        // Trabajando = NO debe contarse (no es estado terminal).
                        { skill: 'build', estado: 'trabajando', resultado: null,
                          pipeline: 'desarrollo', fase: 'build', durationMs: 5000,
                          updatedAt: min(2), hasLog: false, logFile: null },
                    ],
                },
            },
            '105': {
                title: 'Issue 105 aprobado final',
                fases: {
                    'desarrollo/entrega': [
                        makeEntry('delivery', 'procesado', 'aprobado', min(1)),
                    ],
                },
            },
        },
    };
}

test('recentlyFinished sin opts retorna mezcla ordenada por finishedAt desc', () => {
    const state = buildState();
    const out = slices.recentlyFinished(state, 10);
    // Debe haber items y el primero debe ser el más reciente (issue 105 delivery).
    assert.ok(out.length > 0);
    assert.equal(out[0].issue, '105');
    assert.equal(out[0].resultado, 'aprobado');
    // No debe incluir el `trabajando` del issue 104.
    const trabajando = out.find(x => x.skill === 'build' && x.issue === '104');
    assert.equal(trabajando, undefined);
});

test('recentlyFinished con onlyRejected: true filtra solo rechazados', () => {
    const state = buildState();
    const out = slices.recentlyFinished(state, 10, { onlyRejected: true });
    // Hay 4 rechazados en el state (qa@100, tester@101, build@102, review@103).
    assert.equal(out.length, 4);
    for (const item of out) {
        assert.equal(item.resultado, 'rechazado',
            `item ${item.issue}/${item.skill} debería ser rechazado, fue ${item.resultado}`);
    }
    // Orden por finishedAt desc: review@103 (10min), build@102 (20min),
    // tester@101 (40min), qa@100 (50min).
    assert.equal(out[0].issue, '103');
    assert.equal(out[0].skill, 'review');
    assert.equal(out[3].issue, '100');
    assert.equal(out[3].skill, 'qa');
});

test('recentlyFinished con onlyRejected: false equivale al comportamiento default', () => {
    const state = buildState();
    const a = slices.recentlyFinished(state, 10);
    const b = slices.recentlyFinished(state, 10, { onlyRejected: false });
    assert.deepEqual(a, b);
});

test('recentlyFinished con onlyRejected respeta el limit', () => {
    const state = buildState();
    const out = slices.recentlyFinished(state, 2, { onlyRejected: true });
    assert.equal(out.length, 2);
    // Los 2 más recientes rechazados.
    assert.equal(out[0].issue, '103');
    assert.equal(out[1].issue, '102');
});

test('recentlyFinished con state vacío retorna []', () => {
    assert.deepEqual(slices.recentlyFinished({}, 10), []);
    assert.deepEqual(slices.recentlyFinished({ issueMatrix: {} }, 10, { onlyRejected: true }), []);
});

test('recentlyFinished onlyRejected sin rechazos retorna []', () => {
    const onlyApproved = {
        issueMatrix: {
            '200': {
                title: 'Solo aprobados',
                fases: {
                    'desarrollo/verificacion': [
                        makeEntry('tester', 'procesado', 'aprobado', Date.now() - 60000),
                        makeEntry('qa', 'procesado', 'aprobado', Date.now() - 30000),
                    ],
                },
            },
        },
    };
    const out = slices.recentlyFinished(onlyApproved, 10, { onlyRejected: true });
    assert.deepEqual(out, []);
});

test('recentlyFinished incluye finishedAt en el payload', () => {
    const state = buildState();
    const out = slices.recentlyFinished(state, 10);
    for (const item of out) {
        assert.ok(item.finishedAt, `item ${item.issue}/${item.skill} debería tener finishedAt`);
        assert.equal(typeof item.finishedAt, 'number');
    }
});

test('recentlyFinished ignora opts no-objeto sin romper', () => {
    const state = buildState();
    // Compatibilidad: si alguien llama con un valor weird como segundo opcional.
    assert.doesNotThrow(() => slices.recentlyFinished(state, 10, null));
    assert.doesNotThrow(() => slices.recentlyFinished(state, 10, undefined));
    assert.doesNotThrow(() => slices.recentlyFinished(state, 10, 'truthy'));
    // Con string truthy NO debe activar el filtro (no es un object con
    // onlyRejected: true). La firma es opts.onlyRejected, no opts truthy.
    const out = slices.recentlyFinished(state, 10, 'truthy');
    const allRejected = out.every(x => x.resultado === 'rechazado');
    assert.equal(allRejected, false);
});
