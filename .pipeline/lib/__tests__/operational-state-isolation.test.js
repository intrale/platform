// =============================================================================
// operational-state-isolation.test.js — CA principal de #5110 (Ola 9.4 · E2).
//
// Escenario Gherkin cubierto:
//
//   Escenario: dos proyectos con olas simultaneas no se pisan
//     Dado dos proyectos activos con su propio registro de olas
//     Cuando ambos avanzan issues al mismo tiempo
//     Entonces cada uno ve exclusivamente su propio avance
//     Y la allowlist de uno no habilita trabajo del otro
//
// R7 · el sistema real tiene UN solo descriptor, así que el aislamiento no es
// observable contra producción. El fixture monta dos proyectos con
// `PIPELINE_DIR_OVERRIDE` (raíz física compartida) + binding de spawn por
// proyecto — que es exactamente la mecánica que usa el pulpo.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/operational-state-isolation.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { seedPipelineConfig } = require('./_test-helpers');

const SUBSTRATE = ['../operational-state', '../waves', '../partial-pause', '../partial-pause-audit', '../project-context'];

const ALPHA = 'proj-alpha';
const BETA = 'proj-beta';

function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opstate-iso-'));
    seedPipelineConfig(dir);
    fs.mkdirSync(path.join(dir, 'descriptors'), { recursive: true });
    for (const id of [ALPHA, BETA]) {
        fs.writeFileSync(path.join(dir, 'descriptors', `${id}.json`), JSON.stringify({ identity: { projectId: id } }));
    }
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    process.env.PIPELINE_OPSTATE_NAMESPACED = '1';
    return dir;
}

function teardown(dir) {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    delete process.env.PIPELINE_OPSTATE_NAMESPACED;
    delete process.env.PIPELINE_PROJECT_ID;
    delete process.env.PIPELINE_PROJECT_BINDING;
    delete process.env.PIPELINE_ALLOW_UNSCOPED_DISPATCH;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
}

/**
 * Entra al contexto de `projectId` como lo haría un agente spawneado por el
 * pulpo: binding en disco + par de env vars, y module cache limpio para que el
 * sustrato re-resuelva sus paths.
 *
 * @returns la fachada `operational-state` ya apuntando al namespace del proyecto.
 */
function enterProject(projectId) {
    for (const m of SUBSTRATE) delete require.cache[require.resolve(m)];
    const pc = require('../project-context');
    pc._resetForTests();
    const nonce = `n-${projectId}`;
    pc.writeSpawnBinding({ projectId, nonce });
    process.env.PIPELINE_PROJECT_ID = projectId;
    process.env.PIPELINE_PROJECT_BINDING = nonce;
    const opState = require('../operational-state');
    opState._internal.invalidateCache();
    return opState;
}

function sampleState(waveName, issues) {
    return {
        version: '1.0',
        meta: {
            created_at: '2026-08-01T00:00:00.000Z',
            updated_at: '2026-08-01T00:00:00.000Z',
            updated_by: 'test',
            source: 'manual',
            note: 'fixture aislamiento',
            next_wave_number: 2,
        },
        active_wave: {
            number: 1,
            name: waveName,
            goal: 'aislamiento',
            started_at: '2026-08-01T00:00:00.000Z',
            issues: issues.map((n) => ({ number: n, status: 'pending' })),
        },
        planned_waves: [],
        archived_waves: [],
    };
}

/** Siembra el registro de olas DENTRO del namespace del proyecto. */
function seedWaves(dir, projectId, state) {
    const stateDir = path.join(dir, 'projects', projectId);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'waves.json'), JSON.stringify(state, null, 2));
}

const AUTH = { authorizedBy: 'test', justification: 'fixture del test de aislamiento #5110' };

// ─── CA: registros de olas independientes ───────────────────────────────────

test('CA · cada proyecto resuelve su propio waves.json bajo projects/<id>/', () => {
    const dir = setup();
    try {
        const a = enterProject(ALPHA);
        const pathsA = a._internal.paths();
        const b = enterProject(BETA);
        const pathsB = b._internal.paths();

        assert.notEqual(pathsA.WAVES_FILE, pathsB.WAVES_FILE);
        assert.ok(pathsA.WAVES_FILE.includes(ALPHA), `esperaba ${ALPHA} en ${pathsA.WAVES_FILE}`);
        assert.ok(pathsB.WAVES_FILE.includes(BETA), `esperaba ${BETA} en ${pathsB.WAVES_FILE}`);
        assert.equal(pathsA.PROJECT_ID, ALPHA);
        assert.equal(pathsB.PROJECT_ID, BETA);
    } finally { teardown(dir); }
});

test('CA · dos proyectos con olas propias: cada uno ve exclusivamente la suya', () => {
    const dir = setup();
    try {
        seedWaves(dir, ALPHA, sampleState('Ola de Alpha', [101, 102]));
        seedWaves(dir, BETA, sampleState('Ola de Beta', [201, 202]));

        const a = enterProject(ALPHA);
        const waveA = a.getActiveWave();
        assert.equal(waveA.name, 'Ola de Alpha');
        assert.deepEqual(waveA.issues.map((i) => i.number).sort(), [101, 102]);

        const b = enterProject(BETA);
        const waveB = b.getActiveWave();
        assert.equal(waveB.name, 'Ola de Beta');
        assert.deepEqual(waveB.issues.map((i) => i.number).sort(), [201, 202]);
        // Ni un issue del vecino se filtró.
        assert.ok(!waveB.issues.some((i) => [101, 102].includes(i.number)));
    } finally { teardown(dir); }
});

test('CA · A avanza un issue y B NO ve el cambio', () => {
    const dir = setup();
    try {
        seedWaves(dir, ALPHA, sampleState('Ola de Alpha', [101, 102]));
        seedWaves(dir, BETA, sampleState('Ola de Beta', [201, 202]));

        // A marca 101 como completado.
        const a = enterProject(ALPHA);
        a.markIssuesCompletedInActiveWave([101], { ...AUTH, updated_by: 'test' });
        const afterA = a.getActiveWave();
        assert.equal(afterA.issues.find((i) => i.number === 101).status, 'completed');

        // B relee: su ola sigue intacta, sin rastro del avance de A.
        const b = enterProject(BETA);
        const waveB = b.getActiveWave();
        assert.equal(waveB.name, 'Ola de Beta');
        assert.ok(waveB.issues.every((i) => i.status === 'pending'), 'B no debe ver avance ajeno');

        // Y A sigue viendo lo suyo tras el ida y vuelta (no lo pisó B).
        const a2 = enterProject(ALPHA);
        assert.equal(a2.getActiveWave().issues.find((i) => i.number === 101).status, 'completed');
    } finally { teardown(dir); }
});

test('CA · escrituras alternadas no se pisan: cada archivo conserva lo suyo', () => {
    const dir = setup();
    try {
        seedWaves(dir, ALPHA, sampleState('Ola de Alpha', [101]));
        seedWaves(dir, BETA, sampleState('Ola de Beta', [201]));

        // Interleaving A → B → A → B, que es el patrón que rompía el layout plano.
        enterProject(ALPHA).addIssueToWave(1, { number: 103 }, { ...AUTH, updated_by: 'a1' });
        enterProject(BETA).addIssueToWave(1, { number: 203 }, { ...AUTH, updated_by: 'b1' });
        enterProject(ALPHA).addIssueToWave(1, { number: 104 }, { ...AUTH, updated_by: 'a2' });
        enterProject(BETA).addIssueToWave(1, { number: 204 }, { ...AUTH, updated_by: 'b2' });

        const finalA = enterProject(ALPHA).getActiveWave().issues.map((i) => i.number).sort((x, y) => x - y);
        const finalB = enterProject(BETA).getActiveWave().issues.map((i) => i.number).sort((x, y) => x - y);

        assert.deepEqual(finalA, [101, 103, 104]);
        assert.deepEqual(finalB, [201, 203, 204]);
    } finally { teardown(dir); }
});

// ─── CA: la allowlist de uno no habilita trabajo del otro ───────────────────

test('CA · la allowlist de A no habilita issues de B', () => {
    const dir = setup();
    try {
        seedWaves(dir, ALPHA, sampleState('Ola de Alpha', [101, 102]));
        seedWaves(dir, BETA, sampleState('Ola de Beta', [201, 202]));

        const a = enterProject(ALPHA);
        a.setAllowlist([101], { ...AUTH, justification: 'habilitar 101 sólo en alpha' });
        assert.equal(a.isIssueAllowed(101), true);
        assert.equal(a.isIssueAllowed(201), false, 'A no debe habilitar un issue de B');

        const b = enterProject(BETA);
        // La allowlist de B es independiente: 101 NO está habilitado acá.
        assert.equal(b.isIssueAllowed(101), false, 'la allowlist de A no puede filtrarse a B');

        b.setAllowlist([201], { ...AUTH, justification: 'habilitar 201 sólo en beta' });
        assert.equal(b.isIssueAllowed(201), true);
        assert.equal(b.isIssueAllowed(101), false);

        // Y A no se contaminó con la escritura de B.
        const a2 = enterProject(ALPHA);
        assert.equal(a2.isIssueAllowed(101), true);
        assert.equal(a2.isIssueAllowed(201), false);
    } finally { teardown(dir); }
});

test('CA · los archivos de allowlist son físicamente distintos', () => {
    const dir = setup();
    try {
        const pA = enterProject(ALPHA)._internal.paths().PARTIAL_FILE;
        const pB = enterProject(BETA)._internal.paths().PARTIAL_FILE;
        assert.notEqual(pA, pB);
        assert.ok(pA.includes(ALPHA));
        assert.ok(pB.includes(BETA));
    } finally { teardown(dir); }
});

// ─── SEC-5 · el audit trail también está particionado ───────────────────────

test('SEC-5 · cada mutación se audita en el namespace de su proyecto, con projectId', () => {
    const dir = setup();
    try {
        seedWaves(dir, ALPHA, sampleState('Ola de Alpha', [101]));
        seedWaves(dir, BETA, sampleState('Ola de Beta', [201]));

        enterProject(ALPHA).setAllowlist([101], { ...AUTH, justification: 'mutacion de alpha para el audit' });
        enterProject(BETA).setAllowlist([201], { ...AUTH, justification: 'mutacion de beta para el audit' });

        const readAudit = (id) => {
            const f = path.join(dir, 'projects', id, 'audit', 'partial-pause-mutations.jsonl');
            assert.ok(fs.existsSync(f), `falta el audit de ${id}: ${f}`);
            return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        };

        const auditA = readAudit(ALPHA);
        const auditB = readAudit(BETA);

        // Cada entry declara su proyecto, y ninguna cadena tiene entries ajenas.
        assert.ok(auditA.length > 0 && auditB.length > 0);
        assert.ok(auditA.every((e) => e.projectId === ALPHA), 'el audit de A sólo tiene entries de A');
        assert.ok(auditB.every((e) => e.projectId === BETA), 'el audit de B sólo tiene entries de B');

        // Y ningún proyecto no-host hereda el backfill del incidente del host:
        // arrancar la cadena de hashes de un proyecto nuevo con un incidente que
        // nunca le pasó sería falsificar su historia.
        assert.ok(!auditA.some((e) => e._backfill), 'A no debe heredar el backfill del host');
        assert.ok(!auditB.some((e) => e._backfill), 'B no debe heredar el backfill del host');
    } finally { teardown(dir); }
});

test('SEC-5 · el projectId del audit NO se puede falsificar por `extra`', () => {
    const dir = setup();
    try {
        for (const m of SUBSTRATE) delete require.cache[require.resolve(m)];
        require('../project-context')._resetForTests();
        const pc = require('../project-context');
        pc.writeSpawnBinding({ projectId: ALPHA, nonce: 'n-forge' });
        process.env.PIPELINE_PROJECT_ID = ALPHA;
        process.env.PIPELINE_PROJECT_BINDING = 'n-forge';

        const audit = require('../partial-pause-audit');
        audit.appendMutation({
            source: 'test',
            action: 'write',
            previous: [],
            current: [1],
            authorizedBy: 'test',
            justification: 'intento de firmar la mutacion como otro proyecto',
            // El ataque: pasar el projectId del vecino por la puerta de atrás.
            extra: { projectId: BETA },
        });

        const f = path.join(dir, 'projects', ALPHA, 'audit', 'partial-pause-mutations.jsonl');
        const entries = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        const last = entries[entries.length - 1];
        assert.equal(last.projectId, ALPHA, 'el projectId sale del contexto, nunca del argumento');
    } finally { teardown(dir); }
});

// ─── Fail-closed en el sustrato ─────────────────────────────────────────────

test('con namespaceo ON y ≥2 proyectos sin contexto, el sustrato falla cerrado', () => {
    const dir = setup();
    try {
        for (const m of SUBSTRATE) delete require.cache[require.resolve(m)];
        require('../project-context')._resetForTests();
        // Sin binding ni env: el contexto es ambiguo entre alpha y beta.
        delete process.env.PIPELINE_PROJECT_ID;
        delete process.env.PIPELINE_PROJECT_BINDING;

        const waves = require('../waves');
        assert.throws(() => waves._paths().WAVES_FILE, (err) => {
            assert.equal(err.code, 'EOPSTATE_NO_PROJECT_CONTEXT');
            return true;
        }, 'no debe elegir un proyecto por convención');
    } finally { teardown(dir); }
});
