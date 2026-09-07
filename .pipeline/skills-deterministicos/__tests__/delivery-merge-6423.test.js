// #6431 (split de #6423) — El 405 por un check requerido que TODAVÍA NO REPORTÓ
// dejó de ser un bloqueo humano.
//
// Qué defecto fija esta suite. GitHub responde `HTTP 405` + `BLOCKED` tanto
// cuando un control se ejerce de verdad (review faltante, check en rojo) como
// cuando el check obligatorio todavía está por reportar. Delivery no los
// separaba y mandaba los dos a `needs-human`. Episodio del 2026-08-24: PR #6416
// creado a 01:45:02Z, check requerido verde a 01:45:21Z (t+19 s), mergeado a
// mano a 10:50:59Z — 9 h 05 m de bloqueo humano por una carrera de 19 segundos.
//
// Lo que esta suite tiene que impedir es que el arreglo se pase de rosca. El
// camino transitorio es el ÚNICO que se relaja, y sólo con evidencia positiva:
//   - review faltante o no leída  ⇒ escala, aunque haya checks pendientes;
//   - check requerido en rojo     ⇒ escala;
//   - TODOS los requeridos verdes ⇒ escala (hay otro control ejerciéndose);
//   - ruleset ilegible            ⇒ escala (fail-closed verdadero);
//   - homónimo de otra app        ⇒ escala (no satisface el requerido).
//
// Y tiene que impedir dos formas de que el fix sea un no-op silencioso:
//   - que producción no inyecte el lector (A-2 sin wiring = footgun mudo);
//   - que el copy del camino transitorio matchee `HUMAN_BLOCK_PATTERNS` y
//     reintroduzca el `needs-human` (A-R7: UX verificó CINCO redacciones
//     naturales del mismo hecho que lo hacen).
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-delivery6423-'));
fs.mkdirSync(path.join(TMP, '.claude', 'hooks'), { recursive: true });
fs.mkdirSync(path.join(TMP, '.pipeline', 'logs'), { recursive: true });
process.env.PIPELINE_REPO_ROOT = TMP;
process.env.CLAUDE_PROJECT_DIR = TMP;

delete require.cache[require.resolve('../delivery')];
const delivery = require('../delivery');
const humanBlock = require('../../lib/human-block');

const TELEGRAM_QUEUE = path.join(TMP, '.pipeline', 'servicios', 'telegram', 'pendiente');

// ── Fakes ──────────────────────────────────────────────────────────────────

const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

const NOT_MERGEABLE_405 = {
    exit_code: 1, stdout: '',
    stderr: 'gh: Pull Request is not mergeable (HTTP 405)',
};
const MERGED_OK = {
    exit_code: 0,
    stdout: JSON.stringify({ sha: 'merge-sha-123', merged: true }),
    stderr: '',
};

function snapshotOk(over = {}) {
    return {
        ok: true,
        labels: ['qa:skipped'],
        files: ['.pipeline/skills-deterministicos/delivery.js'],
        headRefOid: HEAD_SHA,
        headRefName: 'agent/6431-pipeline-dev',
        state: 'OPEN',
        mergeStateStatus: 'BLOCKED',
        mergeable: 'MERGEABLE',
        // Rollup leído y VACÍO — la ventana ciega exacta del episodio.
        statusCheckRollup: [],
        reviewDecision: null,
        reviewDecisionRead: true,
        snapshotFieldsLevel: 1,
        ...over,
    };
}

// Lector fake: devuelve el veredicto que le pidan, contando invocaciones.
function readerFake(veredictos, calls = []) {
    const cola = Array.isArray(veredictos) ? [...veredictos] : [veredictos];
    return (args) => {
        calls.push(args);
        const v = cola.length > 1 ? cola.shift() : cola[0];
        return { pending: [], failing: [], green: [], logLines: [], ...v };
    };
}

function baseDeps(over = {}) {
    return {
        prNumber: 6416,
        getSnapshot: () => snapshotOk(),
        loadOwners: () => ({ ok: true, rules: [] }),
        verifyOrigin: () => ({ ok: true }),
        mergePR: () => NOT_MERGEABLE_405,
        sleepImpl: () => {},
        ...over,
    };
}

// ── CA-1 / CA-2: el caso del episodio ──────────────────────────────────────

test('#6431 CA-1/CA-2 — 405 BLOCKED con un requerido AUSENTE espera y reintenta, sin needs-human', () => {
    const sleeps = [];
    const gateCalls = [];
    let lecturas = 0;
    const merges = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => { gateCalls.push('snapshot'); return snapshotOk(); },
        loadOwners: () => { gateCalls.push('owners'); return { ok: true, rules: [] }; },
        verifyOrigin: () => { gateCalls.push('origin'); return { ok: true }; },
        mergePR: () => { merges.push(1); return MERGED_OK; },
        // El check tarda 19 s en reportar (como en el episodio) y a la 3ª
        // lectura ya está verde.
        requiredChecksReader: () => {
            lecturas++;
            return lecturas < 3
                ? { verdict: 'pending', pending: ['pr-status'], logLines: [] }
                : { verdict: 'green', green: ['pr-status'], logLines: [] };
        },
        sleepImpl: (ms) => sleeps.push(ms),
    }));
    assert.equal(out.status, 'merged', 'la carrera con la CI se resuelve sola, no escala');
    assert.notEqual(out.status, 'needs-human');
    // Backoff nuevo: arranca corto porque el episodio se resolvía en 19 s. Con
    // el backoff viejo ([15s, 30s, 60s]) la primera espera sola ya se pasaba.
    assert.deepEqual(sleeps, [2000, 4000]);
    assert.equal(merges.length, 1, 'sólo se pega a la API de merge cuando hay chance real');
    // CA-14 — cada reintento reevalúa los 6 gates sobre snapshot FRESCO: nunca
    // se mergea con un veredicto de QA/CODEOWNERS leído 30 s antes.
    const snaps = gateCalls.filter((c) => c === 'snapshot').length;
    assert.equal(snaps, 3);
    assert.equal(gateCalls.filter((c) => c === 'owners').length, snaps);
    assert.equal(gateCalls.filter((c) => c === 'origin').length, snaps);
});

test('#6431 — camino POST-405: con rollup poblado el pre-check no corre y la espera sale del 405', () => {
    // El pre-check sólo cubre la ventana ciega (rollup []). Con el rollup ya
    // poblado, la carrera se detecta igual — a costa de un 405 extra.
    const sleeps = [];
    const merges = [];
    let lecturas = 0;
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({
            statusCheckRollup: [{ name: 'otro-check', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        }),
        mergePR: () => { merges.push(1); return merges.length >= 2 ? MERGED_OK : NOT_MERGEABLE_405; },
        requiredChecksReader: () => {
            lecturas++;
            return lecturas === 1
                ? { verdict: 'pending', pending: ['pr-status'], logLines: [] }
                : { verdict: 'green', green: ['pr-status'], logLines: [] };
        },
        sleepImpl: (ms) => sleeps.push(ms),
    }));
    assert.equal(out.status, 'merged');
    assert.equal(merges.length, 2, 'un 405 y después el merge');
    assert.deepEqual(sleeps, [2000]);
});

test('#6431 A-3 — el pre-check dispara con rollup [] y demora ANTES del PUT', () => {
    const merges = [];
    let leidas = 0;
    const out = delivery.attemptMergeWithGates(baseDeps({
        mergePR: () => { merges.push(1); return MERGED_OK; },
        requiredChecksReader: () => {
            leidas++;
            // 1ª lectura: pendiente ⇒ espera. 2ª: verde ⇒ cae al PUT.
            return leidas === 1
                ? { verdict: 'pending', pending: ['pr-status'], logLines: [] }
                : { verdict: 'green', pending: [], logLines: [] };
        },
    }));
    assert.equal(out.status, 'merged');
    assert.equal(merges.length, 1, 'el pre-check evitó un PUT que habría dado 405');
});

test('#6431 D3 — el pre-check NUNCA bloquea: cualquier veredicto que no sea pending cae al PUT', () => {
    for (const verdict of ['green', 'blocking', 'unusable']) {
        const merges = [];
        delivery.attemptMergeWithGates(baseDeps({
            mergePR: () => { merges.push(1); return MERGED_OK; },
            requiredChecksReader: readerFake({ verdict }),
        }));
        assert.equal(merges.length, 1, `con veredicto ${verdict} el PUT tiene que dispararse igual`);
    }
});

test('#6431 A-3 — con rollup POBLADO el pre-check no dispara (se preserva la secuencia de #6384)', () => {
    const calls = [];
    delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({ statusCheckRollup: [{ name: 'pr-status', status: 'QUEUED' }] }),
        mergePR: () => MERGED_OK,
        requiredChecksReader: readerFake({ verdict: 'pending', pending: ['pr-status'] }, calls),
    }));
    assert.equal(calls.length, 0, 'el pre-check sólo mira la ventana ciega (rollup [])');
});

test('#6431 CA-11 — el reader recibe el headRefOid PINNEADO del snapshot vigente', () => {
    const calls = [];
    delivery.attemptMergeWithGates(baseDeps({
        mergePR: () => MERGED_OK,
        requiredChecksReader: readerFake({ verdict: 'green' }, calls),
    }));
    assert.equal(calls[0].headRefOid, HEAD_SHA, 'nunca `main` ni un ref simbólico');
    assert.equal(calls[0].prNumber, 6416);
});

// ── CA-3 / CA-4 / CA-5: lo que NO se relaja ────────────────────────────────

test('#6431 CA-3 — un requerido en ROJO escala sin reintentos', () => {
    const sleeps = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        requiredChecksReader: readerFake({ verdict: 'blocking', failing: ['pr-status'] }),
        sleepImpl: (ms) => sleeps.push(ms),
    }));
    assert.equal(out.status, 'blocked');
    assert.equal(out.gate, 'branch-protection-checks-red');
    assert.equal(sleeps.length, 0, 'esperar no va a poner un check rojo en verde');
});

test('#6431 CA-4 — REVIEW_REQUIRED gana sobre checks pendientes', () => {
    for (const reviewDecision of ['REVIEW_REQUIRED', 'CHANGES_REQUESTED']) {
        const out = delivery.attemptMergeWithGates(baseDeps({
            getSnapshot: () => snapshotOk({ reviewDecision, reviewDecisionRead: true }),
            requiredChecksReader: readerFake({ verdict: 'pending', pending: ['pr-status'] }),
        }));
        assert.equal(out.status, 'blocked', reviewDecision);
        assert.equal(out.gate, 'branch-protection-review',
            'una review faltante no aparece por esperar a la CI');
    }
});

test('#6431 CA-5 — TODOS los requeridos verdes + BLOCKED es gate-block, jamás transitorio', () => {
    // Hay tres controles activos en `main` que no dejan rastro en `pr-status`:
    // hilo de review sin resolver, commit sin atribuir y revisión de Copilot.
    const out = delivery.attemptMergeWithGates(baseDeps({
        requiredChecksReader: readerFake({ verdict: 'green', green: ['pr-status'] }),
    }));
    assert.equal(out.status, 'blocked');
    assert.equal(out.gate, 'branch-protection-other');
});

test('#6431 SEC-1/CA-6 — un ruleset ilegible es gate-block (fail-closed verdadero)', () => {
    const out = delivery.attemptMergeWithGates(baseDeps({
        requiredChecksReader: readerFake({ verdict: 'unusable', cause: 'ruleset-sin-requeridos' }),
    }));
    assert.equal(out.status, 'blocked');
    assert.equal(out.gate, 'branch-protection-unreadable');
    assert.match(out.reason, /ruleset-sin-requeridos/, 'la causa viaja: la degradación no es muda');
});

test('#6431 — un lector que EXPLOTA o devuelve basura es unusable, nunca relaja el gate', () => {
    for (const reader of [() => { throw new Error('boom'); }, () => null, () => ({ nope: 1 })]) {
        const out = delivery.attemptMergeWithGates(baseDeps({ requiredChecksReader: reader }));
        assert.equal(out.status, 'blocked');
        assert.equal(out.gate, 'branch-protection-unreadable');
    }
});

// ── A-R2: una sola máquina por decisión ────────────────────────────────────

test('#6431 A-R2/G3 — con rollup poblado manda el reader, NO classifyChecks', () => {
    // Sin esto, `classifyChecks` cortaría antes al ver el rollup verde y el
    // cotejo de app (SEC-2, el control entero) se saltearía. El rollup dice
    // "verde"; el reader dice "homónimo de otra app" ⇒ tiene que escalar.
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({
            statusCheckRollup: [{ name: 'pr-status', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        }),
        requiredChecksReader: readerFake({ verdict: 'unusable', cause: 'homonimo-sin-app-coincidente' }),
    }));
    assert.equal(out.gate, 'branch-protection-unreadable');
    assert.match(out.reason, /homonimo-sin-app-coincidente/);
});

// ── D-E / A-R12: la review por FLAG, nunca por valor ───────────────────────

test('#6431 D-E — reviewDecision "" o null con reviewDecisionRead:true NO bloquea', () => {
    for (const reviewDecision of ['', null, undefined, 'APPROVED']) {
        const out = delivery.attemptMergeWithGates(baseDeps({
            getSnapshot: () => snapshotOk({ reviewDecision, reviewDecisionRead: true }),
            requiredChecksReader: readerFake({ verdict: 'pending', pending: ['pr-status'] }),
            maxChecksWaits: 1,
        }));
        assert.equal(out.status, 'transient', JSON.stringify(reviewDecision));
    }
});

test('#6431 A-R12 — reviewDecision NO LEÍDA (escalera degradada) fuerza gate-block', () => {
    // Éste es el test que atrapa el no-op de D-E: si la distinción leído/no-leído
    // se codificara en el VALOR (`null`), un "faltan aprobaciones" real se
    // reportaría como carrera de CI.
    for (const nivel of [2, 3]) {
        const out = delivery.attemptMergeWithGates(baseDeps({
            getSnapshot: () => snapshotOk({
                reviewDecision: null, reviewDecisionRead: false, snapshotFieldsLevel: nivel,
            }),
            requiredChecksReader: readerFake({ verdict: 'pending', pending: ['pr-status'] }),
        }));
        assert.equal(out.status, 'blocked', `nivel ${nivel}`);
        assert.equal(out.gate, 'branch-protection-unreadable');
        assert.match(out.reason, /review_no_leida/);
    }
});

// ── CA-15 / CA-16 / D-D: los presupuestos ──────────────────────────────────

test('#6431 CA-16 — MAX_CHECKS_WAITS agotado da transient, NO un bloqueo humano', () => {
    const sleeps = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        requiredChecksReader: readerFake({ verdict: 'pending', pending: ['pr-status'] }),
        sleepImpl: (ms) => sleeps.push(ms),
    }));
    assert.equal(out.status, 'transient');
    assert.equal(out.causa, 'checks-pending');
    assert.equal(out.checksWaits, delivery.MAX_CHECKS_WAITS);
    assert.notEqual(out.status, 'needs-human');
    assert.notEqual(out.gate, 'checks-timeout');
    // Backoff completo: Σ ≈ 104 s.
    assert.deepEqual(sleeps, [2000, 4000, 8000, 15000, 15000, 30000, 30000]);
    assert.equal(sleeps.reduce((a, b) => a + b, 0), 104000);
});

test('#6431 CA-15 — con mergeChecksTimeoutMs Infinity el loop TERMINA igual (por el contador)', () => {
    // La terminación no puede depender del wall-clock.
    const out = delivery.attemptMergeWithGates(baseDeps({
        requiredChecksReader: readerFake({ verdict: 'pending', pending: ['pr-status'] }),
        mergeChecksTimeoutMs: Infinity,
    }));
    assert.equal(out.status, 'transient');
    assert.equal(out.checksWaits, delivery.MAX_CHECKS_WAITS);
});

test('#6431 D-D — wall-clock agotado con el contador SIN agotar sigue dando checks-timeout (#6384 intacto)', () => {
    const out = delivery.attemptMergeWithGates(baseDeps({
        requiredChecksReader: readerFake({ verdict: 'pending', pending: ['pr-status'] }),
        mergeChecksTimeoutMs: 20,
        maxChecksWaits: 7,
    }));
    assert.equal(out.status, 'blocked');
    assert.equal(out.gate, 'checks-timeout');
    assert.equal(out.checksWaitedMs, 20);
});

test('#6431 CA-15 — los 4 presupuestos son independientes y ninguno consume al otro', () => {
    assert.equal(delivery.MAX_MERGE_ATTEMPTS, 2);
    assert.equal(delivery.MAX_MERGEABILITY_WAITS, 6);
    assert.equal(delivery.MAX_CHECKS_WAITS, 7);
    assert.equal(delivery.CHECKS_BACKOFF_MS.length, delivery.MAX_CHECKS_WAITS,
        'un backoff más corto que el contador repetiría el último valor en silencio');
    // La espera por checks no puede comerse el reintento de head-changed.
    const out = delivery.attemptMergeWithGates(baseDeps({
        requiredChecksReader: readerFake({ verdict: 'pending', pending: ['pr-status'] }),
    }));
    assert.equal(out.attempt <= delivery.MAX_MERGE_ATTEMPTS, true);
});

// ── C6 / CA-UX-4: silencio deliberado ──────────────────────────────────────

test('#6431 CA-UX-4/C6 — el camino transitorio no encola NADA a Telegram', () => {
    fs.rmSync(TELEGRAM_QUEUE, { recursive: true, force: true });
    const out = delivery.attemptMergeWithGates(baseDeps({
        requiredChecksReader: readerFake({ verdict: 'pending', pending: ['pr-status'] }),
    }));
    assert.equal(out.status, 'transient');
    const encolados = fs.existsSync(TELEGRAM_QUEUE) ? fs.readdirSync(TELEGRAM_QUEUE) : [];
    assert.equal(encolados.length, 0,
        'no se notifica un evento sobre el que el operador no puede hacer nada y que se resuelve solo');
});

// ── CA-UX-1 / A-R7: el copy es lo que decide si vuelve el needs-human ───────

test('#6431 CA-UX-1 — el motivo transitorio de checks NO matchea HUMAN_BLOCK_PATTERNS', () => {
    const motivo = delivery.buildTransientMergeMotivo({
        prNumber: 6416, waits: 7, causa: 'checks-pending', pendientes: ['pr-status'],
    });
    assert.equal(humanBlock.isHumanBlockReason(motivo), false,
        `si matcheara, el pulpo lo enrutaría como bloqueo humano: ${motivo}`);
    // CA-19 — nombra los contextos pendientes y las esperas.
    assert.match(motivo, /pr-status/);
    assert.match(motivo, /7 esperas/);
    // Y suena a la misma familia que `mergeability-unknown` (el dev no busca un bug suyo).
    assert.match(motivo, /No hay defecto de dev/);
    assert.match(motivo, /sin cambios de código/);
});

test('#6431 A-R7 — las CINCO trampas de UX (V3) SÍ matchean: por eso el copy va cerrado', () => {
    // Redacciones espontáneas del MISMO hecho, verificadas por UX sobre el HEAD
    // real. Cualquiera de ellas reintroduce el `needs-human` que el issue
    // elimina. Están acá como casos negativos explícitos para que nadie
    // "mejore" el copy sin darse cuenta.
    const trampas = [
        'El ruleset de main exige un check que todavía no reportó y frena el merge.',
        'Merge bloqueado temporalmente en PR #6416 por un check que sigue corriendo.',
        'PR #6416 pendiente de que el check requerido reporte para completar el merge.',
        'Se espera la review manual requerida por el check.',
        'El check aún no reportó y requiere intervención humana.',
    ];
    for (const t of trampas) {
        assert.equal(humanBlock.isHumanBlockReason(t), true,
            `esta redacción es una trampa conocida y debe seguir siendo detectada: ${t}`);
    }
    // Y el copy real NO usa ninguno de esos giros.
    const motivo = delivery.buildTransientMergeMotivo({
        prNumber: 6416, waits: 7, causa: 'checks-pending', pendientes: ['pr-status'],
    });
    for (const prohibido of [/merge bloqueado/i, /intervenci[oó]n humana/i, /review manual/i,
                             /ruleset\s+de\s+main/i, /conflicto/i]) {
        assert.doesNotMatch(motivo, prohibido, `el copy no puede usar ${prohibido}`);
    }
});

test('#6431 — sin causa, buildTransientMergeMotivo devuelve el texto de #6012 intacto', () => {
    const viejo = delivery.buildTransientMergeMotivo({ prNumber: 6010, waits: 6 });
    assert.match(viejo, /mergeStateStatus siguió en UNKNOWN/);
    assert.match(viejo, /~31 s/);
    assert.equal(humanBlock.isHumanBlockReason(viejo), false);
});

test('#6431 CA-UX-1 — los 4 gate-block de branch-protection SÍ siguen matcheando', () => {
    for (const gate of ['branch-protection-checks-red', 'branch-protection-review',
                        'branch-protection-other', 'branch-protection-unreadable']) {
        const motivo = delivery.buildGateBlockMotivo({ prNumber: 6416, gate, reason: 'x' });
        assert.equal(humanBlock.isHumanBlockReason(motivo), true,
            `un control ejerciéndose DEBE escalar: ${gate}`);
    }
});

test('#6431 CA-UX-2 — GATE_BLOCK_LABELS nombra UN control y nunca devuelve undefined', () => {
    const emitibles = [
        'snapshot', 'codeowners', 'provenance', 'merge-unconfirmed', 'retry-exhausted',
        'qa-gate', 'codeowners-human', 'checks-failing', 'checks-timeout', 'pr-draft', 'pr-closed',
        'branch-protection', 'branch-protection-checks-red', 'branch-protection-review',
        'branch-protection-other', 'branch-protection-unreadable',
    ];
    for (const gate of emitibles) {
        assert.equal(typeof delivery.GATE_BLOCK_LABELS[gate], 'string', `falta label para ${gate}`);
        assert.ok(delivery.GATE_BLOCK_LABELS[gate].length > 10, gate);
    }
    // Se elimina el "o" disyuntivo: post-fix el código sabe cuál de los dos es.
    for (const gate of ['branch-protection-checks-red', 'branch-protection-review', 'branch-protection-other']) {
        assert.doesNotMatch(delivery.GATE_BLOCK_LABELS[gate], /reviews?\s+o\s+checks/i, gate);
    }
    // El key genérico sobrevive como fallback (el camino legacy lo sigue emitiendo).
    assert.equal(typeof delivery.GATE_BLOCK_LABELS['branch-protection'], 'string');
    // Y un gate desconocido tampoco deja el texto sin destino.
    assert.match(delivery.buildGateBlockMotivo({ gate: 'inventado-manana' }), /gate inventado-manana/);
});

// ── R8 / G7 / CA-UX-5: la escalera de snapshot ─────────────────────────────

const UNKNOWN_FIELD = { exit_code: 1, stdout: '', stderr: 'unknown JSON field: "reviewDecision"' };

function snapshotJson(over = {}) {
    return JSON.stringify({
        labels: [{ name: 'qa:skipped' }],
        files: [{ path: '.pipeline/x.js' }],
        headRefOid: HEAD_SHA,
        headRefName: 'agent/6431-x',
        state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
        statusCheckRollup: [], reviewDecision: '',
        ...over,
    });
}

test('#6431 R8/G7 — la escalera baja de a UN nivel: perder reviewDecision NO apaga #6012 ni #6384', () => {
    const pedidos = [];
    const logs = [];
    const snap = delivery.getPRSnapshot(6416, {
        logAppend: (l) => logs.push(l),
        ghImpl(args) {
            const fields = args[args.indexOf('--json') + 1];
            pedidos.push(fields);
            if (fields.includes('reviewDecision')) return UNKNOWN_FIELD;
            return { exit_code: 0, stdout: snapshotJson() };
        },
    });
    assert.equal(pedidos.length, 2, 'nivel 1 → nivel 2, y ahí para');
    assert.equal(snap.snapshotFieldsLevel, 2);
    // Lo importante: el nivel 2 CONSERVA los campos de #6012 y #6384.
    assert.match(pedidos[1], /mergeStateStatus/);
    assert.match(pedidos[1], /statusCheckRollup/);
    assert.equal(snap.mergeStateStatus, 'BLOCKED');
    // Y la review queda marcada como NO leída.
    assert.equal(snap.reviewDecisionRead, false);
    // CA-UX-5 — la degradación deja log.
    assert.match(logs.join('\n'), /snapshot degradado a nivel 2/);
});

test('#6431 — la escalera encadena hasta el nivel 3 si el `gh` es muy viejo', () => {
    const logs = [];
    const snap = delivery.getPRSnapshot(6416, {
        logAppend: (l) => logs.push(l),
        ghImpl(args) {
            const fields = args[args.indexOf('--json') + 1];
            if (fields.includes('mergeStateStatus')) return UNKNOWN_FIELD;
            return { exit_code: 0, stdout: snapshotJson({ mergeStateStatus: undefined, statusCheckRollup: undefined, reviewDecision: undefined }) };
        },
    });
    assert.equal(snap.snapshotFieldsLevel, 3);
    assert.equal(snap.reviewDecisionRead, false);
    assert.equal(snap.statusCheckRollup, null, 'nivel 3: no leí — jamás []');
    assert.match(logs.join('\n'), /snapshot degradado a nivel 3/);
});

test('#6431 — el nivel 1 marca reviewDecisionRead:true y distingue [] de null', () => {
    const snap = delivery.getPRSnapshot(6416, {
        ghImpl: () => ({ exit_code: 0, stdout: snapshotJson() }),
    });
    assert.equal(snap.snapshotFieldsLevel, 1);
    assert.equal(snap.reviewDecisionRead, true);
    assert.deepEqual(snap.statusCheckRollup, [], 'leí y está vacío');
    assert.equal(snap.reviewDecision, null, '"" normaliza a null, y eso NO significa "no leí"');
});

test('#6431 — normalizeMergeState cierra el enum de reviewDecision', () => {
    assert.equal(delivery.normalizeMergeState({ reviewDecision: 'REVIEW_REQUIRED' }).reviewDecision, 'REVIEW_REQUIRED');
    for (const raro of ['', null, 'ALGO_NUEVO', 42, {}]) {
        assert.equal(delivery.normalizeMergeState({ reviewDecision: raro }).reviewDecision, null, JSON.stringify(raro));
    }
});

// ── A-2 / A-R4: el wiring, sin el cual todo esto es un footgun mudo ────────

test('#6431 A-2/CA-20 — sin reader inyectado se cae al camino de #6384 Y queda logueado', () => {
    const logs = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({ statusCheckRollup: [{ name: 'pr-status', status: 'COMPLETED', conclusion: 'SUCCESS' }] }),
        logAppend: (l) => logs.push(l),
    }));
    // Comportamiento #6384 literal: gate `branch-protection`, no el desdoble nuevo.
    assert.equal(out.gate, 'branch-protection');
    assert.match(logs.join('\n'), /sin lector de checks requeridos inyectado/,
        'la desactivación no puede ser silenciosa');
});

test('#6431 A-2 — el entry point de PRODUCCIÓN inyecta el requiredChecksReader', () => {
    // Sin este test, A-2 es un footgun: el default `null` deja el fix apagado
    // en producción y todos los tests siguen verdes.
    const src = fs.readFileSync(require.resolve('../delivery.js'), 'utf8');
    const callsite = src.slice(src.indexOf('const outcome = attemptMergeWithGates({'));
    assert.match(callsite.slice(0, 2000), /requiredChecksReader:\s*buildRequiredChecksReader\(\)/,
        'producción DEBE inyectar el lector');
    // Y la fábrica arma el reader con la constante de repo y la rama base.
    assert.equal(typeof delivery.buildRequiredChecksReader, 'function');
    assert.equal(typeof delivery.buildRequiredChecksReader(), 'function');
});

test('#6431 SEC-11/A-R9 — la rama base del ruleset es una CONSTANTE, no un dato del PR', () => {
    assert.equal(delivery.MERGE_BASE_BRANCH, 'main');
    const src = fs.readFileSync(require.resolve('../delivery.js'), 'utf8');
    assert.doesNotMatch(src, /baseBranch:\s*snapshot\.headRefName/,
        'interpolar el ref del PR en el path del ruleset sería path injection');
});

// ── CA-13 / A-R10 / CA-21: el diff no puede introducir bypasses ────────────

test('#6431 CA-13/A-R10 — el diff no introduce --admin, --auto ni escritura de rulesets', () => {
    const archivos = ['../delivery.js', '../../lib/required-checks.js'];
    for (const rel of archivos) {
        const src = fs.readFileSync(require.resolve(rel), 'utf8');
        const codigo = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        assert.doesNotMatch(codigo, /--admin\b/, `${rel}: --admin saltea la protección de rama`);
        assert.doesNotMatch(codigo, /--auto\b/, `${rel}: --auto encola el merge FUERA de la ventana de gates`);
        assert.doesNotMatch(codigo, /rulesets/, `${rel}: no se escriben rulesets`);
        assert.doesNotMatch(codigo, /pr['"\s,]+close/i, `${rel}: no se cierra/reabre el PR`);
    }
});

test('#6431 CA-18/SEC-12 — el llamador PROPAGA el transient como error (no retorno silencioso)', () => {
    const src = fs.readFileSync(require.resolve('../delivery.js'), 'utf8');
    const rama = src.slice(src.indexOf("outcome.status === 'transient'"));
    assert.match(rama.slice(0, 1500), /throw new Error\(buildTransientMergeMotivo\(/,
        'el rebote técnico acotado por el circuit breaker es la única red mientras #6432 no exista');
});
