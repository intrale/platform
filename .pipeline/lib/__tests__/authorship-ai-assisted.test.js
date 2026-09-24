'use strict';
// #7631 — Generación asistida por IA desde el registro (CA-5).

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AI = require('../authorship/ai-assisted');
const cb = require('../delivery/commit-builder');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'authorship-ai-'));
after(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} });

let seq = 0;
function logs(archiveEvents, liveEvents) {
    const dir = path.join(tmpRoot, `c${++seq}`);
    fs.mkdirSync(dir);
    const archive = path.join(dir, 'activity-log.archive.jsonl');
    const live = path.join(dir, 'activity-log.jsonl');
    const dump = (evts) => evts.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n';
    if (archiveEvents) fs.writeFileSync(archive, dump(archiveEvents));
    if (liveEvents) fs.writeFileSync(live, dump(liveEvents));
    return [archive, live];
}

function start(skill, over = {}) {
    return { event: 'session:start', skill, issue: 7631, phase: 'dev', provider: 'anthropic', model: 'claude-opus-4-7', ts: '2026-09-23T17:00:00Z', ...over };
}

test('el registro gana al Co-Authored-By autoreportado del payload', () => {
    const files = logs(null, [start('pipeline-dev', { model: 'claude-sonnet-4-6' })]);
    const ai = AI.resolveAiAssisted({ issue: 7631, logFiles: files });
    assert.deepStrictEqual(ai, [{ provider: 'anthropic', model: 'claude-sonnet-4-6', role: 'pipeline-dev' }]);
    // El squash reubica el Co-Authored-By del LLM, pero la línea AI-Assisted
    // sale del registro, no de ese texto.
    const msg = cb.buildSquashMessage({
        issue: 7631,
        branchMessages: 'feat: x\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
        humanLine: 'none; 2026-09-23T17:00:00Z; missing',
        aiLine: require('../authorship/trailer').formatAiAssisted(ai),
    });
    assert.match(msg, /Intrale-AI-Assisted: anthropic\/claude-sonnet-4-6 \(pipeline-dev\)/);
});

test('modelo o proveedor fuera de la allowlist → unknown/unknown del rol', () => {
    const files = logs(null, [start('backend-dev', { model: 'modelo-inventado' }), start('web-dev', { provider: 'otro' })]);
    assert.deepStrictEqual(AI.resolveAiAssisted({ issue: 7631, logFiles: files }), [
        { provider: 'unknown', model: 'unknown', role: 'backend-dev' },
        { provider: 'unknown', model: 'unknown', role: 'web-dev' },
    ]);
});

test('sesión de dev sólo en el archive → se encuentra', () => {
    const files = logs([start('android-dev')], [start('guru')]);
    assert.deepStrictEqual(AI.resolveAiAssisted({ issue: 7631, logFiles: files }), [
        { provider: 'anthropic', model: 'claude-opus-4-7', role: 'android-dev' },
    ]);
});

test('sin sesión de dev pero con guru/delivery → unknown (nunca otro rol)', () => {
    const files = logs([start('guru')], [start('delivery', { provider: 'deterministic', model: 'deterministic' }), start('po')]);
    assert.strictEqual(AI.resolveAiAssisted({ issue: 7631, logFiles: files }), 'unknown');
});

test('varios roles → deduplicados, última sesión por rol y orden estable', () => {
    const files = logs(
        [start('pipeline-dev', { model: 'claude-sonnet-4-6' })],
        [start('web-dev'), start('pipeline-dev'), start('backend-dev', { provider: 'codex', model: 'gpt-5.5' }), start('web-dev')]
    );
    assert.deepStrictEqual(AI.resolveAiAssisted({ issue: 7631, logFiles: files }), [
        { provider: 'codex', model: 'gpt-5.5', role: 'backend-dev' },
        { provider: 'anthropic', model: 'claude-opus-4-7', role: 'pipeline-dev' },
        { provider: 'anthropic', model: 'claude-opus-4-7', role: 'web-dev' },
    ]);
});

test('deterministic excluido, otros issues ignorados y líneas corruptas toleradas', () => {
    const files = logs(null, [
        '{"event":"session:start","skill":"pipeline-dev","iss',
        start('pipeline-dev', { provider: 'deterministic' }),
        start('pipeline-dev', { model: 'deterministic' }),
        start('pipeline-dev', { issue: 1 }),
        'no json',
        { event: 'session:end', skill: 'pipeline-dev', issue: 7631 },
    ]);
    assert.strictEqual(AI.resolveAiAssisted({ issue: 7631, logFiles: files }), 'unknown');
    assert.strictEqual(AI.resolveAiAssisted({ issue: 'x', logFiles: files }), 'unknown');
    assert.strictEqual(AI.resolveAiAssisted({ issue: 7631, logFiles: [path.join(tmpRoot, 'nada.jsonl')] }), 'unknown');
    assert.strictEqual(AI.resolveAiAssisted({ issue: 7631, logFiles: null }), 'unknown');
});

test('la cola de un archivo grande se lee descartando la primera línea cortada', () => {
    const fakeFs = {
        existsSync: () => true,
        statSync: () => ({ size: 20 * 1024 * 1024 }),
        openSync: () => 1,
        closeSync: () => {},
        readSync: (fd, buf) => { const s = Buffer.from(`xx"}\n${JSON.stringify(start('pipeline-dev'))}\n`); s.copy(buf); return s.length; },
    };
    const r = AI.resolveAiAssisted({ issue: 7631, logFiles: ['a'], fsImpl: fakeFs });
    assert.deepStrictEqual(r, [{ provider: 'anthropic', model: 'claude-opus-4-7', role: 'pipeline-dev' }]);
    const broken = { existsSync: () => { throw new Error('x'); } };
    assert.strictEqual(AI.resolveAiAssisted({ issue: 7631, logFiles: ['a'], fsImpl: broken }), 'unknown');
});

test('GENERATOR_ROLES y MODEL_ALLOWLIST están congelados y la default apunta al activity-log', () => {
    assert.ok(Object.isFrozen(AI.GENERATOR_ROLES));
    assert.ok(Object.isFrozen(AI.MODEL_ALLOWLIST));
    assert.ok(AI.MODEL_ALLOWLIST.claude.includes('claude-opus-4-7'));
    const d = AI.defaultLogFiles();
    assert.strictEqual(path.basename(d[0]), 'activity-log.archive.jsonl');
    assert.strictEqual(path.basename(d[1]), 'activity-log.jsonl');
});
