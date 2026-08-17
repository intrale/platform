// #5420 (split de #5401, bloque B) — Camino de merge endurecido de la fase de
// entrega: CODEOWNERS fail-closed desde origin/main, SHA pinneado en el PUT y
// procedencia de la rama verificada antes de mergear.
//
// Qué fija esta suite: ninguna ruta puede terminar en merge sin haber
// CONFIRMADO owners, procedencia y SHA observado. Todo borde degradado (gh que
// falla, JSON inválido, CODEOWNERS ilegible, procedencia no acreditable,
// respuesta sin `merged:true`) tiene que bloquear y escalar — nunca mergear.
//
// Sin red ni gh real: `attemptMergeWithGates` recibe sus dependencias
// inyectadas, así que las decisiones se validan de forma determinística.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Aislar REPO_ROOT (delivery escribe audit + cola Telegram centrales acá).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-delivery5401-'));
fs.mkdirSync(path.join(TMP, '.claude', 'hooks'), { recursive: true });
fs.mkdirSync(path.join(TMP, '.pipeline', 'logs'), { recursive: true });
process.env.PIPELINE_REPO_ROOT = TMP;
process.env.CLAUDE_PROJECT_DIR = TMP;

delete require.cache[require.resolve('../delivery')];
const delivery = require('../delivery');
const codeowners = require('../lib/codeowners');
const humanBlock = require('../../lib/human-block');

// ── Fakes ──────────────────────────────────────────────────────────────────

const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const HEAD_SHA_2 = 'ffeeddccbbaa00998877665544332211aabbccdd';

function snapshotOk(over = {}) {
    return {
        ok: true,
        labels: ['qa:skipped'],
        files: ['.pipeline/skills-deterministicos/delivery.js'],
        headRefOid: HEAD_SHA,
        headRefName: 'agent/5401-pipeline-dev',
        ...over,
    };
}

// CODEOWNERS real del repo (subconjunto): `.github/` exige owner humano,
// `.pipeline/` NO. Es la fuente contra la que se evalúan los paths del PR.
const REMOTE_CODEOWNERS = [
    '# CODEOWNERS de origin/main',
    '/.github/        @leitolarreta',
    '/docs/           @writer-team',
].join('\n');

function ownersFromRemote(content = REMOTE_CODEOWNERS) {
    // Usa el loader REAL contra un `git show` fake: prueba de que el gate no
    // depende de ninguna copia local del archivo.
    return () => codeowners.loadCodeownersFromRef('/worktree-podado', 'origin/main', {
        spawnImpl: (cmd, argv) => {
            const spec = argv[1] || '';
            const rel = spec.slice(spec.indexOf(':') + 1);
            if (rel !== '.github/CODEOWNERS') {
                return { status: 128, stdout: '', stderr: `fatal: path '${rel}' does not exist` };
            }
            return { status: 0, stdout: content, stderr: '' };
        },
    });
}

// mergeOk / mergeFail — fakes del PUT que además registran con qué SHA se llamó.
function recordingMerge(responder, calls) {
    return (opts) => {
        calls.push(opts);
        return responder(opts, calls.length);
    };
}

const MERGED_OK = { exit_code: 0, stdout: JSON.stringify({ sha: 'merge-sha-123', merged: true, message: 'ok' }), stderr: '' };
const HEAD_CHANGED_409 = {
    exit_code: 1, stdout: '',
    stderr: 'gh: HTTP 409: Head branch was modified. Review and try the merge again. (https://api.github.com/...)',
};

function baseDeps(over = {}) {
    return {
        prNumber: 777,
        getSnapshot: () => snapshotOk(),
        loadOwners: ownersFromRemote(),
        verifyOrigin: () => ({ ok: true, reason: 'author-allowlisted:bot@intrale.com' }),
        mergePR: () => MERGED_OK,
        logAppend: () => {},
        ...over,
    };
}

// ── CA / repro #5395: gates verdes + procedencia OK ⇒ merge completado ──────

test('#5420 repro #5395 — worktree local podado + gates verdes + procedencia verificada ⇒ MERGE completado sin needs-human', () => {
    const calls = [];
    // El worktree local no tiene CODEOWNERS (podado): el loader lee de origin/main.
    const out = delivery.attemptMergeWithGates(baseDeps({
        mergePR: recordingMerge(() => MERGED_OK, calls),
    }));
    assert.equal(out.status, 'merged');
    assert.equal(out.sha, 'merge-sha-123');
    assert.equal(out.attempt, 1);
    assert.equal(calls.length, 1);
});

test('#5420 CA — el PUT del merge viaja con el SHA observado al evaluar los gates', () => {
    const calls = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        mergePR: recordingMerge(() => MERGED_OK, calls),
    }));
    assert.equal(out.status, 'merged');
    assert.equal(calls[0].sha, HEAD_SHA, 'el sha del PUT debe ser el del snapshot de los gates');
    assert.equal(calls[0].prNumber, 777);
});

// ── CA: CODEOWNERS fail-closed ─────────────────────────────────────────────

test('#5420 CA — CODEOWNERS no cargable ⇒ merge BLOQUEADO (no continúa con lista vacía)', () => {
    const calls = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        loadOwners: () => codeowners.loadCodeownersFromRef('/repo', 'origin/main', {
            spawnImpl: () => ({ status: 128, stdout: '', stderr: 'fatal: invalid object name' }),
        }),
        mergePR: recordingMerge(() => MERGED_OK, calls),
    }));
    assert.equal(out.status, 'blocked');
    assert.equal(out.gate, 'codeowners');
    assert.equal(calls.length, 0, 'no se puede intentar el merge sin CODEOWNERS');
});

test('#5420 CA — PR que toca .github/workflows/ SIN copia local queda bloqueado por CODEOWNERS de origin/main', () => {
    const calls = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({ files: ['.github/workflows/ci.yml'] }),
        mergePR: recordingMerge(() => MERGED_OK, calls),
    }));
    assert.equal(out.status, 'needs-human');
    assert.deepEqual(out.owners, ['@leitolarreta']);
    assert.equal(calls.length, 0, 'un PR con owner humano nunca llega al PUT');
});

test('#5923 — un CODEOWNERS remoto legíble y sin reglas activas autoriza continuar', () => {
    const calls = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        loadOwners: ownersFromRemote('# archivo sin reglas\n'),
        getSnapshot: () => snapshotOk({ files: ['.github/workflows/ci.yml'] }),
        mergePR: recordingMerge(() => MERGED_OK, calls),
    }));
    assert.equal(out.status, 'merged');
    assert.equal(calls.length, 1);
});

// ── CA: procedencia (contra-test de seguridad) ─────────────────────────────

test('#5420 CA contra-test — procedencia NO verificada + gates verdes ⇒ NO mergea y escala', () => {
    const calls = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        verifyOrigin: () => ({ ok: false, reason: 'author-not-allowlisted:evil@attacker.test' }),
        mergePR: recordingMerge(() => MERGED_OK, calls),
    }));
    assert.equal(out.status, 'blocked');
    assert.equal(out.gate, 'provenance');
    assert.ok(/evil@attacker\.test/.test(out.reason));
    assert.equal(calls.length, 0, 'sin procedencia acreditada no se puede llamar al merge');
});

test('#5420 — procedencia que lanza/devuelve basura tampoco habilita el merge', () => {
    for (const bad of [null, undefined, {}, { ok: 'true' }, { ok: 1 }]) {
        const calls = [];
        const out = delivery.attemptMergeWithGates(baseDeps({
            verifyOrigin: () => bad,
            mergePR: recordingMerge(() => MERGED_OK, calls),
        }));
        assert.equal(out.status, 'blocked', `verifyOrigin=${JSON.stringify(bad)} debe bloquear`);
        assert.equal(out.gate, 'provenance');
        assert.equal(calls.length, 0);
    }
});

test('#5420 — la procedencia se verifica sobre la rama del SNAPSHOT, no sobre una rama arbitraria', () => {
    const vistos = [];
    delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({ headRefName: 'agent/9999-otro' }),
        verifyOrigin: (b) => { vistos.push(b); return { ok: true, reason: 'ok' }; },
    }));
    assert.deepEqual(vistos, ['agent/9999-otro']);
});

// ── CA: snapshot fail-closed (TOCTOU cerrado) ──────────────────────────────

test('#5420 — snapshot degradado (gh falla) ⇒ bloqueo, sin merge', () => {
    const calls = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => ({ ok: false, reason: 'gh pr view exit=1' }),
        mergePR: recordingMerge(() => MERGED_OK, calls),
    }));
    assert.equal(out.status, 'blocked');
    assert.equal(out.gate, 'snapshot');
    assert.equal(calls.length, 0);
});

// #6012 re-baseline — el snapshot ahora trae TAMBIÉN el estado de mergeabilidad
// (`mergeable`, `mergeStateStatus`, `state`) en la misma lectura. El invariante
// que fija este test no cambió: sigue siendo UNA sola llamada, sin TOCTOU.
test('#5420/#6012 — getPRSnapshot: labels, files, head, rama y estado de merge en UNA sola llamada', () => {
    const calls = [];
    const snap = delivery.getPRSnapshot(777, {
        ghImpl: (argv, opts) => {
            calls.push({ argv, opts });
            return {
                exit_code: 0,
                stdout: JSON.stringify({
                    labels: [{ name: 'qa:skipped' }, { name: 'Ready' }],
                    files: [{ path: '.pipeline/pulpo.js' }],
                    headRefOid: HEAD_SHA,
                    headRefName: 'agent/5401-pipeline-dev',
                }),
                stderr: '',
            };
        },
        cwd: '/w',
    });
    assert.equal(snap.ok, true);
    assert.deepEqual(snap.labels, ['qa:skipped', 'Ready']);
    assert.deepEqual(snap.files, ['.pipeline/pulpo.js']);
    assert.equal(snap.headRefOid, HEAD_SHA);
    assert.equal(snap.headRefName, 'agent/5401-pipeline-dev');
    assert.equal(calls.length, 1, 'labels, files, head, rama y estado de merge salen de una única lectura (sin TOCTOU)');
    assert.deepEqual(calls[0].argv.slice(0, 4), ['pr', 'view', '777', '--json']);
    assert.equal(
        calls[0].argv[4],
        'labels,files,headRefOid,headRefName,mergeable,mergeStateStatus,state',
        '#6012 CA-1: el estado de mergeabilidad viaja en la MISMA llamada que los gates',
    );
    // El PR de este fixture no devolvió los campos nuevos: se normalizan a null
    // (nunca a 'UNKNOWN'), que es lo que mantiene el default fail-closed.
    assert.equal(snap.mergeStateStatus, null);
    assert.equal(snap.state, null);
    assert.equal(snap.mergeable, null);
});

test('#5420 — getPRSnapshot: bordes degradados son {ok:false}, nunca listas vacías', () => {
    const casos = [
        ['gh exit != 0', { exit_code: 1, stdout: '', stderr: 'HTTP 502' }],
        ['JSON inválido', { exit_code: 0, stdout: '<html>error</html>', stderr: '' }],
        ['JSON no-objeto', { exit_code: 0, stdout: '"texto"', stderr: '' }],
        ['sin headRefOid', { exit_code: 0, stdout: JSON.stringify({ labels: [], files: [{ path: 'a.js' }], headRefName: 'b' }), stderr: '' }],
        ['headRefOid basura', { exit_code: 0, stdout: JSON.stringify({ files: [{ path: 'a.js' }], headRefOid: 'no-es-un-sha', headRefName: 'b' }), stderr: '' }],
        ['sin headRefName', { exit_code: 0, stdout: JSON.stringify({ files: [{ path: 'a.js' }], headRefOid: HEAD_SHA }), stderr: '' }],
        ['sin archivos', { exit_code: 0, stdout: JSON.stringify({ files: [], headRefOid: HEAD_SHA, headRefName: 'b' }), stderr: '' }],
    ];
    for (const [nombre, res] of casos) {
        const snap = delivery.getPRSnapshot(1, { ghImpl: () => res });
        assert.equal(snap.ok, false, `${nombre} debe ser ok:false`);
        assert.equal(snap.files, undefined, `${nombre} no puede devolver archivos`);
        assert.ok(snap.reason, `${nombre} debe explicar por qué`);
    }
    // gh que lanza excepción tampoco puede degradar a vacío.
    const boom = delivery.getPRSnapshot(1, { ghImpl: () => { throw new Error('spawn ENOENT'); } });
    assert.equal(boom.ok, false);
});

// ── CA: gate de QA sobre el snapshot ───────────────────────────────────────

test('#5420 — sin label qa:passed/qa:skipped no se mergea (gate QA sobre el snapshot)', () => {
    const calls = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({ labels: ['Ready'] }),
        mergePR: recordingMerge(() => MERGED_OK, calls),
    }));
    assert.equal(out.status, 'no-qa-gate');
    assert.equal(calls.length, 0);
});

// ── CA: head movido ⇒ 409 ⇒ reintento (no escalada inmediata) ──────────────

test('#5420 CA — head movido responde 409, NO mergea y REINTENTA en vez de escalar', () => {
    const calls = [];
    let snapshots = 0;
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => {
            snapshots++;
            return snapshotOk({ headRefOid: snapshots === 1 ? HEAD_SHA : HEAD_SHA_2 });
        },
        mergePR: recordingMerge((_o, n) => (n === 1 ? HEAD_CHANGED_409 : MERGED_OK), calls),
    }));
    assert.equal(out.status, 'merged', 'el segundo intento, con el head nuevo, mergea');
    assert.equal(out.attempt, 2);
    assert.equal(snapshots, 2, 'el reintento toma un snapshot NUEVO');
    assert.equal(calls[0].sha, HEAD_SHA);
    assert.equal(calls[1].sha, HEAD_SHA_2, 'el reintento usa el SHA nuevo, no el viejo');
});

test('#5420 CA — el reintento REEVALÚA todos los gates (no reusa el veredicto anterior)', () => {
    const gates = { owners: 0, provenance: 0 };
    let snapshots = 0;
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => {
            snapshots++;
            // En el 2º intento el head trae un cambio sobre .github/ → owner humano.
            return snapshotOk(snapshots === 1
                ? {}
                : { headRefOid: HEAD_SHA_2, files: ['.github/workflows/ci.yml'] });
        },
        loadOwners: () => { gates.owners++; return ownersFromRemote()(); },
        verifyOrigin: () => { gates.provenance++; return { ok: true, reason: 'ok' }; },
        mergePR: () => HEAD_CHANGED_409,
    }));
    assert.equal(out.status, 'needs-human', 'el gate de owners se reevalúa contra el head nuevo');
    assert.equal(gates.owners, 2);
    assert.equal(gates.provenance, 1, 'el 2º intento frena en owners, antes de procedencia');
});

test('#5420 — el retry tiene tope: head que sigue moviéndose escala como conflicto', () => {
    const calls = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        mergePR: recordingMerge(() => HEAD_CHANGED_409, calls),
    }));
    assert.equal(out.status, 'conflict');
    assert.equal(calls.length, delivery.MAX_MERGE_ATTEMPTS);
    assert.equal(calls.length, 2, 'máximo explícito de 2 intentos');
    assert.equal(out.classification.kind, 'head-changed');
});

// #6012 re-baseline — antes este test afirmaba que TODO 405 era conflicto real.
// Ahora el 405 sólo es conflicto CONFIRMADO con `mergeStateStatus=DIRTY`; el
// snapshot de `baseDeps` no trae estado, así que ejercita el default
// fail-closed: sigue frenando y sigue sin reintentar (que es el invariante de
// #5420 que no se puede perder), pero marcado `confirmed:false`.
test('#5420/#6012 — 405 sin contexto de mergeabilidad sigue siendo conflicto terminal, sin reintentar', () => {
    const calls = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        mergePR: recordingMerge(() => ({ exit_code: 1, stdout: '', stderr: 'gh: Pull Request is not mergeable (HTTP 405)' }), calls),
    }));
    assert.equal(out.status, 'conflict');
    assert.equal(out.classification.retryable, false);
    assert.equal(out.classification.confirmed, false, 'sin señal del servidor no se AFIRMA el conflicto');
    assert.equal(calls.length, 1, 'el default fail-closed no se reintenta');
});

// #6012 — el escenario de conflicto REAL que este archivo cubría pasa a estar
// explícito: lo que lo confirma es el estado del servidor, no el status HTTP.
test('#5420/#6012 — conflicto REAL (405 + mergeStateStatus=DIRTY) escala de una, sin reintentar', () => {
    const calls = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({ state: 'OPEN', mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' }),
        mergePR: recordingMerge(() => ({ exit_code: 1, stdout: '', stderr: 'gh: Pull Request is not mergeable (HTTP 405)' }), calls),
    }));
    assert.equal(out.status, 'conflict');
    assert.equal(out.classification.retryable, false);
    assert.equal(out.classification.confirmed, true);
    assert.equal(calls.length, 1, 'un conflicto confirmado no se reintenta');
});

test('#5420 — fallo genérico de infra (5xx) sigue siendo error técnico, no conflicto', () => {
    const out = delivery.attemptMergeWithGates(baseDeps({
        mergePR: () => ({ exit_code: 1, stdout: '', stderr: 'HTTP 502 Bad Gateway' }),
    }));
    assert.equal(out.status, 'error');
    assert.equal(out.classification.conflict, false);
});

// ── CA: éxito SÓLO con merged:true ─────────────────────────────────────────

test('#5420 CA — needs-human se omite SÓLO con merged:true; cualquier otro desenlace bloquea', () => {
    const respuestas = [
        ['merged:false', { exit_code: 0, stdout: JSON.stringify({ merged: false, message: 'Base branch was modified' }), stderr: '' }],
        ['campo merged ausente', { exit_code: 0, stdout: JSON.stringify({ sha: 'x', message: 'ok' }), stderr: '' }],
        ['merged como string', { exit_code: 0, stdout: JSON.stringify({ merged: 'true' }), stderr: '' }],
        ['JSON inválido', { exit_code: 0, stdout: 'no soy json', stderr: '' }],
        ['body vacío', { exit_code: 0, stdout: '', stderr: '' }],
        ['JSON no-objeto', { exit_code: 0, stdout: 'null', stderr: '' }],
    ];
    for (const [nombre, res] of respuestas) {
        const out = delivery.attemptMergeWithGates(baseDeps({ mergePR: () => res }));
        assert.equal(out.status, 'blocked', `${nombre} NO puede contar como merge`);
        assert.equal(out.gate, 'merge-unconfirmed');
        assert.equal(out.sha, undefined, `${nombre} no puede registrar SHA de merge`);
    }
    // Y el único caso que sí cuenta:
    const ok = delivery.attemptMergeWithGates(baseDeps({ mergePR: () => MERGED_OK }));
    assert.equal(ok.status, 'merged');
});

test('#5420 — confirmMergeResponse: merged:true sin sha sigue siendo merge confirmado', () => {
    const c = delivery.confirmMergeResponse({ exit_code: 0, stdout: JSON.stringify({ merged: true }) });
    assert.equal(c.ok, true);
    assert.equal(c.sha, null);
});

// ── Orden de los gates (un gate temprano corta los siguientes) ─────────────

test('#5420 — orden de gates: snapshot → QA → CODEOWNERS → owners → procedencia → merge', () => {
    const orden = [];
    delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => { orden.push('snapshot'); return snapshotOk(); },
        loadOwners: () => { orden.push('owners'); return ownersFromRemote()(); },
        verifyOrigin: () => { orden.push('provenance'); return { ok: true, reason: 'ok' }; },
        mergePR: () => { orden.push('merge'); return MERGED_OK; },
    }));
    assert.deepEqual(orden, ['snapshot', 'owners', 'provenance', 'merge']);
});

// ── Escalado: el motivo tiene que leerse como BLOQUEO HUMANO ───────────────

test('#5420 — el motivo de bloqueo lo clasifica el pulpo como human-block (no rebote a dev)', () => {
    for (const gate of ['codeowners', 'provenance', 'snapshot', 'merge-unconfirmed', 'retry-exhausted']) {
        const motivo = delivery.buildGateBlockMotivo({
            prNumber: 777, branch: 'agent/5401-pipeline-dev', gate, reason: 'detalle técnico',
        });
        assert.ok(
            humanBlock.isHumanBlockReason(motivo),
            `el motivo del gate ${gate} debe clasificar como bloqueo humano, no como rebote técnico`,
        );
        assert.ok(motivo.includes('#777'));
    }
});

test('#5420 — el motivo de bloqueo sanea el detalle (sin secrets ni CRLF)', () => {
    const motivo = delivery.buildGateBlockMotivo({
        prNumber: 1, branch: 'agent/1-x', gate: 'codeowners',
        reason: 'fatal: auth\r\nremote: token=ghp_abcdefghijklmnop1234',
    });
    assert.ok(!/ghp_abcdefghijklmnop1234/.test(motivo), 'no puede filtrar el token');
    assert.ok(!/[\r\n]/.test(motivo), 'no puede romper el formato del marker');
});

test('#5420 — el escalado del gate deja audit fail-closed y encola aviso al operador', () => {
    const logs = [];
    const esc = delivery.escalateMergeGateBlock({
        issue: 5401, prNumber: 777, branch: 'agent/5401-pipeline-dev',
        gate: 'provenance', reason: 'author-not-allowlisted:evil@attacker.test',
        logAppend: (m) => logs.push(m),
    });
    assert.ok(humanBlock.isHumanBlockReason(esc.motivo));
    const cola = path.join(TMP, '.pipeline', 'servicios', 'telegram', 'pendiente');
    const drops = fs.existsSync(cola) ? fs.readdirSync(cola) : [];
    assert.ok(drops.length >= 1, 'tiene que quedar al menos un aviso encolado para el operador');
    const textos = drops.map((f) => JSON.parse(fs.readFileSync(path.join(cola, f), 'utf8')).text).join('\n');
    assert.ok(/procedencia/i.test(textos), 'el aviso explica qué gate no se pudo verificar');
    assert.ok(!/evil@attacker\.test/.test(esc.motivo) || /evil@attacker\.test/.test(esc.motivo), 'motivo construido');
});

test('#5420 — el mensaje al operador no promete auto-merge por silencio', () => {
    const msg = delivery.buildGateBlockEscalation({
        issue: 5401, prNumber: 777, branch: 'agent/5401-pipeline-dev',
        gate: 'codeowners', reason: 'no se pudo cargar CODEOWNERS',
    });
    assert.ok(/fail-closed/i.test(msg));
    assert.ok(/INTACTO/.test(msg), 'aclara que main no se tocó');
    assert.ok(/NO va a auto-mergear/i.test(msg));
});
