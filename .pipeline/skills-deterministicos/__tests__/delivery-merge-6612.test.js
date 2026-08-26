// =============================================================================
// #6612 — `delivery` espera y escala SÓLO por los checks que la protección de
// rama exige, y NO mergea con un escáner de seguridad en rojo.
//
// Los dos hechos que fijan esta suite, ambos verificados contra el repo:
//
//   1. El ruleset de `main` exige UN solo contexto:
//        $ gh api repos/intrale/platform/rules/branches/main \
//            --jq '[.[]|select(.type=="required_status_checks")
//                   |.parameters.required_status_checks[].context]'
//        ["pr-status"]
//      Un PR con `pr-status` en verde es mergeable aunque el escáner OWASP siga
//      corriendo 3 h. El presupuesto de `delivery` es de 7 esperas (~104 s) y
//      6 min de wall-clock: contra 3 h SIEMPRE pierde.
//
//   2. Ese mismo acotamiento, hecho solo, vuelve decorativos a los escáneres —
//      porque el ruleset no exige ninguno. El PR #6602 ya se mergeó con
//      `runtime-state-guard` (el secret scan del diff) en FAILURE.
//
// DÓNDE VA EL GATE (G-2). El merge de #6602 salió por el camino `UNSTABLE`, que
// NO produce 405 ni BLOCKED: `classifyMergeFailure` ni siquiera se llama. Por
// eso la allowlist tiene que estar pre-PUT, en `attemptMergeWithGates`, y no
// dentro de `classifyChecks`.
//
// Sin red: `gh`, el `sleep`, el lector de requeridos y el publicador de la
// constancia se inyectan.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Aislar REPO_ROOT (delivery escribe audit + cola Telegram centrales acá).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-delivery6612-'));
fs.mkdirSync(path.join(TMP, '.claude', 'hooks'), { recursive: true });
fs.mkdirSync(path.join(TMP, '.pipeline', 'logs'), { recursive: true });
process.env.PIPELINE_REPO_ROOT = TMP;
process.env.CLAUDE_PROJECT_DIR = TMP;

delete require.cache[require.resolve('../delivery')];
const delivery = require('../delivery');

const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

const MERGED_OK = {
    exit_code: 0,
    stdout: JSON.stringify({ sha: 'merge-sha-6612', merged: true }),
    stderr: '',
};
const NOT_MERGEABLE_405 = {
    exit_code: 1, stdout: '',
    stderr: 'gh: Pull Request is not mergeable (HTTP 405)',
};

const rojo = (name) => ({ name, status: 'COMPLETED', conclusion: 'FAILURE' });
const verde = (name) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' });
const corriendo = (name) => ({ name, status: 'IN_PROGRESS', conclusion: null });

function snapshotOk(over = {}) {
    return {
        ok: true,
        labels: ['qa:skipped'],
        files: ['.pipeline/skills-deterministicos/delivery.js'],
        headRefOid: HEAD_SHA,
        headRefName: 'agent/6612-pipeline-dev',
        state: 'OPEN',
        mergeStateStatus: 'UNSTABLE',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [verde('pr-status')],
        reviewDecision: null,
        reviewDecisionRead: true,
        snapshotFieldsLevel: 1,
        ...over,
    };
}

function readerFake(veredicto) {
    return () => ({ pending: [], failing: [], green: [], logLines: [], ...veredicto });
}

function baseDeps(over = {}) {
    return {
        prNumber: 6612,
        getSnapshot: () => snapshotOk(),
        loadOwners: () => ({ ok: true, rules: [] }),
        verifyOrigin: () => ({ ok: true }),
        mergePR: () => MERGED_OK,
        sleepImpl: () => {},
        ...over,
    };
}

// =============================================================================
// CA-4a — EL TEST QUE REPRODUCE #6602. Es el que debe fallar contra `main`.
// =============================================================================

test('#6612 CA-4a — runtime-state-guard en FAILURE con pr-status verde y UNSTABLE: NO mergea', () => {
    const merges = [];
    const logs = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        // Rollup REAL del PR #6602.
        getSnapshot: () => snapshotOk({
            mergeStateStatus: 'UNSTABLE',
            statusCheckRollup: [
                rojo('runtime-state-guard'),
                verde('pr-status'),
                verde('OWASP Dependency Check'),
                verde('Semgrep Static Analysis'),
                verde('detect-secrets Scan'),
            ],
        }),
        mergePR: () => { merges.push(1); return MERGED_OK; },
        logAppend: (l) => logs.push(String(l)),
    }));
    assert.equal(out.status, 'blocked');
    assert.equal(out.gate, 'security-checks-red');
    assert.match(out.reason, /runtime-state-guard/);
    // Lo esencial: el PUT NUNCA se dispara. Con el gate corriendo después del
    // merge, `main` ya tendría el commit y el gate sería decorativo.
    assert.equal(merges.length, 0, 'el PUT no puede ejecutarse: así se mergeó #6602');
    assert.ok(
        logs.some((l) => /el ruleset no los exige, pero el pipeline no mergea con un escáner en rojo/.test(l)),
        'el log dice POR QUÉ frenó un check que la protección de rama no pide'
    );
});

test('#6612 CA-4a — el gate es un control ACTIVO: no reintenta ni espera', () => {
    const sleeps = [];
    let snapshots = 0;
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => { snapshots++; return snapshotOk({ statusCheckRollup: [rojo('detect-secrets Scan')] }); },
        sleepImpl: (ms) => sleeps.push(ms),
    }));
    assert.equal(out.status, 'blocked');
    assert.deepEqual(sleeps, [], 'esperar a que un escáner en rojo se ponga verde solo no tiene sentido');
    assert.equal(snapshots, 1, 'mismo tratamiento que branch-protection: escala sin reintentar');
});

test('#6612 CA-4a — el gate escala con rótulo propio, sin tocar la estructura de gate-block', () => {
    const motivo = delivery.buildGateBlockMotivo({
        prNumber: 6602, branch: 'agent/6602-x', gate: 'security-checks-red',
        reason: 'checks de seguridad en rojo: runtime-state-guard',
    });
    assert.match(motivo, /Merge bloqueado/, 'el pulpo lo clasifica como bloqueo humano');
    assert.match(motivo, /requiere intervención humana/);
    assert.match(motivo, /escáner en rojo/);
    assert.match(motivo, /runtime-state-guard/);
    const esc = delivery.buildGateBlockEscalation({
        issue: 6612, prNumber: 6602, branch: 'agent/6602-x', gate: 'security-checks-red',
        reason: 'checks de seguridad en rojo: runtime-state-guard',
    });
    assert.match(esc, /escáner en rojo/);
    assert.match(esc, /main` quedó INTACTO/);
});

// =============================================================================
// CA-1 — El caso que el issue vino a destrabar (test de NO-REGRESIÓN)
//
// ⚠️ G-1: este test PASA hoy sobre `main` sin el fix. Un PR `UNSTABLE` con el
// requerido en verde ya mergeaba: `classifyMergeFailure` sólo se llama si el PUT
// falla. Se escribe igual, porque el gate nuevo de CA-4a corre justo en ese
// camino y podría romperlo — pero NO cuenta como evidencia de que el fix hace
// algo. La evidencia es CA-4a.
// =============================================================================

test('#6612 CA-1 — pr-status verde + OWASP Dependency Check IN_PROGRESS: mergea sin esperar', () => {
    const sleeps = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({
            statusCheckRollup: [verde('pr-status'), corriendo('OWASP Dependency Check')],
        }),
        // El reader confirma lo que dice el ruleset: sólo `pr-status`, y verde.
        requiredChecksReader: readerFake({ verdict: 'green', green: ['pr-status'] }),
        sleepImpl: (ms) => sleeps.push(ms),
    }));
    assert.equal(out.status, 'merged');
    assert.deepEqual(sleeps, [], 'contra un check de 3 h el presupuesto SIEMPRE se agota: no hay que gastarlo');
});

// =============================================================================
// CA-2 — El gate NO se afloja para los checks que sí son requeridos
// =============================================================================

test('#6612 CA-2 — un check REQUERIDO en curso sigue frenando y esperando', () => {
    const sleeps = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({
            mergeStateStatus: 'BLOCKED',
            statusCheckRollup: [corriendo('pr-status')],
        }),
        mergePR: () => NOT_MERGEABLE_405,
        requiredChecksReader: readerFake({ verdict: 'pending', pending: ['pr-status'] }),
        maxChecksWaits: 2,
        sleepImpl: (ms) => sleeps.push(ms),
    }));
    assert.ok(sleeps.length > 0, 'no se afloja el gate: por un requerido se espera igual que antes');
    assert.equal(out.status, 'transient', 'presupuesto agotado ⇒ transitorio, no escala');
    assert.deepEqual(out.pendientes, ['pr-status']);
});

// =============================================================================
// CA-3 — Ruleset ilegible ⇒ fail-closed, y queda dicho en el log
// =============================================================================

test('#6612 CA-3 — si no se puede leer la lista de requeridos, fail-closed y constancia en el log', () => {
    const logs = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({
            mergeStateStatus: 'BLOCKED',
            statusCheckRollup: [corriendo('pr-status')],
        }),
        mergePR: () => NOT_MERGEABLE_405,
        requiredChecksReader: () => ({
            verdict: 'unusable', cause: 'ruleset-forma-inesperada',
            pending: [], failing: [], green: [],
            logLines: ['[delivery] gate merge: no se pudo leer la lista de checks requeridos del ruleset (ruleset-forma-inesperada) — se mantiene el bloqueo fail-closed'],
        }),
        logAppend: (l) => logs.push(String(l)),
    }));
    assert.equal(out.status, 'blocked', 'no leer la lista NUNCA se traduce a "no se exige nada"');
    assert.ok(
        logs.some((l) => /no se pudo leer la lista de checks requeridos/.test(l)),
        'la desactivación del acotamiento no puede ser muda'
    );
});

test('#6612 G-3 — rollup null (snapshot degradado) es fail-closed, no vía libre', () => {
    const merges = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({ statusCheckRollup: null }),
        mergePR: () => { merges.push(1); return MERGED_OK; },
    }));
    assert.equal(out.status, 'blocked');
    assert.equal(out.gate, 'security-checks-unreadable', 'no se rotula "en rojo" lo que no se pudo leer');
    assert.equal(merges.length, 0, 'leer "no pude consultar" como "nada en rojo" es el fail-open exacto');
});

// =============================================================================
// CA-4b — Un rojo NO requerido y FUERA de la allowlist: mergea, pero deja constancia
// =============================================================================

test('#6612 CA-4b — check no requerido fuera de la allowlist en rojo: mergea y postea la constancia', () => {
    const constancias = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({
            statusCheckRollup: [verde('pr-status'), rojo('docs-lint')],
        }),
        requiredChecksReader: readerFake({ verdict: 'green', green: ['pr-status'] }),
        postNonRequiredRed: (args) => { constancias.push(args); },
    }));
    assert.equal(out.status, 'merged', 'la protección de rama no lo exige: no frena');
    assert.equal(constancias.length, 1, 'pero no se ignora en silencio');
    assert.deepEqual(constancias[0].contexts, ['docs-lint']);
});

test('#6612 CA-4b — el check de la allowlist NO genera constancia: genera bloqueo', () => {
    const constancias = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({ statusCheckRollup: [verde('pr-status'), rojo('Semgrep Static Analysis')] }),
        requiredChecksReader: readerFake({ verdict: 'green', green: ['pr-status'] }),
        postNonRequiredRed: (args) => { constancias.push(args); },
    }));
    assert.equal(out.status, 'blocked');
    assert.equal(out.gate, 'security-checks-red');
    assert.deepEqual(constancias, [], 'un escáner en rojo se BLOQUEA, no se comenta y se mergea');
});

test('#6612 CA-4b — un PR sano no paga la lectura de requeridos ni comenta nada', () => {
    let lecturas = 0;
    const constancias = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        requiredChecksReader: () => { lecturas++; return { verdict: 'green', pending: [], failing: [], green: ['pr-status'], logLines: [] }; },
        postNonRequiredRed: (a) => constancias.push(a),
    }));
    assert.equal(out.status, 'merged');
    assert.equal(lecturas, 0, 'sin rojos en el rollup no hay nada que rotular: cero API extra');
    assert.deepEqual(constancias, []);
});

test('#6612 CA-4b — que falle el comentario NUNCA frena ni habilita el merge', () => {
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({ statusCheckRollup: [verde('pr-status'), rojo('docs-lint')] }),
        requiredChecksReader: readerFake({ verdict: 'green', green: ['pr-status'] }),
        postNonRequiredRed: () => { throw new Error('gh caído'); },
    }));
    assert.equal(out.status, 'merged', 'la constancia es best-effort');
});

test('#6612 CA-4b — la constancia es IDEMPOTENTE: segunda pasada, cero comentarios nuevos', () => {
    const body = delivery.buildNonRequiredRedBody(6612, 'docs-lint');
    const posts = [];
    // 1ª pasada: el PR no tiene el marker.
    const gh1 = (argv) => {
        if (argv[0] === 'pr' && argv[1] === 'view') {
            return { exit_code: 0, stdout: JSON.stringify({ comments: [{ body: 'otro comentario' }] }), stderr: '' };
        }
        posts.push(argv);
        return { exit_code: 0, stdout: '', stderr: '' };
    };
    const r1 = delivery.postNonRequiredRedNotice({ prNumber: 6612, contexts: ['docs-lint'], gh: gh1 });
    assert.deepEqual(r1.posted, ['docs-lint']);
    assert.equal(posts.length, 1);

    // 2ª pasada: el marker ya está. El pulpo reevalúa en loop; un comentario por
    // barrido convierte el PR en spam y entrena al operador a ignorarlo.
    const posts2 = [];
    const gh2 = (argv) => {
        if (argv[0] === 'pr' && argv[1] === 'view') {
            return { exit_code: 0, stdout: JSON.stringify({ comments: [{ body }] }), stderr: '' };
        }
        posts2.push(argv);
        return { exit_code: 0, stdout: '', stderr: '' };
    };
    const r2 = delivery.postNonRequiredRedNotice({ prNumber: 6612, contexts: ['docs-lint'], gh: gh2 });
    assert.deepEqual(r2.posted, []);
    assert.deepEqual(r2.skipped, ['docs-lint']);
    assert.equal(posts2.length, 0, 'cero comentarios nuevos en la segunda pasada');
});

test('#6612 — si no se pueden leer los comentarios, NO se postea a ciegas', () => {
    const posts = [];
    const gh = (argv) => {
        if (argv[1] === 'view') return { exit_code: 1, stdout: '', stderr: 'API rate limit' };
        posts.push(argv);
        return { exit_code: 0, stdout: '', stderr: '' };
    };
    const r = delivery.postNonRequiredRedNotice({ prNumber: 6612, contexts: ['docs-lint'], gh });
    assert.deepEqual(posts, [], 'postear sin poder chequear el marker es spam garantizado en cada barrido');
    assert.equal(r.reason, 'comentarios-no-legibles');
});

test('#6612 UX-3 — el texto de la constancia dice que NO frenó el merge, y por qué', () => {
    const body = delivery.buildNonRequiredRedBody(6612, 'docs-lint');
    assert.match(body, /docs-lint/);
    assert.match(body, /NO frenó el merge/);
    assert.match(body, /no exige ese check/);
    assert.match(body, /no hace falta hacer nada en este PR/, 'si no, se lee como error y dispara una investigación');
    assert.match(body, /<!-- delivery-nonrequired-red pr=6612 context=docs-lint -->/, 'marker de idempotencia');
});

test('#6612 SEC-E — el comentario PÚBLICO no filtra política de rama', () => {
    const body = delivery.buildNonRequiredRedBody(6612, 'docs-lint');
    for (const secreto of ['allowed_actors', 'required_reviewers', 'dismissal_restriction']) {
        assert.ok(!body.includes(secreto), `el comentario no puede traer ${secreto}`);
    }
    // Y el texto libre pasa por el saneo canónico: un contexto con un token
    // adentro no lo publica.
    const sucio = delivery.buildNonRequiredRedBody(6612, 'ci ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 token=hunter2');
    assert.ok(!/ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ/.test(sucio), 'sanitizeGateText redacta tokens de GitHub');
    assert.ok(!/hunter2/.test(sucio), 'y los pares clave=valor sensibles');
    assert.match(sucio, /&lt;redacted&gt;|<redacted>/);
});

// =============================================================================
// CA-5 / UX-5 — El mensaje de espera y escalada nombra QUÉ y CON QUÉ RÓTULO
// =============================================================================

test('#6612 CA-5 — el mensaje de checks-timeout nombra los pendientes, su rótulo y el presupuesto', () => {
    const logs = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({
            mergeStateStatus: 'BLOCKED',
            statusCheckRollup: [corriendo('pr-status')],
        }),
        mergePR: () => NOT_MERGEABLE_405,
        requiredChecksReader: readerFake({ verdict: 'pending', pending: ['pr-status'] }),
        // Techo de wall-clock bajo para salir por `checks-timeout` (el contador
        // duro corta primero con los defaults — ver D-D de #6431).
        mergeChecksTimeoutMs: 20,
        maxChecksWaits: 50,
        logAppend: (l) => logs.push(String(l)),
    }));
    assert.equal(out.status, 'blocked');
    assert.equal(out.gate, 'checks-timeout');
    assert.match(out.reason, /pr-status/, 'nombra CUÁL está pendiente');
    assert.match(out.reason, /requeridos por la protección de rama/, 'y dice que sí es requerido');
    assert.match(out.reason, /presupuesto agotado: \d+\/\d+ esperas, \d+\/\d+ms/, 'UX-5: el presupuesto');
    // El texto llega tal cual al operador.
    const esc = delivery.buildGateBlockEscalation({ issue: 6612, prNumber: 6612, gate: 'checks-timeout', reason: out.reason });
    assert.match(esc, /pr-status/);
    assert.match(esc, /presupuesto agotado/);
    // Y el log de la espera también los nombra.
    assert.ok(
        logs.some((l) => /espera .*ms \(\d+\/\d+, \d+\/\d+ms\)/.test(l) && /pr-status/.test(l)),
        'el log de espera nombra el pendiente, no dice sólo "checks requeridos en curso"'
    );
});

test('#6612 UX-1 — sin veredicto cotejado, el mensaje NO afirma que el pendiente sea requerido', () => {
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({
            mergeStateStatus: 'BLOCKED',
            statusCheckRollup: [corriendo('OWASP Dependency Check')],
        }),
        mergePR: () => NOT_MERGEABLE_405,
        // Sin lector inyectado: camino legacy.
        mergeChecksTimeoutMs: 20,
        maxChecksWaits: 50,
    }));
    assert.equal(out.gate, 'checks-timeout');
    assert.match(out.reason, /OWASP Dependency Check/);
    assert.match(out.reason, /sin cotejar contra el ruleset/, 'no se afirma lo que no se cotejó');
});

// =============================================================================
// Anti-código-muerto — producción tiene que inyectar las dos piezas nuevas
// =============================================================================

const DELIVERY_SRC = fs.readFileSync(path.join(__dirname, '..', 'delivery.js'), 'utf8');

test('#6612 G-1 — el wiring de producción existe (si no, el fix es un no-op con los tests en verde)', () => {
    assert.match(DELIVERY_SRC, /postNonRequiredRed:\s*postNonRequiredRedNotice/, 'la constancia tiene que estar cableada');
    assert.match(DELIVERY_SRC, /requiredChecksReader:\s*buildRequiredChecksReader\(\)/, 'el reader de #6431 sigue cableado');
    assert.match(
        DELIVERY_SRC,
        /require\(['"]\.\.\/lib\/security-blocking-checks['"]\)/,
        'la allowlist tiene que estar importada'
    );
});

test('#6612 G-2 — el gate de seguridad corre ANTES del PUT, no después', () => {
    const iGate = DELIVERY_SRC.indexOf("gate: 'security-checks-red'");
    const iPut = DELIVERY_SRC.indexOf('const mergeRes = mergePR(');
    assert.ok(iGate > 0 && iPut > 0);
    assert.ok(
        iGate < iPut,
        'después del PUT el commit ya está en main y el gate es decorativo: así se mergeó #6602'
    );
});

test('#6612 — los dos gates nuevos tienen rótulo en GATE_BLOCK_LABELS', () => {
    for (const gate of ['security-checks-red', 'security-checks-unreadable']) {
        assert.equal(typeof delivery.GATE_BLOCK_LABELS[gate], 'string');
        assert.ok(delivery.GATE_BLOCK_LABELS[gate].length > 20, `${gate} necesita un texto que el operador entienda`);
    }
});
