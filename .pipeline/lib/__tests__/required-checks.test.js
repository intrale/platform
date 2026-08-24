// #6431 — Clasificador de checks REQUERIDOS del ruleset de la rama base.
//
// Qué defecto fija esta suite. Delivery leía el estado de los checks del
// `statusCheckRollup` del PR, y a t+4 s ese rollup viene `[]` porque GitHub
// todavía no instanció nada. Un `[]` se leía como "no pude leer" ⇒ fail-closed
// ⇒ `needs-human`. La ausencia de un check sólo se puede AFIRMAR contra la
// lista de requeridos del ruleset, y ése es el delta entero del módulo.
//
// El riesgo dominante acá NO es el fail-open: es que el fix sea un NO-OP con
// los tests en verde (A-R1). Si el cotejo de app se hiciera contra `app.id`
// (node ID opaco) en vez de `app.databaseId` (entero), `classifyRequiredChecks`
// devolvería `unusable` en el 100 % de los casos reales, `unusable` ⇒
// `gate-block` ⇒ `needs-human`, y el episodio se repetiría idéntico — con las
// fixtures a mano dando verde. Por eso hay un test de CONTRATO DE FORMA REAL
// (las claves exactas que devuelve `gh`) y un test que exige que el node ID
// NO satisfaga el requerido.
//
// Sin red: `ghImpl` se inyecta en todos los casos.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const rc = require('../required-checks');
const triggers = require('../human-block-triggers');

const {
    classifyRequiredChecks,
    fetchRequiredContexts,
    fetchRollupWithApps,
    validateBranchName,
    createRequiredChecksReader,
    REQUIRED_CHECKS_VERDICTS,
} = rc;

// App real de `pr-status` en `intrale/platform` (verificado en el rollup real:
// databaseId 15368 ×16 + 57789 `github-advanced-security` ×1).
const APP_ID = 15368;
const OTRA_APP = 57789;

const REQ = [{ context: 'pr-status', integration_id: APP_ID }];

const checkRun = (over = {}) => ({
    __typename: 'CheckRun',
    name: 'pr-status',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    checkSuite: { app: { databaseId: APP_ID, slug: 'github-actions' } },
    ...over,
});

// ── Regla 5: el caso del episodio ──────────────────────────────────────────

test('#6431 CA-2 — rollup [] con un requerido conocido da PENDING (el caso del episodio)', () => {
    // Si este test no existe, el fix no está: es la ventana ciega exacta del
    // 2026-08-24 (PR #6416, rollup vacío a t+4 s, check verde a t+19 s).
    const out = classifyRequiredChecks({ required: REQ, rollup: [], totalCount: 0 });
    assert.equal(out.verdict, 'pending');
    assert.equal(out.cause, 'checks-sin-reportar');
    assert.deepEqual(out.pending, ['pr-status']);
});

test('#6431 — rollup null NO es lo mismo que rollup []: null es unusable', () => {
    // `null` = "no leí" (snapshot degradado). Colapsarlo con `[]` haría que un
    // `gh` viejo mande todo al camino transitorio sin haber leído nada.
    const out = classifyRequiredChecks({ required: REQ, rollup: null, totalCount: 0 });
    assert.equal(out.verdict, 'unusable');
    assert.equal(out.cause, 'rollup-no-leido');
});

test('#6431 — un requerido presente y en curso da PENDING', () => {
    const rollup = [checkRun({ status: 'IN_PROGRESS', conclusion: null })];
    const out = classifyRequiredChecks({ required: REQ, rollup, totalCount: 1 });
    assert.equal(out.verdict, 'pending');
});

test('#6431 — todos los requeridos en verde da GREEN', () => {
    const out = classifyRequiredChecks({ required: REQ, rollup: [checkRun()], totalCount: 1 });
    assert.equal(out.verdict, 'green');
    assert.deepEqual(out.green, ['pr-status']);
});

test('#6431 — un requerido en rojo da BLOCKING (nunca pending)', () => {
    const rollup = [checkRun({ conclusion: 'FAILURE' })];
    const out = classifyRequiredChecks({ required: REQ, rollup, totalCount: 1 });
    assert.equal(out.verdict, 'blocking');
    assert.deepEqual(out.failing, ['pr-status']);
});

test('#6431 — el rojo GANA sobre el pendiente cuando hay dos requeridos', () => {
    const required = [
        { context: 'pr-status', integration_id: APP_ID },
        { context: 'build', integration_id: APP_ID },
    ];
    const rollup = [
        checkRun({ name: 'pr-status', conclusion: 'FAILURE' }),
        checkRun({ name: 'build', status: 'QUEUED', conclusion: null }),
    ];
    const out = classifyRequiredChecks({ required, rollup, totalCount: 2 });
    assert.equal(out.verdict, 'blocking');
});

// ── SEC-2 / A-R1: el cotejo de app es el que evita que el fix sea un bypass ─

test('#6431 SEC-2 — un homónimo de OTRA app no satisface el requerido (unusable, no green)', () => {
    // Sin este cotejo, cualquiera con una GitHub App instalada podría publicar
    // un `pr-status` verde y saltearse la protección de rama.
    const rollup = [checkRun({ checkSuite: { app: { databaseId: OTRA_APP, slug: 'ghas' } } })];
    const out = classifyRequiredChecks({ required: REQ, rollup, totalCount: 1 });
    assert.equal(out.verdict, 'unusable');
    assert.equal(out.cause, 'homonimo-sin-app-coincidente');
    // Y tampoco cuenta como ausente: si contara, esperaríamos para siempre.
    assert.deepEqual(out.pending, []);
});

test('#6431 A-R1 — el cotejo es contra databaseId (entero), NO contra el node ID opaco', () => {
    // Éste es el riesgo dominante del issue: cotejar contra `app.id` haría que
    // el clasificador devuelva `unusable` SIEMPRE en producción, el fix sería
    // un no-op y los tests seguirían verdes.
    const conDatabaseId = [checkRun({ checkSuite: { app: { databaseId: APP_ID } } })];
    assert.equal(classifyRequiredChecks({ required: REQ, rollup: conDatabaseId, totalCount: 1 }).verdict, 'green');

    const conNodeId = [checkRun({ checkSuite: { app: { id: 'MDM6QXBwMTUzNjg=' } } })];
    const out = classifyRequiredChecks({ required: REQ, rollup: conNodeId, totalCount: 1 });
    assert.equal(out.verdict, 'unusable', 'un node ID opaco no puede satisfacer un integration_id numérico');
});

test('#6431 A-R1 — contrato de forma REAL: el rollup de `gh` sin `checkSuite` da unusable', () => {
    // Claves exactas que devuelve `gh pr view --json statusCheckRollup` hoy.
    // No trae `checkSuite`, así que el cotejo de app no se puede hacer y el
    // veredicto NO puede ser verde.
    const formaReal = [{
        __typename: 'CheckRun',
        completedAt: '2026-08-24T01:45:21Z',
        conclusion: 'SUCCESS',
        detailsUrl: 'https://github.com/intrale/platform/actions/runs/1',
        name: 'pr-status',
        startedAt: '2026-08-24T01:45:02Z',
        status: 'COMPLETED',
        workflowName: 'PR Status',
    }];
    const out = classifyRequiredChecks({ required: REQ, rollup: formaReal, totalCount: 1 });
    assert.equal(out.verdict, 'unusable');
    assert.equal(out.cause, 'homonimo-sin-app-coincidente');
});

test('#6431 — un requerido SIN integration_id no exige app y se evalúa por nombre', () => {
    const required = [{ context: 'legacy-status', integration_id: null }];
    const rollup = [{ __typename: 'StatusContext', context: 'legacy-status', state: 'SUCCESS' }];
    assert.equal(classifyRequiredChecks({ required, rollup, totalCount: 1 }).verdict, 'green');
});

// ── Reglas 3 y 4: los dos fail-open que quedaban ───────────────────────────

test('#6431 A-R5 — truncamiento (length < totalCount) da unusable, no pending', () => {
    // El peor fail-open del fix: un requerido EN ROJO fuera de página se leería
    // como "ausente" y la regla de ausencia lo convertiría en "pendiente".
    const out = classifyRequiredChecks({ required: REQ, rollup: [], totalCount: 17 });
    assert.equal(out.verdict, 'unusable');
    assert.equal(out.cause, 'truncamiento');
});

test('#6431 — totalCount ausente o no entero da unusable', () => {
    assert.equal(classifyRequiredChecks({ required: REQ, rollup: [] }).cause, 'truncamiento');
    assert.equal(classifyRequiredChecks({ required: REQ, rollup: [], totalCount: '0' }).cause, 'truncamiento');
});

test('#6431 A-R8 — oid distinto del head evaluado da unusable (TOCTOU)', () => {
    const out = classifyRequiredChecks({
        required: REQ, rollup: [checkRun()], totalCount: 1,
        oid: 'aaaaaaa', headRefOid: 'bbbbbbb',
    });
    assert.equal(out.verdict, 'unusable');
    assert.equal(out.cause, 'head-movido-entre-lecturas');
});

test('#6431 — oid igual al head no bloquea', () => {
    const out = classifyRequiredChecks({
        required: REQ, rollup: [checkRun()], totalCount: 1,
        oid: 'abc1234', headRefOid: 'abc1234',
    });
    assert.equal(out.verdict, 'green');
});

// ── SEC-1: fail-closed verdadero sobre el ruleset ──────────────────────────

test('#6431 SEC-1 — sin requeridos legibles el veredicto es unusable, jamás "no hay control"', () => {
    for (const required of [undefined, null, [], 'pr-status', {}]) {
        const out = classifyRequiredChecks({ required, rollup: [], totalCount: 0 });
        assert.equal(out.verdict, 'unusable', `required=${JSON.stringify(required)}`);
    }
});

test('#6431 SEC-1 — un {ok:false} del fetch propaga su causa como unusable', () => {
    const out = classifyRequiredChecks({
        required: { ok: false, required: [], cause: 'ruleset-ilegible:gh-exit-403' },
        rollup: [], totalCount: 0,
    });
    assert.equal(out.verdict, 'unusable');
    assert.equal(out.cause, 'ruleset-ilegible:gh-exit-403');
});

test('#6431 — un requerido con forma inesperada da unusable', () => {
    const out = classifyRequiredChecks({ required: [{ context: '   ' }], rollup: [], totalCount: 0 });
    assert.equal(out.verdict, 'unusable');
    assert.equal(out.cause, 'requerido-forma-inesperada');
});

// ── SEC-8 / CA-21: un estado fuera del enum no es verde por descarte ───────

test('#6431 CA-21 — estado fuera del enum da unusable (ni verde ni pendiente)', () => {
    const rollup = [checkRun({ status: 'COMPLETED', conclusion: 'ALGO_NUEVO' })];
    const out = classifyRequiredChecks({ required: REQ, rollup, totalCount: 1 });
    assert.equal(out.verdict, 'unusable');
    assert.equal(out.cause, 'estado-fuera-de-enum');
});

test('#6431 CA-21 — COMPLETED sin conclusion da unusable, no verde', () => {
    const rollup = [checkRun({ status: 'COMPLETED', conclusion: null })];
    assert.equal(classifyRequiredChecks({ required: REQ, rollup, totalCount: 1 }).verdict, 'unusable');
});

test('#6431 — NEUTRAL y SKIPPED cuentan como verdes (son terminales no bloqueantes)', () => {
    for (const conclusion of ['NEUTRAL', 'SKIPPED', 'SUCCESS']) {
        const rollup = [checkRun({ conclusion })];
        assert.equal(classifyRequiredChecks({ required: REQ, rollup, totalCount: 1 }).verdict, 'green', conclusion);
    }
});

test('#6431 — StatusContext usa `state` y respeta los mismos enums', () => {
    const required = [{ context: 'ci/legacy', integration_id: null }];
    const casos = { PENDING: 'pending', EXPECTED: 'pending', FAILURE: 'blocking', ERROR: 'blocking', SUCCESS: 'green' };
    for (const [state, esperado] of Object.entries(casos)) {
        const rollup = [{ __typename: 'StatusContext', context: 'ci/legacy', state }];
        assert.equal(classifyRequiredChecks({ required, rollup, totalCount: 1 }).verdict, esperado, state);
    }
});

// ── CA-23: los enums NO se re-escriben ─────────────────────────────────────

test('#6431 CA-23 — los enums de estado se importan de human-block-triggers (identidad referencial)', () => {
    // Dos copias de la misma tabla divergen en cuanto GitHub agrega un valor, y
    // la que quede vieja lo lee como "no bloqueante" (fail-open).
    assert.ok(Array.isArray(triggers.CHECK_FAIL_STATES), 'CHECK_FAIL_STATES debe estar exportado');
    assert.ok(Array.isArray(triggers.CHECK_PENDING_STATES), 'CHECK_PENDING_STATES debe estar exportado');
    const src = require('fs').readFileSync(require.resolve('../required-checks.js'), 'utf8');
    assert.match(src, /require\('\.\/human-block-triggers'\)/);
    // Y no hay una segunda definición local de los enums importados.
    assert.doesNotMatch(src, /const\s+CHECK_FAIL_CONCLUSIONS\s*=/);
    assert.doesNotMatch(src, /const\s+CHECK_PENDING_STATUSES\s*=/);
});

test('#6431 — REQUIRED_CHECKS_VERDICTS es el enum cerrado de veredictos', () => {
    assert.deepEqual([...REQUIRED_CHECKS_VERDICTS], ['pending', 'blocking', 'green', 'unusable']);
    assert.ok(Object.isFrozen(REQUIRED_CHECKS_VERDICTS));
});

// ── SEC-11 / CA-12: path injection en rules/branches/<branch> ──────────────

test('#6431 SEC-11 — validateBranchName rechaza `..`, `//`, absolutos y caracteres raros', () => {
    for (const ok of ['main', 'agent/6431-x', 'release/1.2.3', 'a_b-c.d']) {
        assert.equal(validateBranchName(ok), true, ok);
    }
    for (const malo of ['../../rulesets', 'main/..', '..', '.', 'a//b', '/main', 'main/', 'main?x=1',
                        'main branch', 'main\nx', '', null, undefined, 42]) {
        assert.equal(validateBranchName(malo), false, JSON.stringify(malo));
    }
});

test('#6431 CA-12 — un branch fuera de forma NO llega a la API', () => {
    let llamadas = 0;
    const out = fetchRequiredContexts({
        branch: '../../rulesets',
        ghImpl: () => { llamadas++; return { exit_code: 0, stdout: '[]' }; },
    });
    assert.equal(llamadas, 0, 'el ref deforme no puede viajar a la API');
    assert.equal(out.ok, false);
    assert.equal(out.cause, 'branch-fuera-de-forma');
    // Y río abajo eso es `unusable`, no "no hay control".
    assert.equal(classifyRequiredChecks({ required: out, rollup: [], totalCount: 0 }).verdict, 'unusable');
});

// ── fetchRequiredContexts: lectura del ruleset ─────────────────────────────

const rulesetOk = JSON.stringify([
    { type: 'pull_request', parameters: { required_approving_review_count: 0 } },
    { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'pr-status', integration_id: APP_ID }] } },
]);

test('#6431 — fetchRequiredContexts extrae la unión de todas las reglas de checks', () => {
    const ruleset = JSON.stringify([
        { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'a', integration_id: 1 }] } },
        { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'b', integration_id: 2 }, { context: 'a', integration_id: 1 }] } },
    ]);
    const out = fetchRequiredContexts({ branch: 'main', ghImpl: () => ({ exit_code: 0, stdout: ruleset }) });
    assert.equal(out.ok, true);
    assert.deepEqual(out.required, [{ context: 'a', integration_id: 1 }, { context: 'b', integration_id: 2 }]);
});

test('#6431 — fetchRequiredContexts pega a rules/branches, no a rulesets (no exige admin)', () => {
    let args = null;
    fetchRequiredContexts({ branch: 'main', ghImpl: (a) => { args = a; return { exit_code: 0, stdout: rulesetOk }; } });
    assert.deepEqual(args, ['api', 'repos/{owner}/{repo}/rules/branches/main']);
});

test('#6431 SEC-1/CA-6 — ruleset sin required_status_checks o con lista vacía es ok:false', () => {
    const casos = {
        'ruleset-sin-requeridos': ['[]', JSON.stringify([{ type: 'pull_request' }]),
            JSON.stringify([{ type: 'required_status_checks', parameters: { required_status_checks: [] } }])],
    };
    for (const stdout of casos['ruleset-sin-requeridos']) {
        const out = fetchRequiredContexts({ branch: 'main', ghImpl: () => ({ exit_code: 0, stdout }) });
        assert.equal(out.ok, false, stdout);
        assert.equal(out.cause, 'ruleset-sin-requeridos');
    }
});

test('#6431 A-R6 — lectura ilegible (403/404/timeout/JSON inválido/forma) da ok:false con causa', () => {
    const casos = [
        [() => ({ exit_code: 1, stderr: 'HTTP 403' }), /gh-exit-1/],
        [() => ({ exit_code: 0, stdout: 'no soy json' }), /json-invalido/],
        [() => ({ exit_code: 0, stdout: '{"message":"Not Found"}' }), /ruleset-forma-inesperada/],
        [() => { throw new Error('timeout'); }, /excepcion/],
        [() => null, /gh-sin-resultado/],
    ];
    for (const [ghImpl, re] of casos) {
        const out = fetchRequiredContexts({ branch: 'main', ghImpl });
        assert.equal(out.ok, false);
        assert.match(out.cause, re);
    }
});

// ── fetchRollupWithApps ────────────────────────────────────────────────────

const graphqlOk = (contexts, totalCount, oid = 'abc1234') => JSON.stringify({
    data: { repository: { pullRequest: { commits: { nodes: [{ commit: { oid, statusCheckRollup: { contexts: { totalCount, nodes: contexts } } } }] } } } },
});

test('#6431 — fetchRollupWithApps pide databaseId y devuelve oid + totalCount', () => {
    let args = null;
    const out = fetchRollupWithApps({
        prNumber: 6416, repo: 'intrale/platform',
        ghImpl: (a) => { args = a; return { exit_code: 0, stdout: graphqlOk([checkRun()], 1) }; },
    });
    assert.equal(out.ok, true);
    assert.equal(out.oid, 'abc1234');
    assert.equal(out.totalCount, 1);
    const query = args[args.indexOf('-f') + 1];
    assert.match(query, /databaseId/, 'la query DEBE pedir databaseId, no el node id');
    assert.doesNotMatch(query, /app\{\s*id/, 'no debe pedir app.id (node ID opaco)');
    // owner/name salen del repo esperado, nunca de un campo de GitHub.
    assert.ok(args.includes('owner=intrale') && args.includes('name=platform'));
});

test('#6431 — statusCheckRollup null de GraphQL es "leí y está vacío" ([] + totalCount 0)', () => {
    const stdout = JSON.stringify({
        data: { repository: { pullRequest: { commits: { nodes: [{ commit: { oid: 'abc1234', statusCheckRollup: null } }] } } } },
    });
    const out = fetchRollupWithApps({ prNumber: 1, repo: 'intrale/platform', ghImpl: () => ({ exit_code: 0, stdout }) });
    assert.equal(out.ok, true);
    assert.deepEqual(out.contexts, []);
    assert.equal(out.totalCount, 0);
});

test('#6431 — forma inesperada del GraphQL devuelve contexts null (no [])', () => {
    for (const stdout of ['{"data":{}}', '{"errors":[{"message":"x"}]}', '{"data":{"repository":{"pullRequest":{"commits":{"nodes":[]}}}}}']) {
        const out = fetchRollupWithApps({ prNumber: 1, repo: 'intrale/platform', ghImpl: () => ({ exit_code: 0, stdout }) });
        assert.equal(out.ok, false, stdout);
        assert.equal(out.contexts, null, 'jamás [] — eso significaría "leí y está vacío"');
    }
});

test('#6431 — repo o PR fuera de forma no llegan a la API', () => {
    let llamadas = 0;
    const gh = () => { llamadas++; return { exit_code: 0, stdout: '{}' }; };
    assert.equal(fetchRollupWithApps({ prNumber: 0, repo: 'intrale/platform', ghImpl: gh }).cause, 'pr-invalido');
    assert.equal(fetchRollupWithApps({ prNumber: 1, repo: '../../x', ghImpl: gh }).cause, 'repo-fuera-de-forma');
    assert.equal(llamadas, 0);
});

// ── createRequiredChecksReader: cache y logs ───────────────────────────────

test('#6431 SEC-7/D4 — el reader cachea el ruleset OK pero NUNCA el rollup', () => {
    const llamadas = [];
    const read = createRequiredChecksReader({
        repo: 'intrale/platform', baseBranch: 'main',
        ghImpl: (args) => {
            llamadas.push(args[1]);
            if (args[1] === 'graphql') {
                // Segunda lectura: el check ya reportó. Si el rollup estuviera
                // cacheado, el veredicto no cambiaría nunca y el fix no
                // convergería jamás.
                const n = llamadas.filter((x) => x === 'graphql').length;
                return { exit_code: 0, stdout: n === 1 ? graphqlOk([], 0) : graphqlOk([checkRun()], 1) };
            }
            return { exit_code: 0, stdout: rulesetOk };
        },
    });
    assert.equal(read({ prNumber: 6416, headRefOid: 'abc1234' }).verdict, 'pending');
    assert.equal(read({ prNumber: 6416, headRefOid: 'abc1234' }).verdict, 'green');
    assert.equal(llamadas.filter((x) => x !== 'graphql').length, 1, 'el ruleset se lee UNA sola vez');
    assert.equal(llamadas.filter((x) => x === 'graphql').length, 2, 'el rollup se relee en cada espera');
});

test('#6431 — una lectura FALLIDA del ruleset no se cachea (rate limit transitorio)', () => {
    let n = 0;
    const read = createRequiredChecksReader({
        repo: 'intrale/platform', baseBranch: 'main',
        ghImpl: (args) => {
            if (args[1] === 'graphql') return { exit_code: 0, stdout: graphqlOk([], 0) };
            n++;
            return n === 1 ? { exit_code: 1, stderr: 'HTTP 403 rate limit' } : { exit_code: 0, stdout: rulesetOk };
        },
    });
    assert.equal(read({ prNumber: 1, headRefOid: 'abc1234' }).verdict, 'unusable');
    assert.equal(read({ prNumber: 1, headRefOid: 'abc1234' }).verdict, 'pending', 'el segundo intento debe poder leer');
});

test('#6431 A-R6/CA-20 — un ruleset ilegible deja log con la causa (nunca es mudo)', () => {
    const read = createRequiredChecksReader({
        repo: 'intrale/platform', baseBranch: 'main',
        ghImpl: () => ({ exit_code: 1, stderr: 'HTTP 403' }),
    });
    const out = read({ prNumber: 1, headRefOid: 'abc1234' });
    assert.equal(out.verdict, 'unusable');
    assert.ok(out.logLines.length >= 1);
    assert.match(out.logLines.join('\n'), /no se pudo leer la lista de checks requeridos/);
});

test('#6431 SEC-8/A-R11 — los logs traen contexto+app+estado y NUNCA el JSON del ruleset', () => {
    const rulesetConSecretos = JSON.stringify([{
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: 'pr-status', integration_id: APP_ID }] },
        // Datos de política de seguridad que el endpoint real devuelve:
        allowed_actors: [{ actor_id: 99, actor_type: 'Team' }],
        required_reviewers: ['leitolarreta'],
        dismissal_restriction: { users: ['secreto'] },
    }]);
    const read = createRequiredChecksReader({
        repo: 'intrale/platform', baseBranch: 'main',
        ghImpl: (args) => ({
            exit_code: 0,
            stdout: args[1] === 'graphql' ? graphqlOk([checkRun({ status: 'QUEUED', conclusion: null })], 1) : rulesetConSecretos,
        }),
    });
    const out = read({ prNumber: 6416, headRefOid: 'abc1234' });
    const logs = out.logLines.join('\n');
    assert.match(logs, /pr-status \(app 15368\): QUEUED/);
    for (const secreto of ['allowed_actors', 'required_reviewers', 'dismissal_restriction', 'leitolarreta', 'actor_id']) {
        assert.doesNotMatch(logs, new RegExp(secreto), `el log no puede filtrar ${secreto}`);
    }
    assert.equal(JSON.stringify(out).includes('allowed_actors'), false, 'el retorno tampoco lleva el JSON crudo');
});

test('#6431 — el reader pinnea el headRefOid recibido (regla 4 aplica de punta a punta)', () => {
    const read = createRequiredChecksReader({
        repo: 'intrale/platform', baseBranch: 'main',
        ghImpl: (args) => ({
            exit_code: 0,
            stdout: args[1] === 'graphql' ? graphqlOk([checkRun()], 1, 'HEAD_QUE_SE_MOVIO') : rulesetOk,
        }),
    });
    const out = read({ prNumber: 6416, headRefOid: 'abc1234' });
    assert.equal(out.verdict, 'unusable');
    assert.equal(out.cause, 'head-movido-entre-lecturas');
});

// ── CA-13 / A-R10: el módulo no puede contener bypasses ────────────────────

test('#6431 CA-13 — el módulo no usa --admin, --auto ni escribe rulesets', () => {
    // Se grepea el CÓDIGO, no los comentarios: la doc explica por qué NO se usa
    // el endpoint `/rulesets` (pide admin), y esa mención no puede hacer fallar
    // el gate — si no, el test castigaría justo a la documentación del control.
    const src = require('fs').readFileSync(require.resolve('../required-checks.js'), 'utf8');
    const codigo = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const prohibido of [/--admin\b/, /--auto\b/, /-X['",\s]+PUT/, /rulesets/, /\bDELETE\b/]) {
        assert.doesNotMatch(codigo, prohibido, `el módulo es de SÓLO LECTURA: ${prohibido}`);
    }
    // Lo único que llama es el GET de lectura del ruleset efectivo de la rama.
    assert.match(codigo, /'api', `repos\/\{owner\}\/\{repo\}\/rules\/branches\//);
});
