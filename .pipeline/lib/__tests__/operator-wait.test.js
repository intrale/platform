// Tests de .pipeline/lib/operator-wait.js (issue #4588).
// Herméticos: se construye un pipelineDir temporal con los dos audit logs
// append-only (gate-verdicts.jsonl + operator-gate-signatures.jsonl) en el mismo
// formato que escriben el pulpo (GATE 0) y el operator-gate. `now` inyectable.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ow = require('../operator-wait');

const MIN = 60000;

function tmpPipelineDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opwait-'));
    fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });
    return dir;
}

/** Línea de ENTRADA a waiting-operator (como la escribe pulpo gate0Audit). */
function entryLine({ issue, fase, at }) {
    return JSON.stringify({
        event: 'transition',
        issue,
        actor: `pulpo:gate0:${fase}`,
        from: 'listo',
        to: 'waiting-operator',
        file: `${issue}.architect`,
        created_at: new Date(at).toISOString(),
    }) + '\n';
}

/** Línea de SALIDA (firma que cierra, 2º audit del operator-gate). */
function exitLine({ issue, at, gate = 'aprobado', result = 'aprobado' }) {
    return JSON.stringify({
        actor: '99999',
        action: 'approve',
        issue,
        tenant: null,
        gate,
        nonce: 'abc',
        result,
        ts: new Date(at).toISOString(),
        created_at: new Date(at).toISOString(),
    }) + '\n';
}

/** Línea de pre-transición (NO cierra el intervalo). */
function preTransitionLine({ issue, at }) {
    return JSON.stringify({
        actor: '99999',
        action: 'approve',
        issue,
        gate: null,
        result: 'accepted-before-transition',
        created_at: new Date(at).toISOString(),
    }) + '\n';
}

function writeAudit(dir, verdictsLines, sigLines) {
    fs.writeFileSync(path.join(dir, 'audit', 'gate-verdicts.jsonl'), verdictsLines.join(''), 'utf8');
    fs.writeFileSync(path.join(dir, 'audit', 'operator-gate-signatures.jsonl'), sigLines.join(''), 'utf8');
}

test('intervalo cerrado: mide la espera entre entrada y firma', () => {
    const dir = tmpPipelineDir();
    const t0 = 1_700_000_000_000;
    writeAudit(dir,
        [entryLine({ issue: 4588, fase: 'aprobacion', at: t0 })],
        [preTransitionLine({ issue: 4588, at: t0 + 30 * MIN }),
         exitLine({ issue: 4588, at: t0 + 30 * MIN })]);

    const r = ow.calculateOperatorWait([4588], { pipelineDir: dir, now: () => t0 + 60 * MIN });
    assert.equal(r.totalWaitMin, 30);
    assert.equal(r.openWaitMin, 0);
    assert.equal(r.closedWaitMin, 30);
    assert.equal(r.byGate['GATE 2'].waitMin, 30);
    assert.equal(r.byIssue['4588'].waitOperatorMin, 30);
});

test('intervalo abierto: usa now como cierre y lo marca como espera en curso', () => {
    const dir = tmpPipelineDir();
    const t0 = 1_700_000_000_000;
    writeAudit(dir,
        [entryLine({ issue: 4588, fase: 'criterios', at: t0 })],
        []);   // sin firma todavía

    const r = ow.calculateOperatorWait([4588], { pipelineDir: dir, now: () => t0 + 45 * MIN });
    assert.equal(r.openWaitMin, 45);
    assert.equal(r.totalWaitMin, 45);
    assert.equal(r.waitingNow.length, 1);
    assert.equal(r.waitingNow[0].issue, 4588);
    assert.equal(r.waitingNow[0].gateClass, 'GATE 1');
    assert.equal(r.operatorLatency.samples, 0);   // ninguna firma cerrada
});

test('agrega por clase de gate (GATE 1 def vs GATE 2 acept)', () => {
    const dir = tmpPipelineDir();
    const t0 = 1_700_000_000_000;
    writeAudit(dir,
        [
            entryLine({ issue: 10, fase: 'criterios', at: t0 }),
            entryLine({ issue: 20, fase: 'aprobacion', at: t0 }),
        ],
        [
            exitLine({ issue: 10, at: t0 + 10 * MIN }),
            exitLine({ issue: 20, at: t0 + 40 * MIN }),
        ]);

    const r = ow.calculateOperatorWait([10, 20], { pipelineDir: dir, now: () => t0 + 60 * MIN });
    assert.equal(r.byGate['GATE 1'].waitMin, 10);
    assert.equal(r.byGate['GATE 2'].waitMin, 40);
    assert.equal(r.totalWaitMin, 50);
});

test('distribución de latencia de operador: p50/p75/p90 sobre cerrados', () => {
    const dir = tmpPipelineDir();
    const t0 = 1_700_000_000_000;
    const verdicts = [];
    const sigs = [];
    // 4 firmas cerradas: 10, 20, 30, 40 min.
    [10, 20, 30, 40].forEach((m, i) => {
        const issue = 100 + i;
        verdicts.push(entryLine({ issue, fase: 'aprobacion', at: t0 }));
        sigs.push(exitLine({ issue, at: t0 + m * MIN }));
    });
    writeAudit(dir, verdicts, sigs);

    const r = ow.calculateOperatorWait([100, 101, 102, 103], { pipelineDir: dir, now: () => t0 + 100 * MIN });
    assert.equal(r.operatorLatency.samples, 4);
    assert.equal(r.operatorLatency.p50, 25);   // percentil lineal de [10,20,30,40]
    assert.equal(r.operatorLatency.maxMin, 40);
    assert.equal(r.operatorLatency.meanMin, 25);
});

test('robustez: líneas corruptas, timestamps NaN y fechas futuras no rompen', () => {
    const dir = tmpPipelineDir();
    const t0 = 1_700_000_000_000;
    fs.writeFileSync(path.join(dir, 'audit', 'gate-verdicts.jsonl'),
        'no-es-json\n'
        + entryLine({ issue: 4588, fase: 'aprobacion', at: t0 })
        + JSON.stringify({ event: 'transition', to: 'waiting-operator', issue: 'xx', created_at: 'nope' }) + '\n'
        // entrada con fecha FUTURA respecto de la firma → delta ≤ 0, waitMin=0
        + entryLine({ issue: 777, fase: 'aprobacion', at: t0 + 999 * MIN }),
        'utf8');
    fs.writeFileSync(path.join(dir, 'audit', 'operator-gate-signatures.jsonl'),
        '}{corrupta\n'
        + exitLine({ issue: 4588, at: t0 + 15 * MIN })
        + exitLine({ issue: 777, at: t0 + 10 * MIN }),
        'utf8');

    const r = ow.calculateOperatorWait([4588, 777], { pipelineDir: dir, now: () => t0 + 60 * MIN });
    assert.equal(r.byIssue['4588'].waitOperatorMin, 15);
    // #777: entrada futura respecto de su salida → intervalo no positivo → 0
    assert.equal(r.byIssue['777'].waitOperatorMin, 0);
    assert.ok(Number.isFinite(r.totalWaitMin));
});

test('sin audit logs: devuelve ceros sin lanzar (read-only, dir vacío)', () => {
    const dir = tmpPipelineDir();
    const r = ow.calculateOperatorWait([1, 2, 3], { pipelineDir: dir, now: () => Date.now() });
    assert.equal(r.totalWaitMin, 0);
    assert.equal(r.waitingNow.length, 0);
    assert.equal(r.operatorLatency.samples, 0);
});

test('filtra por lista de issues de la ola', () => {
    const dir = tmpPipelineDir();
    const t0 = 1_700_000_000_000;
    writeAudit(dir,
        [entryLine({ issue: 10, fase: 'aprobacion', at: t0 }),
         entryLine({ issue: 99, fase: 'aprobacion', at: t0 })],
        [exitLine({ issue: 10, at: t0 + 10 * MIN }),
         exitLine({ issue: 99, at: t0 + 50 * MIN })]);

    const r = ow.calculateOperatorWait([10], { pipelineDir: dir, now: () => t0 + 60 * MIN });
    assert.equal(r.totalWaitMin, 10);        // #99 excluido de la ola
    assert.equal(r.byIssue['99'], undefined);
});

test('evaluateOperatorWaitAlert dispara sobre esperas en curso > umbral', () => {
    const dir = tmpPipelineDir();
    const t0 = 1_700_000_000_000;
    writeAudit(dir,
        [entryLine({ issue: 4588, fase: 'aprobacion', at: t0 })],
        []);   // sigue esperando

    const r = ow.calculateOperatorWait([4588], { pipelineDir: dir, now: () => t0 + 180 * MIN });
    const alert = ow.evaluateOperatorWaitAlert(r, { thresholdMin: 120 });
    assert.equal(alert.shouldAlert, true);
    assert.equal(alert.offenders.length, 1);
    assert.equal(alert.offenders[0].issue, 4588);
    const msg = ow.formatOperatorWaitAlert(alert);
    assert.ok(msg && msg.includes('#4588'));
    // A09: sin paths ni tokens en el mensaje.
    assert.ok(!/\/|\\|token|secret/i.test(msg));
});

test('projectPendingOperatorWait: proyecta restante = max(0, p50 - yaEsperado)', () => {
    const dir = tmpPipelineDir();
    const t0 = 1_700_000_000_000;
    // Historia: 2 firmas cerradas de 20min ⇒ p50 = 20.
    // Más 1 issue en curso que ya esperó 5min ⇒ restante ≈ 15.
    writeAudit(dir,
        [
            entryLine({ issue: 1, fase: 'aprobacion', at: t0 }),
            entryLine({ issue: 2, fase: 'aprobacion', at: t0 }),
            entryLine({ issue: 3, fase: 'aprobacion', at: t0 + 55 * MIN }),
        ],
        [
            exitLine({ issue: 1, at: t0 + 20 * MIN }),
            exitLine({ issue: 2, at: t0 + 20 * MIN }),
        ]);
    const r = ow.calculateOperatorWait([1, 2, 3], { pipelineDir: dir, now: () => t0 + 60 * MIN });
    assert.equal(r.operatorLatency.p50, 20);
    const proj = ow.projectPendingOperatorWait(r);
    assert.equal(proj.perSignatureMin, 20);
    assert.equal(proj.pendingSignatures, 1);   // #3 sigue esperando (5min)
    assert.equal(proj.overdueSignatures, 0);
    assert.equal(proj.projectedWaitMin, 15);   // 20 - 5
});

test('projectPendingOperatorWait: firma vencida (yaEsperado > p50) cuenta overdue', () => {
    const dir = tmpPipelineDir();
    const t0 = 1_700_000_000_000;
    writeAudit(dir,
        [entryLine({ issue: 1, fase: 'aprobacion', at: t0 }),
         entryLine({ issue: 2, fase: 'aprobacion', at: t0 })],
        [exitLine({ issue: 1, at: t0 + 10 * MIN })]);   // p50 = 10; #2 abierto
    const r = ow.calculateOperatorWait([1, 2], { pipelineDir: dir, now: () => t0 + 90 * MIN });
    const proj = ow.projectPendingOperatorWait(r);
    assert.equal(proj.overdueSignatures, 1);   // #2 esperó 90min > p50 10
    assert.equal(proj.projectedWaitMin, 0);
});

test('projectPendingOperatorWait: sin historia no proyecta futuro', () => {
    const dir = tmpPipelineDir();
    const t0 = 1_700_000_000_000;
    writeAudit(dir, [entryLine({ issue: 1, fase: 'aprobacion', at: t0 })], []);
    const r = ow.calculateOperatorWait([1], { pipelineDir: dir, now: () => t0 + 30 * MIN });
    const proj = ow.projectPendingOperatorWait(r);
    assert.equal(proj.perSignatureMin, null);
    assert.equal(proj.pendingSignatures, 1);
    assert.equal(proj.projectedWaitMin, 0);
});

test('evaluateOperatorWaitAlert NO dispara bajo umbral', () => {
    const dir = tmpPipelineDir();
    const t0 = 1_700_000_000_000;
    writeAudit(dir,
        [entryLine({ issue: 4588, fase: 'aprobacion', at: t0 })], []);
    const r = ow.calculateOperatorWait([4588], { pipelineDir: dir, now: () => t0 + 30 * MIN });
    const alert = ow.evaluateOperatorWaitAlert(r, { thresholdMin: 120 });
    assert.equal(alert.shouldAlert, false);
    assert.equal(ow.formatOperatorWaitAlert(alert), null);
});
