'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    reconcileWaveCompletion,
    buildWaveCompletionMessage,
    escapeMarkdownText,
} = require('../servicio-reconciler');

function fakeDeps({ closedCount, totalIssues = 2, notifyOk = true, title = 'Issue listo' } = {}) {
    const wave = {
        number: 9,
        name: 'Ola 9.1',
        goal: 'kernel operativo',
        completion_notified: false,
    };
    const calls = {
        notified: 0,
        set: 0,
        clear: 0,
        messages: [],
    };
    const snapshot = {
        totalIssues,
        closedCount,
        totalPct: totalIssues > 0 ? Math.round((closedCount * 100) / totalIssues) : 0,
        issues: Array.from({ length: totalIssues }, (_, idx) => ({
            id: 4661 + idx,
            title: idx === 0 ? title : `Issue ${idx + 1}`,
            isClosed: idx < closedCount,
        })),
    };

    return {
        wave,
        calls,
        deps: {
            pipelineRoot: 'fake-root',
            waves: {
                getActiveWave() {
                    return { ...wave };
                },
                setWaveCompletionNotified(waveNumber) {
                    assert.strictEqual(waveNumber, wave.number);
                    calls.set += 1;
                    wave.completion_notified = true;
                    return true;
                },
                clearWaveCompletionNotified(waveNumber) {
                    assert.strictEqual(waveNumber, wave.number);
                    calls.clear += 1;
                    delete wave.completion_notified;
                    return true;
                },
            },
            waveResolver: {
                resolveActiveWave() {
                    return { label: 'Ola 9.1', issues: [4661, 4662], source: 'waves.json', resolved: true };
                },
            },
            waveState: {
                getCachedWaveState() {
                    return { issueMatrix: {}, issueTitles: {} };
                },
            },
            computeClosedSet() {
                return new Set(snapshot.issues.filter((i) => i.isClosed).map((i) => i.id));
            },
            waveSnapshot: {
                buildWaveSnapshot() {
                    return snapshot;
                },
            },
            notifyTelegram(payload) {
                calls.notified += 1;
                calls.messages.push(payload.message);
                return notifyOk ? { ok: true, dropPath: 'fake-drop.json' } : { ok: false, reason: 'write_failed' };
            },
        },
    };
}

test('reconcileWaveCompletion encola un aviso al cruzar 100% y persiste el flag', () => {
    const f = fakeDeps({ closedCount: 2 });
    const res = reconcileWaveCompletion(f.deps);

    assert.strictEqual(res.notified, true);
    assert.strictEqual(f.calls.notified, 1);
    assert.strictEqual(f.calls.set, 1);
    assert.strictEqual(f.wave.completion_notified, true);
    assert.match(f.calls.messages[0], /Ola 9 completada/);
    assert.match(f.calls.messages[0], /2\/2 issues - 100%/);
});

test('reconcileWaveCompletion es idempotente para una ola completa ya notificada', () => {
    const f = fakeDeps({ closedCount: 2 });
    reconcileWaveCompletion(f.deps);
    const second = reconcileWaveCompletion(f.deps);

    assert.strictEqual(second.notified, false);
    assert.strictEqual(f.calls.notified, 1);
    assert.strictEqual(f.calls.set, 1);
});

test('reconcileWaveCompletion limpia el flag si la ola baja de 100%', () => {
    const f = fakeDeps({ closedCount: 1 });
    f.wave.completion_notified = true;

    const res = reconcileWaveCompletion(f.deps);

    assert.strictEqual(res.reset, true);
    assert.strictEqual(f.calls.clear, 1);
    assert.strictEqual(f.wave.completion_notified, undefined);
    assert.strictEqual(f.calls.notified, 0);
});

test('reconcileWaveCompletion reemite despues de resetear y volver a 100%', () => {
    const f = fakeDeps({ closedCount: 1 });
    f.wave.completion_notified = true;
    reconcileWaveCompletion(f.deps);

    f.deps.waveSnapshot.buildWaveSnapshot = () => ({
        totalIssues: 2,
        closedCount: 2,
        totalPct: 100,
        issues: [
            { id: 4661, title: 'A', isClosed: true },
            { id: 4662, title: 'B', isClosed: true },
        ],
    });
    const res = reconcileWaveCompletion(f.deps);

    assert.strictEqual(res.notified, true);
    assert.strictEqual(f.calls.notified, 1);
    assert.strictEqual(f.calls.set, 1);
});

test('reconcileWaveCompletion no marca el flag si falla el encolado', () => {
    const f = fakeDeps({ closedCount: 2, notifyOk: false });
    const res = reconcileWaveCompletion(f.deps);

    assert.strictEqual(res.notifyFailed, true);
    assert.strictEqual(f.calls.notified, 1);
    assert.strictEqual(f.calls.set, 0);
    assert.strictEqual(f.wave.completion_notified, false);
});

test('reconcileWaveCompletion no emite avisos parciales', () => {
    const f = fakeDeps({ closedCount: 1 });
    const res = reconcileWaveCompletion(f.deps);

    assert.strictEqual(res.complete, false);
    assert.strictEqual(f.calls.notified, 0);
    assert.strictEqual(f.calls.set, 0);
});

test('buildWaveCompletionMessage escapa titulos Markdown de GitHub', () => {
    const msg = buildWaveCompletionMessage(
        { number: 9, name: 'Ola 9.1', goal: 'kernel_operativo' },
        {
            totalIssues: 1,
            closedCount: 1,
            issues: [{ id: 4661, title: 'fix_[a]*(b) `token`', isClosed: true }],
        },
    );

    assert.ok(msg.includes('fix\\_\\[a\\]\\*\\(b\\) \\`token\\`'));
    assert.ok(msg.includes('kernel\\_operativo'));
    assert.strictEqual(escapeMarkdownText('a_b*[c](d)`e`'), 'a\\_b\\*\\[c\\]\\(d\\)\\`e\\`');
});
