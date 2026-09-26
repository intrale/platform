// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Tests estructurales de la poda del CI de #7660 (filas 2, 5, 6 y 8 de la
 * tabla de decisión de #7658, `docs/pipeline/evaluacion-ci-platform.md` §2).
 *
 *   - Fila 5: los 4 lints de `.pipeline/**` se consolidan en
 *     `.github/workflows/pipeline-lints.yml` (un workflow, un job). Estos tests
 *     fijan que la consolidación NO pierde detección: los mismos comandos
 *     `--check`, los mismos unit tests, el mismo alcance de `paths`, y ningún
 *     step puede ocultar el rojo de otro.
 *   - Fila 6: `runtime-state-guard.yml` se elimina (el gate de delivery se
 *     reapunta en `security-blocking-checks.js`; lo ancla su propia suite).
 *   - Fila 2: el Admission Gate se saltea para issues que ya nacen admitidos.
 *   - Fila 8: la distribución Desktop pasa a demanda (sólo workflow_dispatch).
 *
 * Parsean el YAML con js-yaml (no match de texto) para que un refactor del
 * workflow no pierda las garantías en silencio.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const WORKFLOWS_DIR = path.join(__dirname, '..', '..', '.github', 'workflows');

function cargar(nombre) {
    const doc = yaml.load(fs.readFileSync(path.join(WORKFLOWS_DIR, nombre), 'utf8'));
    assert.ok(doc && typeof doc === 'object', `${nombre} no parsea como objeto YAML`);
    return doc;
}

// ── Fila 5: consolidación de los lints de .pipeline ─────────────────────────

// Comandos EXACTOS que corrían los 4 workflows previos (verificados contra
// origin/main antes de borrarlos, 26/09). La consolidación tiene que
// conservarlos todos, sin agregar `--only` ni cambiar el modo.
const COMANDOS_PREVIOS = [
    'node lib/operational-state-lint.js --check',
    'node lib/operational-state-lint.js --report >> "$GITHUB_STEP_SUMMARY"',
    'node --test lib/__tests__/operational-state-lint.test.js',
    'node lib/ghost-artifact-lint.js --check',
    'node --test lib/__tests__/ghost-artifact-cleaner.test.js lib/__tests__/ghost-artifact-lint.test.js lib/__tests__/marker-artifact.test.js',
    'node lib/test-env-lint.js --check',
    'node --test lib/__tests__/test-env-lint.test.js lib/__tests__/with-env.test.js',
    'node lib/write-target-lint.js --check',
    'node --test lib/__tests__/write-target-lint.test.js lib/__tests__/write-points.test.js',
];

const WORKFLOWS_CONSOLIDADOS = [
    'ghost-artifact-lint.yml',
    'operational-state-lint.yml',
    'test-env-lint.yml',
    'write-target-lint.yml',
];

function jobUnico(doc) {
    const keys = Object.keys(doc.jobs || {});
    assert.deepEqual(keys, ['pipeline-lints'], 'un solo job: el ahorro de la fila 5 es por redondeo por job');
    return doc.jobs['pipeline-lints'];
}

test('fila 5 · los 4 workflows de lints de .pipeline ya no existen: los reemplaza pipeline-lints.yml', () => {
    for (const viejo of WORKFLOWS_CONSOLIDADOS) {
        assert.equal(fs.existsSync(path.join(WORKFLOWS_DIR, viejo)), false, `${viejo} debería haberse consolidado`);
    }
    assert.ok(fs.existsSync(path.join(WORKFLOWS_DIR, 'pipeline-lints.yml')));
});

test('fila 5 · el job consolidado corre exactamente los mismos comandos que los 4 workflows previos', () => {
    const job = jobUnico(cargar('pipeline-lints.yml'));
    const runs = job.steps.filter(s => typeof s.run === 'string').map(s => s.run.trim());
    for (const cmd of COMANDOS_PREVIOS) {
        assert.ok(runs.includes(cmd), `falta el comando: ${cmd}`);
    }
    // Ningún lint pierde el modo enforce ni se filtra por archivos.
    assert.ok(!runs.some(r => /--report-only|--only/.test(r)), 'sin --report-only ni --only');
    assert.ok(!runs.some(r => /\|\|\s*true/.test(r)), 'sin || true: anula el rojo');
});

test('fila 5 · un step por lint, y todo lo posterior al setup corre aunque falle otro (if: always())', () => {
    const job = jobUnico(cargar('pipeline-lints.yml'));
    const lints = job.steps.filter(s => typeof s.run === 'string' && /^node /.test(s.run.trim()));
    assert.equal(lints.length, COMANDOS_PREVIOS.length, 'un step por comando');
    for (const s of lints) {
        assert.ok(typeof s.name === 'string' && s.name.length > 0, 'cada step lleva nombre (UX-1)');
        assert.equal(s.if, 'always()', `"${s.name}" tiene que correr aunque falle un lint anterior`);
        assert.equal(s['working-directory'], '.pipeline', `"${s.name}" corre desde .pipeline como antes`);
    }
    for (const nombre of ['operational-state-lint', 'ghost-artifact-lint', 'test-env-lint', 'write-target-lint']) {
        assert.ok(lints.some(s => s.name.startsWith(nombre)), `hay un step con el nombre de ${nombre}`);
    }
});

test('fila 5 · ningún continue-on-error: anularía el rojo del job', () => {
    const doc = cargar('pipeline-lints.yml');
    const job = jobUnico(doc);
    assert.equal(job['continue-on-error'], undefined);
    for (const s of job.steps) assert.equal(s['continue-on-error'], undefined, `step "${s.name}"`);
});

test('fila 5 · permisos mínimos: contents read a nivel workflow y ningún write (#5192)', () => {
    const doc = cargar('pipeline-lints.yml');
    assert.deepEqual(doc.permissions, { contents: 'read' });
    const job = jobUnico(doc);
    assert.equal(job.permissions, undefined, 'el job no reabre scopes');
});

test('fila 5 · trigger pull_request (nunca pull_request_target) y push a main', () => {
    const doc = cargar('pipeline-lints.yml');
    assert.ok(doc.on.pull_request, 'pull_request');
    assert.equal(doc.on.pull_request_target, undefined, 'pull_request_target corre con el token base sobre código del PR');
    assert.deepEqual(doc.on.pull_request.branches, ['main', 'develop']);
    assert.deepEqual(doc.on.push.branches, ['main']);
});

test('fila 5 · mismo alcance que antes: .pipeline/** y .github/CODEOWNERS en PR y en push', () => {
    const doc = cargar('pipeline-lints.yml');
    for (const ev of ['pull_request', 'push']) {
        const paths = doc.on[ev].paths;
        assert.ok(paths.includes('.pipeline/**'), `${ev}: .pipeline/**`);
        assert.ok(paths.includes('.github/CODEOWNERS'), `${ev}: .github/CODEOWNERS (#5986)`);
    }
    assert.ok(doc.on.pull_request.paths.includes('.github/workflows/pipeline-lints.yml'), 'un cambio al propio workflow lo dispara');
});

test('fila 5 · todas las actions pineadas por SHA de 40 hex', () => {
    const job = jobUnico(cargar('pipeline-lints.yml'));
    const uses = job.steps.filter(s => s.uses).map(s => s.uses);
    assert.ok(uses.length >= 2);
    for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, u);
});

test('fila 5 · npm ci --ignore-scripts desde la raíz, antes de cualquier lint', () => {
    const job = jobUnico(cargar('pipeline-lints.yml'));
    const idxInstall = job.steps.findIndex(s => s.run === 'npm ci --ignore-scripts');
    const idxPrimerLint = job.steps.findIndex(s => typeof s.run === 'string' && /^node /.test(s.run));
    assert.ok(idxInstall >= 0, 'instala las dependencias raíz (js-yaml)');
    assert.ok(idxInstall < idxPrimerLint, 'antes del primer lint');
    assert.equal(job.steps[idxInstall]['working-directory'], undefined, 'desde la raíz');
    const setup = job.steps.find(s => typeof s.uses === 'string' && s.uses.startsWith('actions/setup-node@'));
    assert.equal(setup.with['node-version'], '20');
});

test('fila 5 · concurrency cancela sólo corridas de PR, nunca las de push a main', () => {
    const doc = cargar('pipeline-lints.yml');
    assert.ok(doc.concurrency, 'declara concurrency');
    assert.match(doc.concurrency.group, /github\.event_name/, 'el grupo separa eventos');
    assert.match(doc.concurrency.group, /github\.event\.pull_request\.number/, 'el grupo es por PR');
    assert.notEqual(doc.concurrency['cancel-in-progress'], true, 'nunca `true` literal');
    assert.match(String(doc.concurrency['cancel-in-progress']), /github\.event_name == 'pull_request'/);
});

// ── Fila 6: eliminación de Runtime state guard ──────────────────────────────

test('fila 6 · runtime-state-guard.yml ya no existe', () => {
    assert.equal(fs.existsSync(path.join(WORKFLOWS_DIR, 'runtime-state-guard.yml')), false);
});

// ── Fila 2: Admission Gate salteado para issues ya admitidos ────────────────

/**
 * Evalúa la expresión `if:` del job como lo haría Actions, para los únicos
 * operadores que usa (==, !=, &&, ||, !, contains sobre labels). `contains`
 * de Actions no distingue mayúsculas: se replica.
 */
function evaluarIf(expr, ctx) {
    const js = expr
        .replace(/contains\(github\.event\.issue\.labels\.\*\.name,\s*'([^']+)'\)/g,
            (_, l) => `ctx.labels.some(x => x.toLowerCase() === ${JSON.stringify(l.toLowerCase())})`)
        .replace(/github\.event\.sender\.type/g, 'ctx.senderType')
        .replace(/github\.event_name/g, 'ctx.eventName')
        .replace(/github\.actor/g, 'ctx.actor');
    assert.doesNotMatch(js, /github\./, `la expresión usa un contexto que el test no modela: ${js}`);
    // eslint-disable-next-line no-new-func
    return Boolean(new Function('ctx', `return (${js});`)(ctx));
}

function ifDelGate() {
    const job = cargar('admission-gate.yml').jobs['apply-admission-label'];
    assert.equal(typeof job.if, 'string');
    return job.if;
}

const base = { senderType: 'User', actor: 'leitolarreta' };

test('fila 2 · un issue que nace con needs-definition o Ready saltea el gate', () => {
    const expr = ifDelGate();
    assert.equal(evaluarIf(expr, { ...base, eventName: 'issues', labels: ['needs-definition'] }), false);
    assert.equal(evaluarIf(expr, { ...base, eventName: 'issues', labels: ['Ready', 'area:infra'] }), false);
});

test('fila 2 · un issue sin label de admisión sigue pasando por el gate', () => {
    const expr = ifDelGate();
    assert.equal(evaluarIf(expr, { ...base, eventName: 'issues', labels: [] }), true);
    assert.equal(evaluarIf(expr, { ...base, eventName: 'issues', labels: ['bug', 'area:pipeline'] }), true);
});

test('fila 2 · los PRs no cambian: pull_request_target corre siempre, aun con label', () => {
    const expr = ifDelGate();
    assert.equal(evaluarIf(expr, { ...base, eventName: 'pull_request_target', labels: [] }), true);
    assert.equal(evaluarIf(expr, { ...base, eventName: 'pull_request_target', labels: ['Ready'] }), true);
});

test('fila 2 · se conserva la defensa anti-bot original', () => {
    const expr = ifDelGate();
    assert.equal(
        evaluarIf(expr, { senderType: 'Bot', actor: 'github-actions[bot]', eventName: 'issues', labels: [] }),
        false,
    );
});

test('fila 2 · los labels del filtro son los mismos que ADMISSION_LABELS del módulo', () => {
    const { ADMISSION_LABELS } = require('../lib/admission-gate');
    const expr = ifDelGate();
    const enFiltro = [...expr.matchAll(/labels\.\*\.name,\s*'([^']+)'\)/g)].map(m => m[1]).sort();
    assert.deepEqual(enFiltro, [...ADMISSION_LABELS].sort());
});

test('fila 2 · el Admission Gate mantiene disparadores y permisos', () => {
    const doc = cargar('admission-gate.yml');
    assert.deepEqual(doc.on.issues.types, ['opened']);
    assert.deepEqual(doc.on.pull_request_target.types, ['opened']);
    assert.deepEqual(doc.permissions, { issues: 'write', 'pull-requests': 'write', contents: 'read' });
});

// ── Fila 8: Distribución Desktop a demanda ──────────────────────────────────

test('fila 8 · la distribución Desktop sólo se dispara a mano (workflow_dispatch)', () => {
    const doc = cargar('distribute-desktop.yml');
    assert.deepEqual(Object.keys(doc.on), ['workflow_dispatch']);
    assert.ok(doc.on.workflow_dispatch.inputs.release_notes, 'conserva el input de notas de release');
});
