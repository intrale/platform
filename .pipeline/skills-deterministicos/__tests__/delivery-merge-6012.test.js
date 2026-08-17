// #6012 — El HTTP 405 transitorio de GitHub dejó de leerse como conflicto real.
//
// Qué defecto fija esta suite: GitHub responde 405 mientras TODAVÍA ESTÁ
// CALCULANDO la mergeabilidad de un PR recién creado (`mergeStateStatus:
// UNKNOWN`). El delivery lo tomaba como conflicto de merge, frenaba fail-closed
// y escalaba a `needs-human` — dos PRs sanos (#6010 / #6011) quedaron bloqueados
// así y después mergearon sin un solo cambio de código.
//
// El cambio es de CLASIFICACIÓN, no de permisividad. Lo que esta suite tiene que
// impedir es que el arreglo se pase de rosca:
//   - un conflicto confirmado (DIRTY) sigue escalando;
//   - un control de seguridad activo (BLOCKED / DRAFT) escala y JAMÁS se reintenta;
//   - la ausencia de señal sigue frenando (default fail-closed);
//   - el reintento reevalúa los 6 gates, no sólo el PUT.
//
// Sin red ni gh real: todas las dependencias de `attemptMergeWithGates` se
// inyectan, incluido el sleep (si no, cada caso de polling costaría ~31 s).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Aislar REPO_ROOT (delivery escribe audit + cola Telegram centrales acá).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-delivery6012-'));
fs.mkdirSync(path.join(TMP, '.claude', 'hooks'), { recursive: true });
fs.mkdirSync(path.join(TMP, '.pipeline', 'logs'), { recursive: true });
process.env.PIPELINE_REPO_ROOT = TMP;
process.env.CLAUDE_PROJECT_DIR = TMP;

delete require.cache[require.resolve('../delivery')];
const delivery = require('../delivery');
const codeowners = require('../lib/codeowners');
const humanBlock = require('../../lib/human-block');

const TELEGRAM_QUEUE = path.join(TMP, '.pipeline', 'servicios', 'telegram', 'pendiente');

// ── Fakes ──────────────────────────────────────────────────────────────────

const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const HEAD_SHA_2 = 'ffeeddccbbaa00998877665544332211aabbccdd';

const NOT_MERGEABLE_405 = {
    exit_code: 1, stdout: '',
    stderr: 'gh: Pull Request is not mergeable (HTTP 405)',
};
const MERGED_OK = {
    exit_code: 0,
    stdout: JSON.stringify({ sha: 'merge-sha-123', merged: true, message: 'ok' }),
    stderr: '',
};

function snapshotOk(over = {}) {
    return {
        ok: true,
        labels: ['qa:skipped'],
        files: ['.pipeline/skills-deterministicos/delivery.js'],
        headRefOid: HEAD_SHA,
        headRefName: 'agent/6012-pipeline-dev',
        state: 'OPEN',
        mergeStateStatus: 'CLEAN',
        mergeable: 'MERGEABLE',
        ...over,
    };
}

// CODEOWNERS real del repo (subconjunto): `.github/` exige owner humano,
// `.pipeline/` NO. Se usa el loader REAL contra un `git show` fake.
const REMOTE_CODEOWNERS = [
    '# CODEOWNERS de origin/main',
    '/.github/        @leitolarreta',
    '/docs/           @writer-team',
].join('\n');

function ownersFromRemote(counter) {
    return () => {
        if (counter) counter.push('loadOwners');
        return codeowners.loadCodeownersFromRef('/worktree-podado', 'origin/main', {
            spawnImpl: (cmd, argv) => {
                const spec = argv[1] || '';
                const rel = spec.slice(spec.indexOf(':') + 1);
                if (rel !== '.github/CODEOWNERS') {
                    return { status: 128, stdout: '', stderr: `fatal: path '${rel}' does not exist` };
                }
                return { status: 0, stdout: REMOTE_CODEOWNERS, stderr: '' };
            },
        });
    };
}

function recordingMerge(responder, calls) {
    return (opts) => {
        calls.push(opts);
        return responder(opts, calls.length);
    };
}

// `sleepImpl` no-op que registra los delays pedidos: prueba que el backoff
// existe y es acotado, sin costar un solo milisegundo real.
function recordingSleep(delays) {
    return (ms) => { delays.push(ms); };
}

function baseDeps(over = {}) {
    return {
        prNumber: 777,
        getSnapshot: () => snapshotOk(),
        loadOwners: ownersFromRemote(),
        verifyOrigin: () => ({ ok: true, reason: 'author-allowlisted:bot@intrale.com' }),
        mergePR: () => MERGED_OK,
        logAppend: () => {},
        sleepImpl: () => {},
        ...over,
    };
}

// ── normalizeMergeState: enum cerrado, fail-closed a null (CA-1) ────────────

test('#6012 CA-1 — normalizeMergeState: valores del enum se conservan normalizados', () => {
    const n = delivery.normalizeMergeState({
        mergeStateStatus: 'unknown', state: 'open', mergeable: 'conflicting',
    });
    assert.equal(n.mergeStateStatus, 'UNKNOWN');
    assert.equal(n.state, 'OPEN');
    assert.equal(n.mergeable, 'CONFLICTING');
});

test('#6012 CA-1 — normalizeMergeState: fuera del enum o ausente ⇒ null, NUNCA "UNKNOWN"', () => {
    const casos = [
        ['objeto vacío', {}],
        ['undefined', undefined],
        ['null', null],
        ['valor inventado', { mergeStateStatus: 'CALCULANDO', state: 'ARCHIVED', mergeable: 'MAYBE' }],
        ['tipos no-string', { mergeStateStatus: 42, state: true, mergeable: {} }],
        ['string vacío', { mergeStateStatus: '   ', state: '', mergeable: '' }],
    ];
    for (const [nombre, entrada] of casos) {
        const n = delivery.normalizeMergeState(entrada);
        assert.equal(n.mergeStateStatus, null, `${nombre}: mergeStateStatus`);
        assert.equal(n.state, null, `${nombre}: state`);
        assert.equal(n.mergeable, null, `${nombre}: mergeable`);
        assert.notEqual(n.mergeStateStatus, 'UNKNOWN', `${nombre}: la ausencia NO se degrada a UNKNOWN`);
    }
});

// ── Matriz de clasificación del 405 (CA-5) ─────────────────────────────────

test('#6012 CA-5 — matriz completa del 405 por mergeStateStatus', () => {
    const esperado = [
        // estado,      kind,                   conflict, retryable, confirmed
        ['UNKNOWN', 'mergeability-unknown', false, true, false],
        ['DIRTY', 'not-mergeable', true, false, true],
        ['BLOCKED', 'gate-block', false, false, false],
        ['DRAFT', 'gate-block', false, false, false],
        ['CLEAN', 'not-mergeable', true, false, false],
        ['BEHIND', 'not-mergeable', true, false, false],
        ['UNSTABLE', 'not-mergeable', true, false, false],
    ];
    for (const [estado, kind, conflict, retryable, confirmed] of esperado) {
        const c = delivery.classifyMergeFailure(NOT_MERGEABLE_405, { mergeStateStatus: estado });
        assert.equal(c.kind, kind, `${estado}: kind`);
        assert.equal(c.conflict, conflict, `${estado}: conflict`);
        assert.equal(c.retryable, retryable, `${estado}: retryable`);
        assert.equal(c.confirmed, confirmed, `${estado}: confirmed`);
    }
});

test('#6012 CA-5 — BLOCKED y DRAFT traen el gate correcto para el operador', () => {
    assert.equal(
        delivery.classifyMergeFailure(NOT_MERGEABLE_405, { mergeStateStatus: 'BLOCKED' }).gate,
        'branch-protection',
    );
    assert.equal(
        delivery.classifyMergeFailure(NOT_MERGEABLE_405, { mergeStateStatus: 'DRAFT' }).gate,
        'pr-draft',
    );
});

test('#6012 CA-5 — el 409 NO se reclasifica como transitorio ni con UNKNOWN', () => {
    // La semántica canónica del 409 es "head branch was modified" y ya tiene su
    // propio camino (#5420). Reclasificarlo mezclaría dos defectos distintos.
    const c = delivery.classifyMergeFailure(
        { exit_code: 1, stderr: 'HTTP 409: Merge conflict' },
        { mergeStateStatus: 'UNKNOWN' },
    );
    assert.equal(c.kind, 'not-mergeable');
    assert.equal(c.retryable, false);
});

test('#6012 CA-5 — mergeable=MERGEABLE con branch protection NO habilita reintento', () => {
    // Este es el fail-open que evita clasificar por `mergeable` en vez de por
    // `mergeStateStatus`: con protección de rama frenando, `mergeable` vale
    // MERGEABLE. Clasificar por él mandaría un control activo a reintentos.
    const c = delivery.classifyMergeFailure(NOT_MERGEABLE_405, {
        mergeStateStatus: 'BLOCKED', mergeable: 'MERGEABLE',
    });
    assert.equal(c.retryable, false);
    assert.equal(c.kind, 'gate-block');
});

// ── Caso 1: 405 + UNKNOWN ⇒ espera, reintenta y mergea ──────────────────────

// Escenario Gherkin 1 del issue, punta a punta: PR recién creado, GitHub todavía
// calculando. El arreglo primario es la ESPERA PRE-MERGE (CA-2): el 405 ni
// siquiera llega a producirse, porque no se le pega a la API en la ventana ciega.
test('#6012 CA-2 — PR recién creado con UNKNOWN: espera, reevalúa y MERGEA sin escalar', () => {
    const calls = [];
    const delays = [];
    let snapN = 0;
    const out = delivery.attemptMergeWithGates(baseDeps({
        // 1er snapshot: GitHub calculando. 2do: ya resolvió.
        getSnapshot: () => {
            snapN++;
            return snapN === 1
                ? snapshotOk({ mergeStateStatus: 'UNKNOWN', mergeable: 'UNKNOWN' })
                : snapshotOk({ mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' });
        },
        mergePR: recordingMerge(() => MERGED_OK, calls),
        sleepImpl: recordingSleep(delays),
    }));
    assert.equal(out.status, 'merged');
    assert.equal(out.sha, 'merge-sha-123');
    assert.notEqual(out.status, 'conflict', 'un PR sano no puede terminar en conflicto');
    assert.equal(calls.length, 1, 'el PUT recién se dispara con el estado resuelto');
    assert.equal(delays.length, 1, 'hubo exactamente una espera');
    assert.ok(delays[0] > 0, 'la espera tiene backoff real (el sleep se inyecta en tests)');
    assert.equal(out.attempt, 1, 'la espera no consumió presupuesto de gates (CA-8)');
});

test('#6012 CA-2 — el backoff escala mientras el estado siga sin resolverse', () => {
    const calls = [];
    const delays = [];
    let snapN = 0;
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => {
            snapN++;
            return snapN <= 3 ? snapshotOk({ mergeStateStatus: 'UNKNOWN' }) : snapshotOk();
        },
        mergePR: recordingMerge(() => MERGED_OK, calls),
        sleepImpl: recordingSleep(delays),
    }));
    assert.equal(out.status, 'merged');
    assert.equal(calls.length, 1);
    assert.equal(delays.length, 3, 'una espera por cada snapshot en UNKNOWN');
    assert.deepEqual(delays, delivery.MERGEABILITY_BACKOFF_MS.slice(0, 3), 'backoff creciente y determinístico');
});

// La rama transitoria del CLASIFICADOR es la red de seguridad de la espera: se
// alcanza cuando el presupuesto se agotó y el PUT igual sale con el estado sin
// resolver. Lo que fija este test es que en ese borde el resultado NO es
// conflicto — que es exactamente el defecto que bloqueó a #6010 / #6011.
test('#6012 CA-5/CA-10 — 405 con UNKNOWN nunca se clasifica como conflicto, ni en el borde', () => {
    const c = delivery.classifyMergeFailure(NOT_MERGEABLE_405, { mergeStateStatus: 'UNKNOWN' });
    assert.equal(c.kind, 'mergeability-unknown');
    assert.equal(c.conflict, false);
    assert.equal(c.retryable, true);

    // Y punta a punta: presupuesto agotado + 405 con UNKNOWN ⇒ transitorio.
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({ mergeStateStatus: 'UNKNOWN' }),
        mergePR: () => NOT_MERGEABLE_405,
    }));
    assert.equal(out.status, 'transient');
    assert.equal(out.classification.kind, 'mergeability-unknown');
});

// ── Caso 2: 405 + DIRTY ⇒ conflicto confirmado, escala ──────────────────────

test('#6012 CA-5 — 405 con DIRTY: conflicto CONFIRMADO, escala sin reintentar', () => {
    const calls = [];
    const delays = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({ mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' }),
        mergePR: recordingMerge(() => NOT_MERGEABLE_405, calls),
        sleepImpl: recordingSleep(delays),
    }));
    assert.equal(out.status, 'conflict');
    assert.equal(out.classification.confirmed, true);
    assert.equal(calls.length, 1, 'un conflicto confirmado no se reintenta');
    assert.equal(delays.length, 0, 'no se espera por un estado ya resuelto');
});

// ── Caso 3: 405 + BLOCKED ⇒ gate-block, NUNCA reintenta (seguridad #7) ──────

test('#6012 CA-5/seguridad — 405 con BLOCKED: escala como gate-block y NO reintenta', () => {
    const calls = [];
    const delays = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({ mergeStateStatus: 'BLOCKED', mergeable: 'MERGEABLE' }),
        mergePR: recordingMerge(() => NOT_MERGEABLE_405, calls),
        sleepImpl: recordingSleep(delays),
    }));
    assert.equal(out.status, 'blocked');
    assert.equal(out.gate, 'branch-protection');
    assert.equal(calls.length, 1, 'un control de seguridad activo se intenta UNA vez y escala');
    assert.equal(delays.length, 0, 'no se espera: el estado ya está resuelto y es terminal');
});

test('#6012 CA-5 — 405 con DRAFT: escala como pr-draft sin reintentar', () => {
    const calls = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({ mergeStateStatus: 'DRAFT' }),
        mergePR: recordingMerge(() => NOT_MERGEABLE_405, calls),
    }));
    assert.equal(out.status, 'blocked');
    assert.equal(out.gate, 'pr-draft');
    assert.equal(calls.length, 1);
});

// ── Caso 4: UNKNOWN persistente ⇒ transitorio, NO escala (CA-10) ────────────

test('#6012 CA-10 — UNKNOWN persistente agota el backoff y da TRANSITORIO, no conflicto', () => {
    const calls = [];
    const delays = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        // El estado nunca se resuelve, y el PUT siempre responde 405.
        getSnapshot: () => snapshotOk({ mergeStateStatus: 'UNKNOWN', mergeable: 'UNKNOWN' }),
        mergePR: recordingMerge(() => NOT_MERGEABLE_405, calls),
        sleepImpl: recordingSleep(delays),
    }));
    assert.equal(out.status, 'transient');
    assert.notEqual(out.status, 'conflict', 'un timeout de polling NUNCA es conflicto');
    assert.equal(out.waits, delivery.MAX_MERGEABILITY_WAITS);
    assert.equal(delays.length, delivery.MAX_MERGEABILITY_WAITS, 'el backoff está acotado');
});

test('#6012 CA-8 — el polling NO consume el presupuesto de MAX_MERGE_ATTEMPTS', () => {
    const delays = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({ mergeStateStatus: 'UNKNOWN' }),
        mergePR: () => NOT_MERGEABLE_405,
        sleepImpl: recordingSleep(delays),
    }));
    assert.equal(out.status, 'transient');
    // El reintento de `head-changed` queda intacto: se consumió el presupuesto
    // de esperas, no el de gates.
    assert.ok(
        out.attempt <= delivery.MAX_MERGE_ATTEMPTS,
        `attempt (${out.attempt}) no puede exceder MAX_MERGE_ATTEMPTS`,
    );
    assert.equal(out.waits, delivery.MAX_MERGEABILITY_WAITS);
});

test('#6012 — el backoff es acotado y suma ~31 s de techo TOTAL por invocación', () => {
    const total = delivery.MERGEABILITY_BACKOFF_MS
        .slice(0, delivery.MAX_MERGEABILITY_WAITS)
        .reduce((a, b) => a + b, 0);
    assert.ok(total <= 35_000, `el techo del backoff (${total}ms) debe quedar bajo el timeout del PUT`);
    assert.equal(delivery.MERGEABILITY_BACKOFF_MS.length, delivery.MAX_MERGEABILITY_WAITS);
});

// ── TERMINACIÓN: el `attempt--` no puede volverse loop infinito ─────────────

test('#6012 — el loop TERMINA: número exacto de snapshots acotado por ambos presupuestos', () => {
    let snaps = 0;
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => { snaps++; return snapshotOk({ mergeStateStatus: 'UNKNOWN' }); },
        mergePR: () => NOT_MERGEABLE_405,
    }));
    assert.equal(out.status, 'transient');
    // 6 vueltas que esperan (la espera pre-merge dispara antes que el PUT) + la
    // vuelta final que llega al PUT, clasifica y retorna transitorio.
    assert.equal(snaps, delivery.MAX_MERGEABILITY_WAITS + 1);
    assert.ok(
        snaps <= delivery.MAX_MERGEABILITY_WAITS + delivery.MAX_MERGE_ATTEMPTS,
        'techo duro de vueltas = maxWaits + attemptsMax',
    );
});

// ── Caso 5: merge-tree limpio NO reclasifica por sí solo (CA-7) ─────────────

test('#6012 CA-7 — merge-tree limpio + 405 sin estado sigue siendo conflicto terminal', () => {
    const calls = [];
    const logs = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        // Sin `mergeStateStatus`: el servidor no dio señal.
        getSnapshot: () => snapshotOk({ mergeStateStatus: null, mergeable: null }),
        mergePR: recordingMerge(() => NOT_MERGEABLE_405, calls),
        mergeTreeClean: true,
        logAppend: (m) => logs.push(m),
    }));
    assert.equal(out.status, 'conflict', 'el pre-check LOCAL no le gana a la señal del servidor');
    assert.equal(out.classification.confirmed, false);
    assert.equal(calls.length, 1, 'merge-tree limpio no habilita reintentos');
    // Pero la contradicción SÍ queda registrada (punto 3 del issue).
    assert.ok(
        logs.some((l) => /contradicci[oó]n/i.test(l) && /merge-tree/i.test(l)),
        'la contradicción entre merge-tree y la API se loguea',
    );
});

// ── Caso 6: state=MERGED durante el polling ⇒ éxito idempotente (CA-3) ──────

test('#6012 CA-3 — un PR ya MERGED corta el polling: éxito idempotente, PUT nunca se invoca', () => {
    const calls = [];
    const delays = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        // Reproduce lo verificado sobre #6010/#6011: MERGED con ambos campos en
        // UNKNOWN. Sin el corte por `state`, el polling se comería el backoff
        // entero esperando un estado que ya nunca va a resolverse.
        getSnapshot: () => snapshotOk({ state: 'MERGED', mergeStateStatus: 'UNKNOWN', mergeable: 'UNKNOWN' }),
        mergePR: recordingMerge(() => MERGED_OK, calls),
        sleepImpl: recordingSleep(delays),
    }));
    assert.equal(out.status, 'merged');
    assert.equal(out.idempotent, true);
    assert.equal(calls.length, 0, 'no se re-mergea un PR ya mergeado');
    assert.equal(delays.length, 0, 'no se gasta el backoff contra un PR ya resuelto');
});

test('#6012 CA-3 — un PR CLOSED bloquea, no se lo trata como transitorio', () => {
    const calls = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({ state: 'CLOSED', mergeStateStatus: 'UNKNOWN' }),
        mergePR: recordingMerge(() => MERGED_OK, calls),
    }));
    assert.equal(out.status, 'blocked');
    assert.equal(out.gate, 'pr-closed');
    assert.equal(calls.length, 0);
});

// ── Caso 7: el reintento reevalúa los 6 gates (BLOQUEANTE de seguridad) ─────

test('#6012 CA-6/seguridad — el reintento del 405 REEVALÚA los 6 gates, no sólo el PUT', () => {
    // Este es el hallazgo ALTO de security (OWASP A08): si el reintento fuera un
    // bucle local alrededor de mergePR, se mergearía a `main` con un veredicto de
    // QA y un CODEOWNERS leídos ~30 s antes. Se assertea sobre las llamadas a
    // getSnapshot / loadOwners / verifyOrigin, no sólo sobre mergePR.
    const orden = [];
    const calls = [];
    let snapN = 0;
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => {
            orden.push('getSnapshot');
            snapN++;
            // Durante la espera el head se movió: el snapshot nuevo trae otro SHA.
            return snapN === 1
                ? snapshotOk({ mergeStateStatus: 'UNKNOWN' })
                : snapshotOk({ mergeStateStatus: 'CLEAN', headRefOid: HEAD_SHA_2 });
        },
        loadOwners: ownersFromRemote(orden),
        verifyOrigin: () => {
            orden.push('verifyOrigin');
            return { ok: true, reason: 'author-allowlisted:bot@intrale.com' };
        },
        mergePR: recordingMerge(() => { orden.push('mergePR'); return MERGED_OK; }, calls),
    }));
    assert.equal(out.status, 'merged');
    assert.equal(orden.filter((o) => o === 'getSnapshot').length, 2, 'snapshot fresco tras la espera');
    assert.equal(orden.filter((o) => o === 'loadOwners').length, 2, 'CODEOWNERS se relee tras la espera');
    assert.equal(orden.filter((o) => o === 'verifyOrigin').length, 2, 'procedencia se reverifica tras la espera');
    // El orden importa: los gates se reevalúan ANTES del PUT, no después.
    assert.equal(orden[orden.length - 1], 'mergePR', 'el PUT es siempre el último paso del intento');
    // Y el PUT viaja con el SHA del snapshot VIGENTE, no con el previo a la espera
    // (requisito de seguridad #2: nunca se mergea un árbol que no pasó los gates).
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sha, HEAD_SHA_2, 'el PUT pinnea el SHA nuevo, no el de antes de la espera');
});

test('#6012 CA-6 — si los gates se ponen en rojo durante la espera, el reintento NO mergea', () => {
    // Corolario del anterior: la reevaluación tiene que poder FRENAR. Si entre la
    // espera y el reintento alguien saca el label de QA, el merge no ocurre.
    const calls = [];
    let snapN = 0;
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => {
            snapN++;
            return snapN === 1
                ? snapshotOk({ mergeStateStatus: 'UNKNOWN' })
                : snapshotOk({ mergeStateStatus: 'CLEAN', labels: ['Ready'] });
        },
        mergePR: recordingMerge(() => MERGED_OK, calls),
    }));
    assert.equal(out.status, 'no-qa-gate', 'el gate de QA revocado durante la espera frena el merge');
    assert.equal(calls.length, 0, 'nunca se llegó al PUT');
});

// ── CA-UX-3: nada de Telegram mientras el pipeline se destraba solo ─────────

test('#6012 CA-UX-3 — el camino transitorio NO encola ningún mensaje de Telegram', () => {
    // La cola de Telegram es unidireccional y no existe retractación: una alerta
    // emitida de más queda para siempre y erosiona el canal que frena merges.
    fs.rmSync(TELEGRAM_QUEUE, { recursive: true, force: true });
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({ mergeStateStatus: 'UNKNOWN' }),
        mergePR: () => NOT_MERGEABLE_405,
    }));
    assert.equal(out.status, 'transient');
    const encolados = fs.existsSync(TELEGRAM_QUEUE) ? fs.readdirSync(TELEGRAM_QUEUE) : [];
    assert.equal(encolados.length, 0, 'durante el polling el operador no recibe nada');
});

// ── CA-UX-4: el motivo transitorio NO se enruta como bloqueo humano ─────────

test('#6012 CA-UX-4 — el motivo transitorio NO matchea HUMAN_BLOCK_PATTERNS', () => {
    // Si matcheara, el pulpo lo enrutaría como bloqueo humano y reintroduciría
    // exactamente el `needs-human` que este issue elimina.
    const motivo = delivery.buildTransientMergeMotivo({ prNumber: 6010, waits: 6 });
    assert.equal(
        humanBlock.isHumanBlockReason(motivo), false,
        `el motivo transitorio no puede clasificar como bloqueo humano: ${motivo}`,
    );
});

test('#6012 CA-UX-4 — el motivo transitorio no usa el vocabulario de "andá a mirar"', () => {
    const motivo = delivery.buildTransientMergeMotivo({ prNumber: 6010, waits: 6 });
    for (const prohibido of [/conflicto/i, /\bREAL\b/, /intervenci[oó]n humana/i, /needs[-_ ]?human/i]) {
        assert.ok(!prohibido.test(motivo), `el motivo no debe contener ${prohibido}: ${motivo}`);
    }
    // Y sí dice lo que el operador necesita: que es transitorio y sin defecto de dev.
    assert.match(motivo, /transitorio/i);
    assert.match(motivo, /sin cambios de c[oó]digo|defecto de dev/i);
});

// ── CA-9 / CA-UX-1: los textos al operador dicen la verdad ─────────────────

test('#6012 CA-UX-1 — sin conflicto confirmado, el motivo NO afirma "conflicto de merge REAL"', () => {
    const sinConfirmar = delivery.buildConflictMotivo({ prNumber: 6010, branch: 'agent/6012-x', httpStatus: 405 });
    assert.ok(!/conflicto de merge REAL/i.test(sinConfirmar), sinConfirmar);
    // Pero SIGUE frenando: tiene que enrutarse como bloqueo humano igual.
    assert.equal(humanBlock.isHumanBlockReason(sinConfirmar), true, 'el fail-closed no se relaja');
});

test('#6012 CA-UX-1 — con DIRTY confirmado, el motivo sí afirma el conflicto real', () => {
    const confirmado = delivery.buildConflictMotivo({
        prNumber: 6010, branch: 'agent/6012-x', httpStatus: 405, confirmed: true,
    });
    assert.match(confirmado, /Conflicto de merge REAL/i);
    assert.equal(humanBlock.isHumanBlockReason(confirmado), true);
});

test('#6012 CA-UX-1 — el Telegram sin confirmar no dice "GENUINO" ni manda a resolver un conflicto', () => {
    const msg = delivery.buildMergeConflictEscalation({
        issue: 6012, prNumber: 6010, branch: 'agent/6012-x', httpStatus: 405,
    });
    assert.ok(!/GENUINO/i.test(msg), msg);
    assert.ok(!/resolv[eé]s el conflicto/i.test(msg), msg);
    // Se conserva el tono fail-closed de #4632/#4658.
    assert.match(msg, /main` quedó INTACTO/);
    assert.match(msg, /abortar/);
});

test('#6012 CA-UX-2 — los estados nuevos tienen etiqueta propia para el operador', () => {
    for (const gate of ['branch-protection', 'pr-draft', 'pr-closed']) {
        assert.ok(delivery.GATE_BLOCK_LABELS[gate], `falta etiqueta de ${gate}`);
    }
    // El camino de gate-block ya dice lo correcto: "No es un conflicto de merge".
    const msg = delivery.buildGateBlockEscalation({
        issue: 6012, prNumber: 6010, branch: 'agent/6012-x', gate: 'branch-protection',
    });
    assert.match(msg, /No es un conflicto de merge/i);
    assert.match(msg, /protecci[oó]n de rama/i);
});

// ── Degradación: un `gh` que no conoce los campos no rompe TODA la entrega ──

test('#6012 — gh sin soporte de los campos nuevos degrada a legacy, no bloquea la entrega', () => {
    // Riesgo ALTO del arquitecto: sin este fallback, un gh viejo dejaría TODA
    // entrega bloqueada (no sólo el caso del 405).
    const argvs = [];
    const snap = delivery.getPRSnapshot(777, {
        ghImpl: (argv) => {
            argvs.push(argv[4]);
            if (/mergeStateStatus/.test(argv[4])) {
                return { exit_code: 1, stdout: '', stderr: 'Unknown JSON field: "mergeStateStatus"' };
            }
            return {
                exit_code: 0,
                stdout: JSON.stringify({
                    labels: [{ name: 'qa:skipped' }],
                    files: [{ path: '.pipeline/pulpo.js' }],
                    headRefOid: HEAD_SHA,
                    headRefName: 'agent/6012-pipeline-dev',
                }),
                stderr: '',
            };
        },
        cwd: '/w',
    });
    assert.equal(snap.ok, true, 'la entrega sigue funcionando con un gh viejo');
    assert.equal(argvs.length, 2, 'reintenta una vez con el set legacy');
    assert.equal(argvs[1], 'labels,files,headRefOid,headRefName');
    // Y los 3 campos quedan en null ⇒ default fail-closed = comportamiento previo.
    assert.equal(snap.mergeStateStatus, null);
    assert.equal(
        delivery.classifyMergeFailure(NOT_MERGEABLE_405, { mergeStateStatus: snap.mergeStateStatus }).retryable,
        false,
        'con gh degradado el 405 vuelve a ser terminal, nunca transitorio',
    );
});

test('#6012 — un error de gh que NO es "unknown field" no dispara el fallback', () => {
    const argvs = [];
    const snap = delivery.getPRSnapshot(777, {
        ghImpl: (argv) => {
            argvs.push(argv[4]);
            return { exit_code: 1, stdout: '', stderr: 'HTTP 502 Bad Gateway' };
        },
        cwd: '/w',
    });
    assert.equal(snap.ok, false, 'un 502 sigue siendo lectura degradada ⇒ fail-closed');
    assert.equal(argvs.length, 1, 'no se reintenta a ciegas ante cualquier error');
});
