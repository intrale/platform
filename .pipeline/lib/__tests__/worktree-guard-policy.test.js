// =============================================================================
// Tests worktree-guard-policy.js — política pura del guard de worktree (#5421).
//
// Cobertura de CA:
//   CA-1: `branch-origin-unverified` NO es elegible.
//   CA-2: `worktree-path-exists` y `worktree-path-exists-without-git-entry` SÍ,
//         con y sin sufijo `:<detalle>`.
//   CA-3: `fetch-failed` elegible SÓLO con `branchOriginVerified:true`.
//   CA-4: motivo desconocido NO elegible (default cerrado).
//   CA-6: el log nombra la operación intentada y la acción que destraba.
//   CA-7: `stderr` de gh/git con path absoluto sale redactado.
//   CA-8: wording por causa real (email vs "rama ajena").
//   CA-9: línea de skills afectados.
//   D3:   `operation` NO altera el veredicto.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    guardExceptionEligible,
    resolveOperation,
    buildAbortLogLine,
    buildOperatorQuestion,
    buildAffectedSkillsLine,
    normalizarMotivo,
    OPERATIONS,
} = require('../worktree-guard-policy');

// ---- normalizarMotivo --------------------------------------------------------

test('normalizarMotivo — corta en el PRIMER `:` (el detalle puede ser un path Windows con su propio `:`)', () => {
    assert.equal(
        normalizarMotivo('worktree-path-exists-without-git-entry:C:\\Workspaces\\Intrale\\platform.agent-1123-po'),
        'worktree-path-exists-without-git-entry',
    );
});

test('normalizarMotivo — sin sufijo devuelve el motivo tal cual', () => {
    assert.equal(normalizarMotivo('fetch-failed'), 'fetch-failed');
});

test('normalizarMotivo — null/undefined/vacío → string vacío (no explota)', () => {
    assert.equal(normalizarMotivo(null), '');
    assert.equal(normalizarMotivo(undefined), '');
    assert.equal(normalizarMotivo('   '), '');
});

// ---- CA-1: branch-origin-unverified nunca elegible ---------------------------

test('CA-1 — `branch-origin-unverified` NO es elegible (falla de confianza, no de copia)', () => {
    const r = guardExceptionEligible('branch-origin-unverified:agent/1123-*', {
        operation: OPERATIONS.SPAWN_AGENTE,
        branchOriginVerified: false,
    });
    assert.equal(r.eligible, false);
    assert.equal(r.motivoNormalizado, 'branch-origin-unverified');
});

test('CA-1 — `branch-origin-unverified` sigue NO elegible aunque llegue branchOriginVerified:true', () => {
    // Combinación imposible en la práctica; el test fija que la allowlist manda
    // sobre el flag, no al revés.
    const r = guardExceptionEligible('branch-origin-unverified:agent/1123-*', { branchOriginVerified: true });
    assert.equal(r.eligible, false);
});

test('CA-1 — la exclusión es por igualdad EXACTA: un motivo nuevo con el mismo prefijo tampoco cuela', () => {
    // La regex vieja (`/^branch-origin-unverified/`) habría matcheado esto por
    // prefijo sin que nadie lo revisara. Acá cae al default cerrado.
    const r = guardExceptionEligible('branch-origin-unverified-foo:detalle', { branchOriginVerified: true });
    assert.equal(r.eligible, false);
    assert.equal(r.motivoNormalizado, 'branch-origin-unverified-foo');
});

test('CA-1 — `invalid-input` y `remote-branch-missing` tampoco son elegibles', () => {
    assert.equal(guardExceptionEligible('invalid-input:INVALID_ISSUE', {}).eligible, false);
    assert.equal(guardExceptionEligible('remote-branch-missing:agent/1123-*', {}).eligible, false);
});

// ---- CA-2: worktree-path-exists* elegibles -----------------------------------

test('CA-2 — `worktree-path-exists` es elegible, con y sin sufijo', () => {
    assert.equal(guardExceptionEligible('worktree-path-exists', {}).eligible, true);
    assert.equal(
        guardExceptionEligible('worktree-path-exists:C:\\Workspaces\\Intrale\\platform.agent-1123-po', {}).eligible,
        true,
    );
});

test('CA-2 — `worktree-path-exists-without-git-entry` es elegible, con y sin sufijo', () => {
    assert.equal(guardExceptionEligible('worktree-path-exists-without-git-entry', {}).eligible, true);
    assert.equal(
        guardExceptionEligible(
            'worktree-path-exists-without-git-entry:C:\\Workspaces\\Intrale\\platform.agent-1123-po',
            {},
        ).eligible,
        true,
    );
});

test('CA-2 — los path-exists son elegibles sin depender de branchOriginVerified', () => {
    // Se llega a estos motivos sólo con la rama remota ya verificada, así que
    // el flag no debe poder degradar el veredicto.
    for (const v of [true, false, null, undefined]) {
        assert.equal(
            guardExceptionEligible('worktree-path-exists-without-git-entry:/tmp/x', { branchOriginVerified: v }).eligible,
            true,
            `branchOriginVerified=${String(v)}`,
        );
    }
});

// ---- CA-3: transitorios sólo con procedencia verificada ----------------------

test('CA-3 — `fetch-failed` es elegible SÓLO con branchOriginVerified:true', () => {
    assert.equal(guardExceptionEligible('fetch-failed:timeout', { branchOriginVerified: true }).eligible, true);
    assert.equal(guardExceptionEligible('fetch-failed:timeout', { branchOriginVerified: false }).eligible, false);
    assert.equal(guardExceptionEligible('fetch-failed:timeout', { branchOriginVerified: null }).eligible, false);
    assert.equal(guardExceptionEligible('fetch-failed:timeout', {}).eligible, false);
});

test('CA-3 — `ls-remote-failed` sigue la misma regla que `fetch-failed`', () => {
    assert.equal(guardExceptionEligible('ls-remote-failed:ETIMEDOUT', { branchOriginVerified: true }).eligible, true);
    assert.equal(guardExceptionEligible('ls-remote-failed:ETIMEDOUT', { branchOriginVerified: false }).eligible, false);
    assert.equal(guardExceptionEligible('ls-remote-failed:ETIMEDOUT', { branchOriginVerified: null }).eligible, false);
});

test('CA-3 — un `branchOriginVerified` truthy pero no booleano NO alcanza (comparación estricta)', () => {
    assert.equal(guardExceptionEligible('fetch-failed', { branchOriginVerified: 'true' }).eligible, false);
    assert.equal(guardExceptionEligible('fetch-failed', { branchOriginVerified: 1 }).eligible, false);
});

// ---- CA-4: default cerrado ---------------------------------------------------

test('CA-4 — motivo desconocido NO es elegible (default cerrado)', () => {
    const r = guardExceptionEligible('motivo-que-nadie-vio-nunca:detalle', { branchOriginVerified: true });
    assert.equal(r.eligible, false);
    assert.match(r.causa, /no reconocido/i);
});

test('CA-4 — motivo vacío / nulo NO es elegible', () => {
    assert.equal(guardExceptionEligible('', {}).eligible, false);
    assert.equal(guardExceptionEligible(null, {}).eligible, false);
    assert.equal(guardExceptionEligible(undefined, {}).eligible, false);
});

test('CA-4 — `worktree-add-failed` (transitorio real del resolver) no está en la allowlist', () => {
    assert.equal(guardExceptionEligible('worktree-add-failed:fatal', { branchOriginVerified: true }).eligible, false);
});

// ---- D3: operation es metadato, no decisión ----------------------------------

test('D3 — el mismo motivo con `operation` distinta da el mismo veredicto', () => {
    const motivos = [
        'worktree-path-exists-without-git-entry:/tmp/x',
        'branch-origin-unverified:agent/1-*',
        'fetch-failed:x',
        'desconocido:x',
    ];
    for (const m of motivos) {
        const veredictos = Object.values(OPERATIONS).map(
            (op) => guardExceptionEligible(m, { operation: op, branchOriginVerified: true }).eligible,
        );
        assert.equal(new Set(veredictos).size, 1, `motivo ${m} cambió de veredicto según operation`);
    }
});

// ---- resolveOperation --------------------------------------------------------

test('resolveOperation — fase `entrega` → merge server-side', () => {
    assert.equal(resolveOperation({ fase: 'entrega', skill: 'delivery' }), OPERATIONS.MERGE_SERVER_SIDE);
    assert.equal(resolveOperation({ fase: 'entrega', skill: 'otro' }), OPERATIONS.MERGE_SERVER_SIDE);
});

test('resolveOperation — skill `delivery` en otra fase también es merge server-side', () => {
    assert.equal(resolveOperation({ fase: 'dev', skill: 'delivery' }), OPERATIONS.MERGE_SERVER_SIDE);
});

test('resolveOperation — el resto es spawn de agente', () => {
    assert.equal(resolveOperation({ fase: 'dev', skill: 'pipeline-dev' }), OPERATIONS.SPAWN_AGENTE);
    assert.equal(resolveOperation({}), OPERATIONS.SPAWN_AGENTE);
    assert.equal(resolveOperation(), OPERATIONS.SPAWN_AGENTE);
});

// ---- CA-6: log accionable ----------------------------------------------------

test('CA-6 — el log distingue el merge server-side del spawn de agente', () => {
    const merge = buildAbortLogLine({
        issue: 1123, fase: 'entrega', skill: 'delivery',
        reasonStr: 'worktree-path-exists-without-git-entry:/tmp/x',
        operation: OPERATIONS.MERGE_SERVER_SIDE,
        intentos: 1, cap: 3, eligible: true, escalar: false,
    });
    const spawn = buildAbortLogLine({
        issue: 1123, fase: 'dev', skill: 'pipeline-dev',
        reasonStr: 'worktree-path-exists-without-git-entry:/tmp/x',
        operation: OPERATIONS.SPAWN_AGENTE,
        intentos: 1, cap: 3, eligible: true, escalar: false,
    });
    assert.match(merge, /merge server-side/);
    assert.doesNotMatch(merge, /spawn de agente/);
    assert.match(spawn, /spawn de agente/);
    assert.doesNotMatch(spawn, /merge server-side/);
});

test('CA-6 / Gherkin 2 — commit/push sobre rama no verificada: el log lo nombra y no lo confunde con el merge', () => {
    const linea = buildAbortLogLine({
        issue: 1123, fase: 'entrega', skill: 'delivery',
        reasonStr: 'branch-origin-unverified:agent/1123-*',
        operation: OPERATIONS.COMMIT_PUSH,
        intentos: 1, cap: 3, eligible: false, escalar: true,
    });
    assert.match(linea, /commit\/push sobre la rama del dev/);
    assert.doesNotMatch(linea, /merge server-side/);
    // "se intentaba commitear en una rama no verificada": operación + causa.
    assert.match(linea, /no se pudo verificar la procedencia de la rama remota/);
});

test('CA-6 — el log nombra la causa en lenguaje de operador y la acción que destraba', () => {
    const linea = buildAbortLogLine({
        issue: 1123, fase: 'dev', skill: 'po',
        reasonStr: 'worktree-path-exists-without-git-entry:/tmp/x',
        operation: OPERATIONS.SPAWN_AGENTE,
        intentos: 2, cap: 3, eligible: true, escalar: false,
    });
    assert.match(linea, /Causa:/);
    assert.match(linea, /Acción que destraba:/);
    assert.match(linea, /huérfano/i);
    assert.match(linea, /intentos=2\/3/);
    assert.match(linea, /escala_humano=no/);
    assert.match(linea, /excepcion_guard=si/);
});

test('CA-6 — un motivo no elegible reporta escala_humano=si y su propia acción', () => {
    const linea = buildAbortLogLine({
        issue: 77, fase: 'dev', skill: 'po',
        reasonStr: 'branch-origin-unverified:agent/77-*',
        operation: OPERATIONS.SPAWN_AGENTE,
        intentos: 1, cap: 3, eligible: false, escalar: true,
    });
    assert.match(linea, /excepcion_guard=no/);
    assert.match(linea, /escala_humano=si/);
    assert.match(linea, /worktree_provenance\.committers/);
});

test('CA-6 — una `operation` fuera del enum cae al default en vez de viajar cruda al log', () => {
    const linea = buildAbortLogLine({
        issue: 1, fase: 'dev', skill: 'po',
        reasonStr: 'fetch-failed',
        operation: 'operacion-inventada',
        intentos: 1, cap: 3, eligible: false, escalar: true,
    });
    assert.doesNotMatch(linea, /operacion-inventada/);
    assert.match(linea, /spawn de agente/);
});

// ---- CA-7: redacción ---------------------------------------------------------

test('CA-7 — un path absoluto Windows en el reason sale redactado del log', () => {
    const linea = buildAbortLogLine({
        issue: 1123, fase: 'dev', skill: 'po',
        reasonStr: 'worktree-path-exists-without-git-entry:D:\\Secretos\\Intrale\\platform.agent-1123-po',
        operation: OPERATIONS.SPAWN_AGENTE,
        intentos: 1, cap: 3, eligible: true, escalar: false,
    });
    assert.doesNotMatch(linea, /D:\\Secretos/);
    assert.match(linea, /<ABS_PATH>|<PIPELINE_ROOT>/);
});

test('CA-7 — el stderr de gh/git pasa por redact y queda acotado a una línea', () => {
    const linea = buildAbortLogLine({
        issue: 1123, fase: 'entrega', skill: 'delivery',
        reasonStr: 'fetch-failed:boom',
        operation: OPERATIONS.MERGE_SERVER_SIDE,
        intentos: 1, cap: 3, eligible: false, escalar: true,
        stderr: 'fatal: could not read\nfrom D:\\Secretos\\repo\nremote: https://user:hunter2@github.com/x.git',
    });
    assert.doesNotMatch(linea, /D:\\Secretos/);
    assert.doesNotMatch(linea, /hunter2/);
    assert.equal(linea.includes('\n'), false, 'el stderr multilínea debe quedar aplanado');
});

test('CA-7 — un token de Telegram en el stderr no llega al log', () => {
    const linea = buildAbortLogLine({
        issue: 1, fase: 'dev', skill: 'po',
        reasonStr: 'fetch-failed',
        operation: OPERATIONS.SPAWN_AGENTE,
        intentos: 1, cap: 3, eligible: false, escalar: true,
        stderr: 'https://api.telegram.org/bot1234567890:AAFakeTokenAAAAAAAAAAAAAAAAAAAAAAAAA/sendMessage',
    });
    assert.doesNotMatch(linea, /AAFakeToken/);
});

// ---- CA-8: wording por causa real -------------------------------------------

test('CA-8 — committer legítimo fuera de allowlist: nombra el email y NO dice "rama ajena"', () => {
    const q = buildOperatorQuestion({
        issue: 1123,
        reasonStr: 'branch-origin-unverified:agent/1123-*',
        branchOriginVerified: false,
        unverifiedAuthors: ['android-dev-agent@intrale'],
    });
    assert.match(q, /android-dev-agent@intrale/);
    assert.doesNotMatch(q, /rama ajena/i);
    assert.doesNotMatch(q, /sospechos/i);
    assert.match(q, /worktree_provenance\.committers/);
    assert.match(q, /config\.yaml/);
});

test('CA-8 — varios committers no reconocidos: los lista a todos, sigue sin "rama ajena"', () => {
    const q = buildOperatorQuestion({
        issue: 1123,
        branchOriginVerified: false,
        unverifiedAuthors: ['a@intrale', 'b@intrale'],
    });
    assert.match(q, /a@intrale/);
    assert.match(q, /b@intrale/);
    assert.doesNotMatch(q, /rama ajena/i);
});

test('CA-8 — sin committers identificados se CONSERVA el lenguaje de procedencia sospechosa', () => {
    const q = buildOperatorQuestion({
        issue: 1123,
        reasonStr: 'branch-origin-unverified:agent/1123-*',
        branchOriginVerified: false,
        unverifiedAuthors: [],
    });
    assert.match(q, /rama ajena/i);
    assert.match(q, /inspeccionar el autor/i);
});

test('CA-8 — `unverifiedAuthors` ausente o no-array cae al texto de procedencia', () => {
    for (const authors of [undefined, null, 'a@b', {}]) {
        const q = buildOperatorQuestion({ issue: 9, branchOriginVerified: false, unverifiedAuthors: authors });
        assert.match(q, /rama ajena/i, `authors=${JSON.stringify(authors)}`);
    }
});

test('CA-8 — entradas vacías/no-string en `unverifiedAuthors` no simulan un email', () => {
    const q = buildOperatorQuestion({
        issue: 9, branchOriginVerified: false, unverifiedAuthors: ['', '   ', null, 42],
    });
    assert.match(q, /rama ajena/i);
});

test('CA-8 — procedencia verificada (o desconocida) usa el texto genérico', () => {
    for (const v of [true, null, undefined]) {
        const q = buildOperatorQuestion({
            issue: 1123,
            reasonStr: 'worktree-path-exists-without-git-entry:/tmp/x',
            branchOriginVerified: v,
            unverifiedAuthors: ['a@intrale'],
        });
        assert.doesNotMatch(q, /rama ajena/i, `branchOriginVerified=${String(v)}`);
        assert.match(q, /verificar la rama del dev/i);
    }
});

test('CA-8 — el texto de operador también pasa por redact', () => {
    const q = buildOperatorQuestion({
        issue: 1,
        reasonStr: 'worktree-path-exists:D:\\Secretos\\platform.agent-1-po',
        branchOriginVerified: true,
    });
    assert.doesNotMatch(q, /D:\\Secretos/);
});

// ---- CA-9: skills afectados --------------------------------------------------

test('CA-9 — lista los skills afectados en una sola línea', () => {
    assert.equal(buildAffectedSkillsLine(['po', 'review', 'ux']), 'Skills afectados: po, review, ux');
});

test('CA-9 — deduplica y filtra basura; lista vacía → string vacío', () => {
    assert.equal(buildAffectedSkillsLine(['po', 'po', ' review ', '', null, 7]), 'Skills afectados: po, review');
    assert.equal(buildAffectedSkillsLine([]), '');
    assert.equal(buildAffectedSkillsLine(null), '');
    assert.equal(buildAffectedSkillsLine(undefined), '');
});
