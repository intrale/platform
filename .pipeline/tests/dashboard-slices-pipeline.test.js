// #2894 — Tests del pipelineSlice: agentes por fase activa,
// stale detection, fase dev con un solo skill, override por bloqueado-humano,
// resolución de skill desde labels.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const slices = require('../lib/dashboard-slices');

// Config canónica del pipeline (subset minimal para los tests).
const baseConfig = {
    pipelines: {
        definicion: {
            fases: ['analisis', 'criterios', 'sizing'],
            skills_por_fase: {
                analisis: ['guru', 'security'],
                criterios: ['po', 'ux'],
                sizing: ['planner'],
            },
        },
        desarrollo: {
            fases: ['validacion', 'dev', 'build', 'verificacion', 'linteo', 'aprobacion', 'entrega'],
            skills_por_fase: {
                validacion: ['po', 'ux', 'guru'],
                dev: ['backend-dev', 'android-dev', 'web-dev', 'pipeline-dev'],
                build: ['build'],
                verificacion: ['tester', 'security', 'qa'],
                linteo: ['linter'],
                aprobacion: ['review', 'po', 'ux'],
                entrega: ['delivery'],
            },
        },
    },
    dev_skill_mapping: {
        'area:pipeline': 'pipeline-dev',
        'area:backend': 'backend-dev',
        'app:client': 'android-dev',
        'area:web': 'web-dev',
        default: 'backend-dev',
    },
    dev_routing_priority: ['area:pipeline', 'area:backend', 'area:web', 'app:client'],
};

function makeEntry(skill, estado, ageMin = 5, extra = {}) {
    return {
        skill,
        estado,
        pipeline: 'desarrollo',
        fase: 'validacion',
        ageMin,
        durationMs: 60000,
        updatedAt: Date.now() - ageMin * 60000,
        hasLog: true,
        logFile: `2894-${skill}.log`,
        ...extra,
    };
}

test('resolveDevSkillFromLabels respeta dev_routing_priority', () => {
    const fn = slices._resolveDevSkillFromLabels;
    // Issue con app:client + area:pipeline → gana area:pipeline por priority.
    assert.equal(fn(baseConfig, ['app:client', 'area:pipeline']), 'pipeline-dev');
    // Solo app:client → android-dev.
    assert.equal(fn(baseConfig, ['app:client']), 'android-dev');
    // Sin label de área → default.
    assert.equal(fn(baseConfig, ['enhancement']), 'backend-dev');
    // Sin labels → default.
    assert.equal(fn(baseConfig, []), 'backend-dev');
});

test('pipelineSlice expone agents para fase validacion con skills configurados', () => {
    const state = {
        config: baseConfig,
        bloqueados: [],
        allFases: [],
        issueMatrix: {
            '2890': {
                title: 'Test',
                labels: ['Ready'],
                faseActual: 'desarrollo/validacion',
                estadoActual: 'listo',
                bounces: 0,
                staleMin: 0,
                fases: {
                    'desarrollo/validacion': [
                        makeEntry('guru', 'listo', 12),
                        makeEntry('po', 'listo', 10),
                        makeEntry('ux', 'pendiente', 8),
                    ],
                },
            },
        },
    };
    const out = slices.pipelineSlice(state, { PIPELINE: '/tmp' });
    const agents = out.matrix['2890'].agents;
    assert.equal(agents.length, 3, 'debería haber 3 agentes (guru/po/ux)');
    const bySkill = Object.fromEntries(agents.map(a => [a.skill, a]));
    assert.equal(bySkill.guru.estado, 'listo');
    assert.equal(bySkill.po.estado, 'listo');
    assert.equal(bySkill.ux.estado, 'pendiente');
});

test('pipelineSlice fase dev solo expone el skill efectivamente presente', () => {
    const state = {
        config: baseConfig,
        bloqueados: [],
        allFases: [],
        issueMatrix: {
            '2894': {
                title: 'pipeline issue',
                labels: ['area:pipeline', 'app:client'],
                faseActual: 'desarrollo/dev',
                estadoActual: 'trabajando',
                bounces: 0,
                staleMin: 5,
                fases: {
                    'desarrollo/dev': [makeEntry('pipeline-dev', 'trabajando', 5)],
                },
            },
        },
    };
    const out = slices.pipelineSlice(state, { PIPELINE: '/tmp' });
    const agents = out.matrix['2894'].agents;
    assert.equal(agents.length, 1, 'dev = un solo skill');
    assert.equal(agents[0].skill, 'pipeline-dev');
    assert.equal(agents[0].estado, 'trabajando');
});

test('pipelineSlice fase dev sin marker resuelve skill desde labels', () => {
    const state = {
        config: baseConfig,
        bloqueados: [],
        allFases: [],
        issueMatrix: {
            '999': {
                title: 'no-marker',
                labels: ['area:pipeline'],
                faseActual: 'desarrollo/dev',
                estadoActual: 'pendiente',
                bounces: 0,
                staleMin: 0,
                fases: { 'desarrollo/dev': [] },
            },
        },
    };
    const out = slices.pipelineSlice(state, { PIPELINE: '/tmp' });
    const agents = out.matrix['999'].agents;
    assert.equal(agents.length, 1);
    assert.equal(agents[0].skill, 'pipeline-dev');
    assert.equal(agents[0].estado, 'pendiente');
});

test('pipelineSlice marca como fallido un entry con resultado=rechazado', () => {
    const state = {
        config: baseConfig,
        bloqueados: [],
        allFases: [],
        issueMatrix: {
            '2895': {
                title: 'rechazado',
                labels: [],
                faseActual: 'desarrollo/validacion',
                estadoActual: 'listo',
                bounces: 1,
                staleMin: 0,
                fases: {
                    'desarrollo/validacion': [
                        makeEntry('po', 'listo', 5, { resultado: 'rechazado', motivo: 'falta CA' }),
                        makeEntry('guru', 'listo', 5, { resultado: 'aprobado' }),
                    ],
                },
            },
        },
    };
    const out = slices.pipelineSlice(state, { PIPELINE: '/tmp' });
    const agents = out.matrix['2895'].agents;
    const po = agents.find(a => a.skill === 'po');
    const guru = agents.find(a => a.skill === 'guru');
    assert.equal(po.estado, 'fallido', 'po con resultado=rechazado debe ser fallido');
    assert.equal(guru.estado, 'listo', 'guru aprobado sigue listo');
});

test('pipelineSlice override bloqueado-humano por skill', () => {
    const state = {
        config: baseConfig,
        bloqueados: [
            { issue: 2896, pipeline: 'desarrollo', phase: 'validacion', skill: 'ux', reason: 'falta info' },
        ],
        allFases: [],
        issueMatrix: {
            '2896': {
                title: 'human-block',
                labels: ['needs-human'],
                faseActual: 'desarrollo/validacion',
                estadoActual: 'pendiente',
                bounces: 0,
                staleMin: 0,
                fases: {
                    'desarrollo/validacion': [
                        makeEntry('po', 'listo', 5),
                        makeEntry('ux', 'pendiente', 60),
                        makeEntry('guru', 'listo', 5),
                    ],
                },
            },
        },
    };
    const out = slices.pipelineSlice(state, { PIPELINE: '/tmp' });
    const ux = out.matrix['2896'].agents.find(a => a.skill === 'ux');
    assert.equal(ux.estado, 'bloqueado', 'ux con marker en bloqueados debe ser bloqueado');
});

test('pipelineSlice detecta stale y marca el blocker skill', () => {
    const prev = process.env.PIPELINE_STALE_MIN_THRESHOLD;
    process.env.PIPELINE_STALE_MIN_THRESHOLD = '30';
    try {
        const state = {
            config: baseConfig,
            bloqueados: [],
            allFases: [],
            issueMatrix: {
                '2897': {
                    title: 'stuck',
                    labels: [],
                    faseActual: 'desarrollo/validacion',
                    estadoActual: 'trabajando',
                    bounces: 0,
                    staleMin: 45,
                    fases: {
                        'desarrollo/validacion': [
                            makeEntry('po', 'listo', 60),  // listo no cuenta como bloqueador
                            makeEntry('guru', 'pendiente', 45),
                            makeEntry('ux', 'trabajando', 32),
                        ],
                    },
                },
            },
        };
        const out = slices.pipelineSlice(state, { PIPELINE: '/tmp' });
        const m = out.matrix['2897'];
        assert.equal(m.stale, true, 'issue debería ser stale (45m > 30m umbral)');
        assert.equal(m.blockerSkill, 'guru', 'el bloqueador es el más viejo no-listo');
        assert.equal(m.blockerAgeMin, 45);
    } finally {
        if (prev === undefined) delete process.env.PIPELINE_STALE_MIN_THRESHOLD;
        else process.env.PIPELINE_STALE_MIN_THRESHOLD = prev;
    }
});

test('pipelineSlice no marca stale si el ageMin máximo está bajo el umbral', () => {
    const prev = process.env.PIPELINE_STALE_MIN_THRESHOLD;
    process.env.PIPELINE_STALE_MIN_THRESHOLD = '30';
    try {
        const state = {
            config: baseConfig,
            bloqueados: [],
            allFases: [],
            issueMatrix: {
                '2898': {
                    title: 'fresh',
                    labels: [],
                    faseActual: 'desarrollo/validacion',
                    estadoActual: 'trabajando',
                    bounces: 0,
                    staleMin: 5,
                    fases: {
                        'desarrollo/validacion': [
                            makeEntry('po', 'trabajando', 5),
                            makeEntry('guru', 'pendiente', 10),
                        ],
                    },
                },
            },
        };
        const out = slices.pipelineSlice(state, { PIPELINE: '/tmp' });
        const m = out.matrix['2898'];
        assert.equal(m.stale, false);
        assert.equal(m.blockerSkill, null);
    } finally {
        if (prev === undefined) delete process.env.PIPELINE_STALE_MIN_THRESHOLD;
        else process.env.PIPELINE_STALE_MIN_THRESHOLD = prev;
    }
});

test('pipelineSlice expone staleThresholdMin desde env', () => {
    const prev = process.env.PIPELINE_STALE_MIN_THRESHOLD;
    process.env.PIPELINE_STALE_MIN_THRESHOLD = '15';
    try {
        const state = { config: baseConfig, bloqueados: [], allFases: [], issueMatrix: {} };
        const out = slices.pipelineSlice(state, { PIPELINE: '/tmp' });
        assert.equal(out.staleThresholdMin, 15);
    } finally {
        if (prev === undefined) delete process.env.PIPELINE_STALE_MIN_THRESHOLD;
        else process.env.PIPELINE_STALE_MIN_THRESHOLD = prev;
    }
});

test('pipelineSlice "no aplica = no mostrar" (skill no presente y no esperado se omite)', () => {
    // En verificacion los esperados son [tester, security, qa]. Si solo
    // hay marker para `tester`, el resto se muestra (porque hay markers
    // = preferimos lo presente). Pero `qa` que no tiene marker ni en la
    // lista cuando hay otros = NO debe inflar la card.
    // Caso: solo `tester` tiene marker → expectedSkills = [tester].
    const state = {
        config: baseConfig,
        bloqueados: [],
        allFases: [],
        issueMatrix: {
            '2899': {
                title: 'partial verif',
                labels: [],
                faseActual: 'desarrollo/verificacion',
                estadoActual: 'trabajando',
                bounces: 0,
                staleMin: 0,
                fases: {
                    'desarrollo/verificacion': [
                        makeEntry('tester', 'trabajando', 3),
                    ],
                },
            },
        },
    };
    const out = slices.pipelineSlice(state, { PIPELINE: '/tmp' });
    const skills = out.matrix['2899'].agents.map(a => a.skill);
    assert.deepEqual(skills, ['tester'], 'solo el skill con marker se muestra');
});

test('pipelineSlice fase sin markers todavía muestra todos los esperados como pendientes', () => {
    // Caso edge: issue recién encolado, sin markers aún en la fase activa.
    // Mostrar todos los configurados como pendientes para que el operador
    // sepa qué falta arrancar.
    const state = {
        config: baseConfig,
        bloqueados: [],
        allFases: [],
        issueMatrix: {
            '2900': {
                title: 'recién encolado',
                labels: [],
                faseActual: 'desarrollo/verificacion',
                estadoActual: 'pendiente',
                bounces: 0,
                staleMin: 0,
                fases: { 'desarrollo/verificacion': [] },
            },
        },
    };
    const out = slices.pipelineSlice(state, { PIPELINE: '/tmp' });
    const skills = out.matrix['2900'].agents.map(a => a.skill).sort();
    assert.deepEqual(skills, ['qa', 'security', 'tester'].sort());
    for (const a of out.matrix['2900'].agents) {
        assert.equal(a.estado, 'pendiente');
    }
});
