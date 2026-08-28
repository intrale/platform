// #6599 — El pipeline sólo espera por los checks que la protección de rama EXIGE.
//
// Qué defecto fija esta suite. `classifyChecks` recorría el rollup COMPLETO del
// PR: cualquier check `IN_PROGRESS` devolvía `state: 'pending'`, y ese veredicto
// alimentaba `detectMergeStateBlock()` (que devuelve `inconclusive` y hace que
// el barrido reintente en silencio) y el camino BLOCKED de `delivery.js`.
//
// El caso real: `OWASP Dependency Check` vive en `security-sast.yml` con
// `continue-on-error: true` y `failBuildOnCVSS = 11.0` — o sea, NO PUEDE VETAR
// NADA por diseño (un CVSS real nunca supera 10). El único requerido del ruleset
// de `main` es `pr-status`. El 2026-08-25 el OWASP tardó 3 h 10 m (17:18→20:29)
// y el pipeline se quedó esperándolo.
//
// Lo que esta suite tiene que impedir es que el arreglo se pase de rosca:
//   - un requerido pendiente SIGUE frenando;
//   - un requerido en rojo SIGUE frenando;
//   - sin lista de requeridos (403, rate limit, ruleset ilegible) pesa TODO el
//     rollup, igual que antes — fail-closed, jamás "no se exige nada";
//   - una lista vacía tampoco habilita el filtro (filtrar contra `[]` dejaría
//     cero checks pesando y todo PR saldría verde);
//   - un requerido que NO aparece en el rollup no se lee como verde por descarte.
//
// Sin red: todo son fixtures inyectadas, igual que el resto de la suite.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const triggers = require('../human-block-triggers');
const requiredChecks = require('../required-checks');

// Fixture del caso real: el único requerido del ruleset de `main`.
const REQUERIDOS = [{ context: 'pr-status', integration_id: 15368 }];
const LEIDO = { requiredContexts: REQUERIDOS, requiredContextsRead: true };

const OWASP_CORRIENDO = { name: 'OWASP Dependency Check', status: 'IN_PROGRESS', conclusion: '' };
const OWASP_ROJO = { name: 'OWASP Dependency Check', status: 'COMPLETED', conclusion: 'FAILURE' };
const PR_STATUS_OK = { name: 'pr-status', status: 'COMPLETED', conclusion: 'SUCCESS' };
const PR_STATUS_CORRIENDO = { name: 'pr-status', status: 'IN_PROGRESS', conclusion: '' };
const PR_STATUS_ROJO = { name: 'pr-status', status: 'COMPLETED', conclusion: 'FAILURE' };

// ── classifyChecks: la partición requerido / informativo ───────────────────

test('#6599 CA-2 — un check NO requerido corriendo no aporta al estado vetante', () => {
    const c = triggers.classifyChecks([PR_STATUS_OK, OWASP_CORRIENDO], LEIDO);
    assert.equal(c.state, 'green', 'el único requerido está verde: no hay nada que esperar');
    assert.deepEqual(c.pending, [], 'el OWASP no puede figurar como pendiente vetante');
    assert.deepEqual(c.informational.pending, ['OWASP Dependency Check'], 'pero no desaparece');
    assert.equal(c.requiredFilterApplied, true);
    assert.equal(c.total, 1, '`total` cuenta sólo los requeridos cuando el filtro está activo');
});

test('#6599 CA-3 — un check NO requerido en rojo no bloquea, pero queda registrado', () => {
    const c = triggers.classifyChecks([PR_STATUS_OK, OWASP_ROJO], LEIDO);
    assert.equal(c.state, 'green', 'un informativo en rojo no tiene poder de veto');
    assert.deepEqual(c.failing, []);
    assert.deepEqual(c.informational.failing, ['OWASP Dependency Check']);
});

test('#6599 CA-4 — los requeridos conservan EXACTAMENTE el comportamiento de hoy', () => {
    // Pendiente sigue siendo pendiente…
    const pend = triggers.classifyChecks([PR_STATUS_CORRIENDO, OWASP_CORRIENDO], LEIDO);
    assert.equal(pend.state, 'pending');
    assert.deepEqual(pend.pending, ['pr-status'], 'sólo el requerido justifica la espera');

    // …y rojo sigue siendo rojo, con o sin informativos alrededor.
    const rojo = triggers.classifyChecks([PR_STATUS_ROJO, OWASP_CORRIENDO], LEIDO);
    assert.equal(rojo.state, 'failing');
    assert.deepEqual(rojo.failing, ['pr-status']);
});

test('#6599 CA-5 — sin lista de requeridos pesa TODO el rollup (fail-closed)', () => {
    const rollup = [PR_STATUS_OK, OWASP_CORRIENDO];

    // (a) el llamador ni pasa opciones: comportamiento previo a #6599, byte por byte.
    const legacy = triggers.classifyChecks(rollup);
    assert.equal(legacy.state, 'pending', 'sin lista, el OWASP vuelve a pesar');
    assert.deepEqual(legacy.pending, ['OWASP Dependency Check']);
    assert.equal(legacy.requiredFilterApplied, false);
    assert.equal(legacy.requiredFilterCause, 'requeridos-no-leidos', 'la causa queda dicha');
    assert.equal(legacy.total, 2, '`total` vuelve a ser el rollup entero');

    // (b) 403 / rate limit: hay lista pero NO se pudo confirmar la lectura.
    const sinLeer = triggers.classifyChecks(rollup, {
        requiredContexts: REQUERIDOS, requiredContextsRead: false,
    });
    assert.equal(sinLeer.state, 'pending', 'lectura no confirmada NUNCA relaja el gate');
    assert.equal(sinLeer.requiredFilterApplied, false);

    // (c) `requiredContextsRead` con cualquier valor que no sea `true` estricto.
    for (const v of [undefined, null, 'true', 1, {}]) {
        const c = triggers.classifyChecks(rollup, { requiredContexts: REQUERIDOS, requiredContextsRead: v });
        assert.equal(c.requiredFilterApplied, false, `requiredContextsRead=${JSON.stringify(v)} no activa el filtro`);
    }
});

test('#6599 — una lista de requeridos VACÍA no activa el filtro (si no, todo saldría verde)', () => {
    const c = triggers.classifyChecks([OWASP_CORRIENDO], { requiredContexts: [], requiredContextsRead: true });
    assert.equal(c.requiredFilterApplied, false);
    assert.equal(c.requiredFilterCause, 'lista-de-requeridos-vacia');
    assert.equal(c.state, 'pending', 'filtrar contra [] sería el fail-open exacto que hay que evitar');
});

test('#6599 — un requerido AUSENTE del rollup no se lee como verde por descarte', () => {
    // Sólo hay informativos. No hay evidencia sobre lo único que puede vetar.
    const c = triggers.classifyChecks([OWASP_CORRIENDO, { name: 'Semgrep OSS', status: 'COMPLETED', conclusion: 'SUCCESS' }], LEIDO);
    assert.equal(c.state, 'unknown', 'unknown, jamás green: no se afirma lo que no se leyó');
    assert.equal(c.total, 0);
});

test('#6599 — un nodo ilegible del rollup pesa siempre, con filtro o sin él', () => {
    // No se puede atribuir ni a requerido ni a informativo: descartarlo sería
    // tratar la ignorancia como vía libre.
    const c = triggers.classifyChecks([PR_STATUS_OK, null, 'basura'], LEIDO);
    assert.equal(c.state, 'unknown');
});

test('#6599 — el filtro normaliza StatusContext, strings pelados y espacios al borde', () => {
    // StatusContext usa `context`, no `name`.
    const ctx = triggers.classifyChecks(
        [{ context: 'pr-status', state: 'PENDING' }, { context: 'legacy/info', state: 'PENDING' }],
        LEIDO,
    );
    assert.equal(ctx.state, 'pending');
    assert.deepEqual(ctx.pending, ['pr-status']);
    assert.deepEqual(ctx.informational.pending, ['legacy/info']);

    // La lista también se acepta como array de strings.
    const str = triggers.classifyChecks([PR_STATUS_OK, OWASP_CORRIENDO], {
        requiredContexts: ['  pr-status  '], requiredContextsRead: true,
    });
    assert.equal(str.state, 'green');
    assert.equal(str.requiredFilterApplied, true);
});

test('#6599 — normalizeRequiredContexts distingue null (no hay lista) de [] (lista vacía)', () => {
    assert.equal(triggers.normalizeRequiredContexts(null), null);
    assert.equal(triggers.normalizeRequiredContexts('pr-status'), null);
    assert.deepEqual(triggers.normalizeRequiredContexts([]), []);
    // Duplicados y basura se limpian sin romper.
    assert.deepEqual(
        triggers.normalizeRequiredContexts([{ context: 'a' }, 'a', '', null, { context: '  b ' }, 42]),
        ['a', 'b'],
    );
});

// ── detectMergeStateBlock: el veredicto que consume el barrido ──────────────

test('#6599 CA-2 — BLOCKED con el requerido verde y un informativo corriendo NO es inconcluyente', () => {
    // ANTES: el OWASP daba `pending` ⇒ `{inconclusive:true}` ⇒ el barrido
    // reintentaba en silencio durante horas sin avisarle a nadie.
    const v = triggers.detectMergeStateBlock({
        prNumber: 6599,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        reviewDecision: 'REVIEW_REQUIRED',
        statusCheckRollup: [PR_STATUS_OK, OWASP_CORRIENDO],
        ...LEIDO,
    });
    assert.notEqual(v.inconclusive, true, 'ya no se queda esperando por un control sin veto');
    assert.equal(v.trigger, triggers.TRIGGERS.CODEOWNERS_REVIEW, 'la causa real es la firma que falta');
    // Guideline de UX: el informativo se nombra, en su propia línea, diciendo
    // explícitamente que no frena.
    assert.match(v.reason, /OWASP Dependency Check/);
    assert.match(v.reason, /\n/, 'los informativos van en línea aparte, no mezclados con la causa');
    assert.match(v.reason, /no frenan el merge/);
    assert.deepEqual(v.informational.pending, ['OWASP Dependency Check']);
    assert.equal(v.requiredFilter.applied, true);
    // Concordancia: el ruleset de `main` exige UN contexto, así que el mensaje
    // no puede decir "sus 1 checks".
    assert.match(v.recommendation, /su único check requerido está en verde/);
});

test('#6599 CA-4 — BLOCKED con el requerido PENDIENTE sigue siendo inconcluyente', () => {
    const v = triggers.detectMergeStateBlock({
        prNumber: 6600,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        reviewDecision: '',
        statusCheckRollup: [PR_STATUS_CORRIENDO, OWASP_CORRIENDO],
        ...LEIDO,
    });
    assert.equal(v.inconclusive, true, 'esperar por `pr-status` sigue siendo lo correcto');
    assert.deepEqual(v.checks.pending, ['pr-status'], 'y se espera SÓLO por él');
});

test('#6599 CA-4 — BLOCKED con el requerido en rojo sigue bloqueando y nombra sólo requeridos', () => {
    const v = triggers.detectMergeStateBlock({
        prNumber: 6601,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        reviewDecision: '',
        statusCheckRollup: [PR_STATUS_ROJO, OWASP_ROJO],
        ...LEIDO,
    });
    assert.equal(v.trigger, triggers.TRIGGERS.CHECKS_FAILING);
    assert.deepEqual(v.checks.failing, ['pr-status'], 'el OWASP no es la causa del bloqueo');
    // El mensaje del bloqueo nombra el requerido en la oración de la causa…
    const [causa] = v.reason.split('\n');
    assert.match(causa, /pr-status/);
    assert.doesNotMatch(causa, /OWASP/, 'un informativo NUNCA se presenta como la causa');
    // …y el informativo aparece aparte, marcado como sin veto.
    assert.match(v.reason, /Checks informativos[\s\S]*OWASP Dependency Check/);
    assert.deepEqual(v.informational.failing, ['OWASP Dependency Check']);
});

test('#6599 CA-5 — sin lista leída, detectMergeStateBlock se comporta como antes', () => {
    const v = triggers.detectMergeStateBlock({
        prNumber: 6602,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        reviewDecision: 'REVIEW_REQUIRED',
        statusCheckRollup: [PR_STATUS_OK, OWASP_CORRIENDO],
        // sin requiredContexts: 403, rate limit, ruleset ilegible.
    });
    assert.equal(v.inconclusive, true, 'fail-closed: se espera por todo, igual que antes de #6599');
    assert.equal(v.requiredFilter.applied, false);
    assert.equal(v.requiredFilter.cause, 'requeridos-no-leidos', 'y queda dicho por qué');
});

test('#6599 anti-código-muerto — detectPrHumanBlock PROPAGA la lista al clasificador', () => {
    // Sin este cableado el fix es un no-op con los tests en verde: la lista se
    // leería y no llegaría nunca a `classifyChecks`.
    const v = triggers.detectPrHumanBlock({
        number: 6599,
        headRefName: 'agent/6599-pipeline-dev',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        reviewDecision: 'REVIEW_REQUIRED',
        statusCheckRollup: [PR_STATUS_OK, OWASP_CORRIENDO],
    }, { securityAlerts: [], ...LEIDO });
    assert.equal(v.trigger, triggers.TRIGGERS.CODEOWNERS_REVIEW,
        'si la lista no viaja, esto vuelve a decir inconclusive y espera 3 horas');

    // Y sin la lista, el mismo PR sigue esperando (control del control).
    const sinLista = triggers.detectPrHumanBlock({
        number: 6599,
        headRefName: 'agent/6599-pipeline-dev',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        reviewDecision: 'REVIEW_REQUIRED',
        statusCheckRollup: [PR_STATUS_OK, OWASP_CORRIENDO],
    }, { securityAlerts: [] });
    assert.equal(sinLista.inconclusive, true);
});

test('#6599 — describeInformationalChecks recorta a 5 y no inventa texto si no hay nada', () => {
    assert.equal(triggers.describeInformationalChecks({ informational: { failing: [], pending: [] } }), '');
    assert.equal(triggers.describeInformationalChecks(null), '');
    const muchos = triggers.describeInformationalChecks({
        informational: { failing: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], pending: [] },
    });
    assert.match(muchos, /a, b, c, d, e y 2 más/);
});

// ── required-checks.js: la lista se expone sin una segunda llamada a la API ──

test('#6599 — toContextList proyecta el ruleset a nombres y distingue null de []', () => {
    assert.equal(requiredChecks.toContextList(null), null);
    assert.deepEqual(requiredChecks.toContextList([]), []);
    assert.deepEqual(
        requiredChecks.toContextList([{ context: 'pr-status', integration_id: 15368 }, { context: 'pr-status' }]),
        ['pr-status'],
    );
});

test('#6599 — el reader devuelve la lista YA leída, sin pegarle otra vez a la API', () => {
    const llamadas = [];
    const ghFake = (args) => {
        llamadas.push(args[1]);
        if (String(args[1]).startsWith('repos/')) {
            return {
                exit_code: 0,
                stdout: JSON.stringify([{
                    type: 'required_status_checks',
                    parameters: { required_status_checks: [{ context: 'pr-status', integration_id: 15368 }] },
                }]),
            };
        }
        return {
            exit_code: 0,
            stdout: JSON.stringify({
                data: {
                    repository: {
                        pullRequest: {
                            commits: {
                                nodes: [{
                                    commit: {
                                        oid: 'sha1',
                                        statusCheckRollup: {
                                            contexts: {
                                                totalCount: 2,
                                                nodes: [
                                                    { __typename: 'CheckRun', name: 'pr-status', status: 'COMPLETED', conclusion: 'SUCCESS', checkSuite: { app: { databaseId: 15368 } } },
                                                    { __typename: 'CheckRun', name: 'OWASP Dependency Check', status: 'IN_PROGRESS', conclusion: null, checkSuite: { app: { databaseId: 15368 } } },
                                                ],
                                            },
                                        },
                                    },
                                }],
                            },
                        },
                    },
                },
            }),
        };
    };
    const read = requiredChecks.createRequiredChecksReader({
        ghImpl: ghFake, cwd: path.sep, repo: 'intrale/platform', baseBranch: 'main',
    });
    const r1 = read({ prNumber: 6599, headRefOid: 'sha1' });
    assert.equal(r1.verdict, 'green', 'el único requerido está verde; el OWASP no entra al veredicto');
    assert.deepEqual(r1.requiredContexts, ['pr-status'], 'la lista viaja de vuelta al llamador');
    assert.equal(r1.requiredContextsRead, true);

    // Segunda vuelta: el ruleset ya está cacheado, sólo se relee el rollup.
    const antes = llamadas.filter((a) => String(a).startsWith('repos/')).length;
    const r2 = read({ prNumber: 6599, headRefOid: 'sha1' });
    const despues = llamadas.filter((a) => String(a).startsWith('repos/')).length;
    assert.equal(antes, despues, 'la lista no cuesta una request extra por vuelta');
    assert.deepEqual(r2.requiredContexts, ['pr-status']);
});

test('#6599 CA-5 — ruleset ilegible: el reader marca requiredContextsRead:false y explica', () => {
    const read = requiredChecks.createRequiredChecksReader({
        ghImpl: () => ({ exit_code: 1, stdout: '', stderr: 'HTTP 403' }),
        cwd: path.sep, repo: 'intrale/platform', baseBranch: 'main',
    });
    const r = read({ prNumber: 6599, headRefOid: 'sha1' });
    assert.equal(r.requiredContextsRead, false, 'fail-closed: río abajo pesa todo el rollup');
    assert.equal(r.requiredContexts, null, 'null ("no leí"), nunca [] ("no se exige nada")');
    assert.ok(r.logLines.some((l) => /no se pudo leer la lista de checks requeridos/.test(l)),
        'la desactivación del filtro nunca es muda');
});

test('#6599 — createRequiredContextsCache cachea la lectura OK y NO cachea el fallo', () => {
    let lecturas = 0;
    let falla = false;
    const ghFake = () => {
        lecturas++;
        if (falla) return { exit_code: 1, stdout: '', stderr: 'HTTP 403' };
        return {
            exit_code: 0,
            stdout: JSON.stringify([{
                type: 'required_status_checks',
                parameters: { required_status_checks: [{ context: 'pr-status', integration_id: 15368 }] },
            }]),
        };
    };
    let reloj = 1000;
    const cache = requiredChecks.createRequiredContextsCache({
        ghImpl: ghFake, cwd: path.sep, baseBranch: 'main', ttlMs: 60000, now: () => reloj,
    });

    assert.deepEqual(cache(), { ok: true, contexts: ['pr-status'], cause: null, cached: false });
    assert.equal(cache().cached, true, 'dentro del TTL no se relee');
    assert.equal(lecturas, 1);

    reloj += 60001;
    assert.equal(cache().cached, false, 'vencido el TTL se relee');
    assert.equal(lecturas, 2);

    // Un 403 no se cachea: la vuelta siguiente tiene que poder leerlo.
    falla = true;
    reloj += 60001;
    const malo = cache();
    assert.equal(malo.ok, false);
    assert.equal(malo.contexts, null);
    falla = false;
    assert.equal(cache().ok, true, 'un fallo transitorio no apaga el filtro por 10 minutos');
});

test('#6599 CA-23 — el matcher nombre↔contexto es UNO SOLO, compartido con required-checks', () => {
    // Dos copias del mismo cotejo divergen y la que quede vieja lee un requerido
    // como AUSENTE, que río abajo es fail-open.
    const src = require('fs').readFileSync(require.resolve('../required-checks'), 'utf8');
    assert.match(src, /checkMatchesContext,?\s*\n?\s*\}?\s*=?\s*/, 'required-checks importa el matcher');
    assert.doesNotMatch(src, /n\.name === context \|\| n\.context === context/,
        'no puede quedar una segunda copia del cotejo');
    assert.equal(typeof triggers.checkMatchesContext, 'function');
    assert.equal(triggers.checkMatchesContext({ name: ' pr-status ' }, 'pr-status'), true);
    assert.equal(triggers.checkMatchesContext({ context: 'pr-status' }, 'pr-status'), true);
    assert.equal(triggers.checkMatchesContext({ name: 'otro' }, 'pr-status'), false);
    assert.equal(triggers.checkMatchesContext(null, 'pr-status'), false);
    assert.equal(triggers.checkMatchesContext({ name: 'pr-status' }, ''), false);
});
