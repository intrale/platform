'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    classifyMergeFailure,
    getPRSnapshot,
    attemptMergeWithGates,
    buildGateBlockMotivo,
    buildGateBlockEscalation,
    GATE_BLOCK_LABELS,
} = require('../delivery');

const blocked405 = { exit_code: 1, stderr: 'HTTP 405: Pull Request is not mergeable' };
const pending = [{ status: 'IN_PROGRESS', conclusion: null, name: 'CI' }];
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS', name: 'CI' }];
const failing = [{ status: 'COMPLETED', conclusion: 'FAILURE', name: 'CI' }];

test('clasifica BLOCKED con checks pendientes como reintentable', () => {
    const result = classifyMergeFailure(blocked405, { mergeStateStatus: 'BLOCKED', statusCheckRollup: pending });
    assert.equal(result.kind, 'checks-in-flight');
    assert.equal(result.retryable, true);
});

test('clasifica BLOCKED con checks rojos como bloqueo sin reintento', () => {
    const result = classifyMergeFailure(blocked405, { mergeStateStatus: 'BLOCKED', statusCheckRollup: failing });
    assert.equal(result.kind, 'gate-block');
    assert.equal(result.gate, 'checks-failing');
    assert.equal(result.retryable, false);
});

test('clasifica BLOCKED con checks verdes como aprobación humana pendiente', () => {
    const result = classifyMergeFailure(blocked405, { mergeStateStatus: 'BLOCKED', statusCheckRollup: green });
    assert.equal(result.kind, 'gate-block');
    assert.equal(result.gate, 'branch-protection');
});

test('clasifica BLOCKED sin rollup legible de forma fail-closed', () => {
    const result = classifyMergeFailure(blocked405, { mergeStateStatus: 'BLOCKED' });
    assert.equal(result.kind, 'gate-block');
    assert.equal(result.retryable, false);
});

test('DRAFT conserva el bloqueo sin reintento', () => {
    const result = classifyMergeFailure(blocked405, { mergeStateStatus: 'DRAFT', statusCheckRollup: pending });
    assert.equal(result.kind, 'gate-block');
    assert.equal(result.gate, 'pr-draft');
    assert.equal(result.retryable, false);
});

test('getPRSnapshot solicita y propaga statusCheckRollup', () => {
    let fields = '';
    const result = getPRSnapshot(10, { ghImpl(args) {
        fields = args[args.indexOf('--json') + 1];
        return { exit_code: 0, stdout: JSON.stringify({
            labels: [{ name: 'qa:passed' }], files: [{ path: '.pipeline/x.js' }],
            headRefOid: 'abcdef1234567', headRefName: 'agent/10-x', mergeStateStatus: 'BLOCKED',
            state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: pending,
        }) };
    } });
    assert.match(fields, /statusCheckRollup/);
    assert.deepEqual(result.statusCheckRollup, pending);
});

test('usa presupuesto propio para checks y escala con motivo de timeout de CI', () => {
    let reads = 0;
    const sleeps = [];
    const result = attemptMergeWithGates({
        prNumber: 10,
        getSnapshot() {
            reads++;
            return { ok: true, labels: ['qa:passed'], files: ['.pipeline/x.js'], headRefOid: 'abcdef1234567',
                headRefName: 'agent/10-x', mergeStateStatus: reads === 1 ? 'UNKNOWN' : 'BLOCKED',
                state: 'OPEN', statusCheckRollup: pending };
        },
        loadOwners: () => ({ ok: true, rules: [] }),
        verifyOrigin: () => ({ ok: true }),
        mergePR: () => blocked405,
        sleepImpl: (ms) => sleeps.push(ms),
        maxMergeabilityWaits: 1,
        mergeChecksTimeoutMs: 20,
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.gate, 'checks-timeout');
    assert.equal(result.checksWaitedMs, 20);
    assert.deepEqual(sleeps, [1000, 20]);
    assert.match(result.reason, /CI no terminó/);
});

test('el timeout de CI tiene copy propio sin coda falsa de procedencia', () => {
    assert.match(GATE_BLOCK_LABELS['checks-timeout'], /CI no terminó/);
    const motivo = buildGateBlockMotivo({ gate: 'checks-timeout', reason: 'la CI no terminó en 6 minutos' });
    assert.match(motivo, /CI no terminó/);
    assert.doesNotMatch(motivo, /sin poder verificar owners, procedencia y SHA/);
    const escalado = buildGateBlockEscalation({ issue: 6347, gate: 'checks-timeout', reason: 'la CI no terminó' });
    assert.doesNotMatch(escalado, /no pude hacer es \*comprobar\*/);
    assert.match(escalado, /checks requeridos siguieron en curso/);
});
