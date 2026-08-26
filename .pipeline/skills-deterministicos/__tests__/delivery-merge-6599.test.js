// #6599 — El delivery deja de esperar por checks que la protección de rama no exige.
//
// Efecto lateral del PR #6503 (#6431): al dejar de escalar a `needs-human` ante
// checks pendientes y pasar a ESPERAR, el reloj del merge lo empezó a marcar el
// check más lento del PR — tuviera o no poder de veto. El caso concreto es
// `OWASP Dependency Check`: vive en `security-sast.yml` con
// `continue-on-error: true` y `failBuildOnCVSS = 11.0` (condición de falla
// inalcanzable a propósito), no figura en la protección de `main` —cuyo único
// requerido es `pr-status`— y el 2026-08-25 tardó 3 h 10 m.
//
// Esta suite verifica el cableado END-TO-END en `delivery.js`, no sólo la
// función pura: el riesgo real de este cambio es que la lista se lea bien y no
// llegue nunca al clasificador. Y verifica que ningún gate se relaja: QA sigue
// siendo obligatorio, un requerido pendiente sigue frenando, y sin lista legible
// el comportamiento vuelve a ser el de antes.
//
// Sin red: todas las dependencias se inyectan, incluidos el `sleep` y el
// `requiredChecksReader`.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Aislar REPO_ROOT (delivery escribe audit + cola Telegram centrales acá).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-delivery6599-'));
fs.mkdirSync(path.join(TMP, '.claude', 'hooks'), { recursive: true });
fs.mkdirSync(path.join(TMP, '.pipeline', 'logs'), { recursive: true });
process.env.PIPELINE_REPO_ROOT = TMP;
process.env.CLAUDE_PROJECT_DIR = TMP;

delete require.cache[require.resolve('../delivery')];
const delivery = require('../delivery');

// ── Fixtures ───────────────────────────────────────────────────────────────

const HEAD_SHA = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';

const NOT_MERGEABLE_405 = {
    exit_code: 1, stdout: '',
    stderr: 'gh: Pull Request is not mergeable (HTTP 405)',
};
const MERGED_OK = {
    exit_code: 0,
    stdout: JSON.stringify({ sha: 'merge-sha-6599', merged: true }),
    stderr: '',
};

const PR_STATUS_OK = { name: 'pr-status', status: 'COMPLETED', conclusion: 'SUCCESS' };
const PR_STATUS_CORRIENDO = { name: 'pr-status', status: 'IN_PROGRESS', conclusion: '' };
const OWASP_CORRIENDO = { name: 'OWASP Dependency Check', status: 'IN_PROGRESS', conclusion: '' };
const OWASP_ROJO = { name: 'OWASP Dependency Check', status: 'COMPLETED', conclusion: 'FAILURE' };

function snapshotOk(over = {}) {
    return {
        ok: true,
        labels: ['qa:skipped'],
        files: ['.pipeline/lib/human-block-triggers.js'],
        headRefOid: HEAD_SHA,
        headRefName: 'agent/6599-pipeline-dev',
        state: 'OPEN',
        mergeStateStatus: 'CLEAN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [PR_STATUS_OK, OWASP_CORRIENDO],
        reviewDecision: 'APPROVED',
        reviewDecisionRead: true,
        snapshotFieldsLevel: 1,
        ...over,
    };
}

// Lector fake que devuelve la lista de requeridos junto al veredicto, igual que
// hace `createRequiredChecksReader` en producción desde #6599.
function readerFake(v = {}) {
    return () => ({
        pending: [], failing: [], green: [], logLines: [],
        requiredContexts: ['pr-status'], requiredContextsRead: true,
        ...v,
    });
}

function baseDeps(over = {}) {
    return {
        prNumber: 6599,
        getSnapshot: () => snapshotOk(),
        loadOwners: () => ({ ok: true, rules: [] }),
        verifyOrigin: () => ({ ok: true }),
        mergePR: () => MERGED_OK,
        sleepImpl: () => {},
        ...over,
    };
}

// ── CA-7: el caso del episodio ─────────────────────────────────────────────

test('#6599 CA-7 — un PR cuyo único check colgado es el OWASP mergea sin una sola espera', () => {
    const sleeps = [];
    const merges = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        mergePR: () => { merges.push(1); return MERGED_OK; },
        requiredChecksReader: readerFake({ verdict: 'green', green: ['pr-status'] }),
        sleepImpl: (ms) => sleeps.push(ms),
    }));
    assert.equal(out.status, 'merged');
    assert.deepEqual(sleeps, [], 'cero esperas: el OWASP no tiene poder de veto');
    assert.equal(merges.length, 1);
});

test('#6599 CA-1/CA-2 — 405 BLOCKED con el requerido verde NO consume el presupuesto de esperas', () => {
    // ANTES: el OWASP `IN_PROGRESS` daba `checks-in-flight` y el delivery
    // quemaba las 7 esperas (~104 s) por vuelta antes de rendirse.
    const sleeps = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({ mergeStateStatus: 'BLOCKED' }),
        mergePR: () => NOT_MERGEABLE_405,
        requiredChecksReader: readerFake({ verdict: 'green', green: ['pr-status'] }),
        sleepImpl: (ms) => sleeps.push(ms),
    }));
    assert.deepEqual(sleeps, [], 'no se espera por un control informativo');
    assert.equal(out.status, 'blocked');
    assert.equal(out.gate, 'branch-protection-other',
        'con todos los requeridos verdes, lo que frena es OTRO control — y eso sí escala');
});

test('#6599 CA-4 — un requerido PENDIENTE sigue frenando y sigue esperando', () => {
    const sleeps = [];
    let lecturas = 0;
    const merges = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({
            mergeStateStatus: 'BLOCKED',
            statusCheckRollup: [PR_STATUS_CORRIENDO, OWASP_CORRIENDO],
        }),
        mergePR: () => { merges.push(1); return merges.length >= 2 ? MERGED_OK : NOT_MERGEABLE_405; },
        requiredChecksReader: () => {
            lecturas++;
            return lecturas === 1
                ? { verdict: 'pending', pending: ['pr-status'], failing: [], green: [], logLines: [], requiredContexts: ['pr-status'], requiredContextsRead: true }
                : { verdict: 'green', pending: [], failing: [], green: ['pr-status'], logLines: [], requiredContexts: ['pr-status'], requiredContextsRead: true };
        },
        sleepImpl: (ms) => sleeps.push(ms),
    }));
    assert.equal(out.status, 'merged');
    assert.deepEqual(sleeps, [2000], 'esperó por `pr-status`, que sí puede vetar');
});

test('#6599 CA-4 — un requerido en ROJO sigue escalando, no se relaja ningún gate', () => {
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({ mergeStateStatus: 'BLOCKED' }),
        mergePR: () => NOT_MERGEABLE_405,
        requiredChecksReader: readerFake({ verdict: 'blocking', failing: ['pr-status'] }),
    }));
    assert.equal(out.status, 'blocked');
    assert.equal(out.gate, 'branch-protection-checks-red');
});

test('#6599 CA-6 — el gate de QA sigue siendo obligatorio y este cambio no lo toca', () => {
    const merges = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({ labels: ['enhancement'] }),
        mergePR: () => { merges.push(1); return MERGED_OK; },
        requiredChecksReader: readerFake({ verdict: 'green', green: ['pr-status'] }),
    }));
    assert.equal(out.status, 'no-qa-gate', 'sin qa:passed / qa:skipped no se mergea nada');
    assert.equal(merges.length, 0);
});

// ── CA-3: visibilidad de los no requeridos ─────────────────────────────────

test('#6599 CA-3 — el resumen del delivery reporta los no requeridos en rojo o colgados', () => {
    const logs = [];
    delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({
            mergeStateStatus: 'BLOCKED',
            statusCheckRollup: [PR_STATUS_OK, OWASP_ROJO],
        }),
        mergePR: () => NOT_MERGEABLE_405,
        requiredChecksReader: readerFake({ verdict: 'green', green: ['pr-status'] }),
        logAppend: (l) => logs.push(String(l)),
    }));
    const linea = logs.find((l) => /Checks informativos/.test(l));
    assert.ok(linea, 'un OWASP en rojo que desaparece del log es un defecto que nadie ve');
    assert.match(linea, /OWASP Dependency Check/);
    assert.match(linea, /no frenan el merge/, 'la falta de veto se dice, no se deja implícita');
    // Y no se presenta como la causa del bloqueo.
    assert.ok(!/merge bloqueado.*OWASP/.test(logs.join('\n')));
});

test('#6599 CA-5 — sin lista legible, el log dice por qué el filtro quedó desactivado', () => {
    const logs = [];
    delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({ mergeStateStatus: 'BLOCKED' }),
        mergePR: () => NOT_MERGEABLE_405,
        // Ruleset ilegible: el reader devuelve `unusable` y NO trae lista.
        requiredChecksReader: () => ({
            verdict: 'unusable', cause: 'ruleset-ilegible:gh-exit-1',
            pending: [], failing: [], green: [], logLines: [],
            requiredContexts: null, requiredContextsRead: false,
        }),
        logAppend: (l) => logs.push(String(l)),
    }));
    const linea = logs.find((l) => /filtro de checks no requeridos DESACTIVADO/.test(l));
    assert.ok(linea, 'la desactivación del filtro nunca es muda (CA-5)');
    assert.match(linea, /requeridos-no-leidos/);
    assert.match(linea, /se espera por todos los checks del PR/);
});

// ── Anti-código-muerto: la lista tiene que LLEGAR al clasificador ───────────

test('#6599 anti-código-muerto — la reclasificación post-405 propaga la lista leída al ctx', () => {
    // Sin esto el fix es un no-op con los tests en verde: el reader lee la lista
    // y el clasificador nunca la ve.
    const src = fs.readFileSync(require.resolve('../delivery'), 'utf8');
    // La SEGUNDA aparicion: la primera pasada corre sin `requiredChecks` (pura,
    // con lo que ya estaba en el snapshot); la reclasificacion es la de abajo.
    const inicio = src.lastIndexOf('classification = classifyMergeFailure(mergeRes, {');
    assert.ok(inicio > 0, 'sigue existiendo la reclasificacion post-405');
    const bloque = src.slice(inicio, src.indexOf('});', inicio));
    assert.match(bloque, /requiredContexts: rc\.requiredContexts/);
    assert.match(bloque, /requiredContextsRead: rc\.requiredContextsRead/);
});

test('#6599 — classifyMergeFailure filtra por requeridos cuando el ctx trae la lista', () => {
    const ctx = {
        mergeStateStatus: 'BLOCKED',
        state: 'OPEN',
        statusCheckRollup: [PR_STATUS_OK, OWASP_CORRIENDO],
        requiredContexts: ['pr-status'],
        requiredContextsRead: true,
    };
    const c = delivery.classifyMergeFailure(NOT_MERGEABLE_405, ctx);
    assert.notEqual(c.kind, 'checks-in-flight', 'el OWASP no puede habilitar la espera');
    assert.equal(c.retryable, false);
    assert.equal(c.checks.state, 'green');
    assert.deepEqual(c.checks.informational.pending, ['OWASP Dependency Check']);
});

test('#6599 CA-5 — classifyMergeFailure SIN lista se comporta igual que antes de #6599', () => {
    const ctx = {
        mergeStateStatus: 'BLOCKED',
        state: 'OPEN',
        statusCheckRollup: [PR_STATUS_OK, OWASP_CORRIENDO],
        // sin requiredContexts: fail-closed.
    };
    const c = delivery.classifyMergeFailure(NOT_MERGEABLE_405, ctx);
    assert.equal(c.kind, 'checks-in-flight', 'fail-closed: se sigue esperando por todo');
    assert.equal(c.retryable, true);
});

test('#6599 A-2 — el reader de PRODUCCIÓN expone la lista de requeridos al llamador', () => {
    // El wiring real (`buildRequiredChecksReader`) tiene que devolver un reader
    // cuyo resultado incluya `requiredContexts`/`requiredContextsRead`: sin eso,
    // `attemptMergeWithGates` no tiene nada que propagar.
    const src = fs.readFileSync(require.resolve('../../lib/required-checks'), 'utf8');
    assert.match(src, /requiredContexts, requiredContextsRead,/,
        'el reader devuelve la lista ya leída, sin una segunda llamada a la API');
    assert.match(src, /requiredContexts: null, requiredContextsRead: false,/,
        'y ante ruleset ilegible la marca como NO leída (fail-closed)');
});

test('#6599 — el barrido del pulpo también pasa la lista a detectPrHumanBlock', () => {
    // La espera silenciosa de horas vivía acá: `detectMergeStateBlock` devolvía
    // `inconclusive` por un OWASP corriendo y el barrido reintentaba sin avisar.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
    assert.match(src, /detectPrHumanBlock\(prInfo, \{\s*\n\s*securityAlerts, requiredContexts, requiredContextsRead,/);
    assert.match(src, /createRequiredContextsCache/, 'y la lee una sola vez por ventana, no una por PR');
});

// ── CA-3 (rebote rev-1): el camino que MERGEA también reporta ──────────────
//
// El rechazo del PO sobre 475a2fdb7 fue exacto: el test de CA-3 de arriba monta
// `BLOCKED` + 405, o sea un PR que NO mergea. Cubría "reporta" pero no "mergea Y
// reporta", que es la mitad del criterio y encima la que describe el Gherkin.
// El escenario real: el OWASP corre con `continue-on-error: true`, así que un
// OWASP en rojo deja el `mergeStateStatus` en CLEAN y el delivery mergea por el
// camino feliz — que hasta este rebote no emitía una sola línea.

const CONTEXTS_OK = () => ({ ok: true, contexts: ['pr-status'], cause: null });

test('#6599 CA-3 — el camino feliz MERGEA y aun así reporta el no requerido en rojo', () => {
    const logs = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({
            // El caso que motiva el issue, tal cual: requerido en verde, OWASP
            // en rojo y GitHub diciendo CLEAN porque el OWASP no puede vetar.
            mergeStateStatus: 'CLEAN',
            statusCheckRollup: [PR_STATUS_OK, OWASP_ROJO],
        }),
        mergePR: () => MERGED_OK,
        requiredContextsReader: CONTEXTS_OK,
        logAppend: (l) => logs.push(String(l)),
    }));

    // Las DOS mitades del criterio, en el MISMO caso: no bloquea...
    assert.equal(out.status, 'merged', 'un check no requerido en rojo NO bloquea el merge');
    assert.equal(out.sha, 'merge-sha-6599');

    // ...y queda registrado en el resumen.
    const linea = logs.find((l) => /Checks informativos/.test(l));
    assert.ok(linea, 'el OWASP en rojo no puede desaparecer del resumen sólo porque el merge salió bien');
    assert.match(linea, /OWASP Dependency Check/);
    assert.match(linea, /en rojo/);
    assert.match(linea, /no frenan el merge/);

    // Y el dato viaja también en el retorno, no sólo en el log: hasta este
    // rebote `informationalChecks` era una asignación que no leía nadie.
    assert.deepEqual(out.informationalChecks, { failing: ['OWASP Dependency Check'], pending: [] });
});

test('#6599 CA-3 — el resumen no se emite una vez por vuelta del polling', () => {
    // El bucle reevalúa hasta agotar el presupuesto de esperas. El resumen se
    // ata al snapshot, pero repetir la MISMA línea siete veces convierte el log
    // en ruido y esconde justo lo que este criterio quería hacer visible.
    const logs = [];
    let vueltas = 0;
    delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => {
            vueltas++;
            // UNKNOWN fuerza el camino de espera/reevaluación de (5b).
            return snapshotOk({
                mergeStateStatus: vueltas < 3 ? 'UNKNOWN' : 'CLEAN',
                statusCheckRollup: [PR_STATUS_OK, OWASP_ROJO],
            });
        },
        mergePR: () => MERGED_OK,
        requiredContextsReader: CONTEXTS_OK,
        logAppend: (l) => logs.push(String(l)),
    }));
    const repetidas = logs.filter((l) => /Checks informativos/.test(l));
    assert.ok(vueltas >= 3, 'el caso tiene que haber pasado por varias reevaluaciones');
    assert.equal(repetidas.length, 1, 'la misma línea no se repite por cada vuelta del polling');
});

test('#6599 CA-3 — sin nada informativo que decir, no se inventa una línea', () => {
    const logs = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({
            mergeStateStatus: 'CLEAN',
            statusCheckRollup: [PR_STATUS_OK],
        }),
        mergePR: () => MERGED_OK,
        requiredContextsReader: CONTEXTS_OK,
        logAppend: (l) => logs.push(String(l)),
    }));
    assert.equal(out.status, 'merged');
    assert.ok(!logs.some((l) => /Checks informativos/.test(l)));
    // Misma disciplina `null != []` que fija `required-checks.js`: las listas
    // vacías dicen "se evaluó y no hay nada informativo que reportar", que NO es
    // lo mismo que `null` ("no se llegó a evaluar"). El llamador necesita poder
    // distinguir las dos cosas, y por eso el resumen presente-y-vacío se
    // devuelve tal cual en vez de colapsarse a `null`.
    assert.deepEqual(out.informationalChecks, { failing: [], pending: [] });
});

test('#6599 CA-5 — el camino feliz también es fail-closed si el ruleset no se lee', () => {
    // Un lector de contextos que falla NO puede hacer que el filtro se apague en
    // silencio: sin lista, todo el rollup pesa y el motivo queda escrito.
    const logs = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({
            mergeStateStatus: 'CLEAN',
            statusCheckRollup: [PR_STATUS_OK, OWASP_ROJO],
        }),
        mergePR: () => MERGED_OK,
        requiredContextsReader: () => ({ ok: false, contexts: null, cause: 'ruleset-ilegible' }),
        logAppend: (l) => logs.push(String(l)),
    }));
    assert.equal(out.status, 'merged', 'GitHub sigue siendo la autoridad: si dijo CLEAN, mergea');
    const linea = logs.find((l) => /filtro de checks no requeridos DESACTIVADO/.test(l));
    assert.ok(linea, 'la desactivación del filtro nunca es muda (CA-5)');
    assert.match(linea, /ruleset-ilegible/, 'y dice la causa real que devolvió el lector');
    // Sin lista no hay forma de saber que el OWASP es informativo: no se afirma.
    assert.ok(!logs.some((l) => /Checks informativos/.test(l)));
});

test('#6599 CA-3 — un lector de contextos que explota no tumba el merge', () => {
    const logs = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({ mergeStateStatus: 'CLEAN' }),
        mergePR: () => MERGED_OK,
        requiredContextsReader: () => { throw new Error('gh murio'); },
        logAppend: (l) => logs.push(String(l)),
    }));
    assert.equal(out.status, 'merged', 'el resumen es telemetría: no puede decidir el merge');
    assert.ok(logs.some((l) => /filtro de checks no requeridos DESACTIVADO/.test(l)));
});

test('#6599 CA-3 — el resumen del camino feliz no paga una lectura de red por vuelta', () => {
    // `requiredChecksReader` trae ADEMÁS el rollup por red. Usarlo para una
    // línea de telemetría en cada vuelta sería gastar cuota de API en algo que
    // no decide nada; por eso el resumen usa el lector liviano y cacheado.
    let lecturas = 0;
    let vueltas = 0;
    delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => {
            vueltas++;
            return snapshotOk({
                mergeStateStatus: vueltas < 3 ? 'UNKNOWN' : 'CLEAN',
                statusCheckRollup: [PR_STATUS_OK, OWASP_ROJO],
            });
        },
        mergePR: () => MERGED_OK,
        requiredContextsReader: () => { lecturas++; return CONTEXTS_OK(); },
    }));
    assert.ok(vueltas >= 3);
    assert.equal(lecturas, 1, 'la lista se lee una vez por invocación, no una por vuelta');
});

// ── Anti-código-muerto: el wiring de producción tiene que inyectarlo ───────

test('#6599 CA-3 — producción inyecta el lector de contextos en el camino de merge', () => {
    // Sin esta inyección el fix es un no-op con los tests en verde: el resumen
    // queda fail-closed y mudo justo en el camino que mergea.
    const src = fs.readFileSync(require.resolve('../delivery'), 'utf8');
    assert.match(src, /requiredContextsReader: buildRequiredContextsReader\(\)/,
        'el wiring de producción pasa el lector liviano de contextos');
    assert.match(src, /createRequiredContextsCache\(\{ cwd, baseBranch \}\)/,
        'y lo construye con el cache por TTL, no con una lectura pelada por PR');
});

test('#6599 CA-3 — el resumen se calcula por snapshot, no dentro de leerRequeridos', () => {
    // La regresión que motivó el rebote: calcularlo dentro de `leerRequeridos()`
    // lo ataba a dos ramas raras (pre-check con rollup vacío y post-405) y lo
    // dejaba fuera de los dos `return` con status `merged`.
    const src = fs.readFileSync(require.resolve('../delivery'), 'utf8');
    const inicio = src.indexOf('const snapshot = getSnapshot(prNumber);');
    assert.ok(inicio > 0);
    const finLoop = src.indexOf("if (snapshot.state === 'MERGED')", inicio);
    assert.ok(finLoop > inicio, 'sigue existiendo el corte de PR ya mergeado');
    assert.match(src.slice(inicio, finLoop), /resumirInformativos\(snapshot\)/,
        'el resumen corre sobre el snapshot ANTES de cualquier return, incluido el que mergea');
});
