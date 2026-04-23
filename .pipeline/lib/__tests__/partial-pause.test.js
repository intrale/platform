// Tests de .pipeline/lib/partial-pause.js (issue #2490)
// Valida precedencia paused > partial_pause > running, allowlist, y normalización.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Aislar el módulo a un tmp dir
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-partial-pause-'));
process.env.PIPELINE_DIR_OVERRIDE = TMP_DIR;

delete require.cache[require.resolve('../partial-pause')];
const pp = require('../partial-pause');

function resetFs() {
    const { PARTIAL_FILE, PAUSE_FILE } = pp._paths();
    try { fs.unlinkSync(PARTIAL_FILE); } catch {}
    try { fs.unlinkSync(PAUSE_FILE); } catch {}
}

test('getPipelineMode retorna running cuando no hay ningún marker', () => {
    resetFs();
    const state = pp.getPipelineMode();
    assert.equal(state.mode, 'running');
    assert.deepEqual(state.allowedIssues, []);
});

test('isIssueAllowed retorna true para cualquier issue cuando pipeline está running', () => {
    resetFs();
    assert.equal(pp.isIssueAllowed(2490), true);
    assert.equal(pp.isIssueAllowed('2491'), true);
    assert.equal(pp.isIssueAllowed('#9999'), true);
});

test('setPartialPause con [2490, 2491] activa partial_pause', () => {
    resetFs();
    const result = pp.setPartialPause([2490, 2491], { source: 'telegram' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.allowedIssues, [2490, 2491]);

    const state = pp.getPipelineMode();
    assert.equal(state.mode, 'partial_pause');
    assert.deepEqual(state.allowedIssues, [2490, 2491]);
    assert.equal(state.source, 'telegram');
    assert.ok(state.createdAt);
});

test('isIssueAllowed respeta allowlist en modo partial_pause', () => {
    resetFs();
    pp.setPartialPause([2490, 2491]);
    assert.equal(pp.isIssueAllowed(2490), true);
    assert.equal(pp.isIssueAllowed(2491), true);
    assert.equal(pp.isIssueAllowed(2500), false);
    assert.equal(pp.isIssueAllowed('#2490'), true);
    assert.equal(pp.isIssueAllowed('9999'), false);
});

test('setPartialPause normaliza strings, "#prefix" y descarta valores inválidos', () => {
    resetFs();
    const result = pp.setPartialPause(['#2490', '2491', 'abc', 0, -5, null, '  2492 '], { source: 'test' });
    assert.deepEqual(result.allowedIssues, [2490, 2491, 2492]);
});

test('setPartialPause deduplica y ordena', () => {
    resetFs();
    const result = pp.setPartialPause([2491, 2490, 2491, 2490, 2492]);
    assert.deepEqual(result.allowedIssues, [2490, 2491, 2492]);
});

test('setPartialPause con lista vacía elimina el marker', () => {
    resetFs();
    pp.setPartialPause([2490]);
    assert.equal(pp.getPipelineMode().mode, 'partial_pause');

    const result = pp.setPartialPause([]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.allowedIssues, []);
    assert.equal(pp.getPipelineMode().mode, 'running');
});

test('clearPartialPause elimina el marker y reporta si existía', () => {
    resetFs();
    pp.setPartialPause([2490]);
    const r1 = pp.clearPartialPause();
    assert.equal(r1.existed, true);
    assert.equal(pp.getPipelineMode().mode, 'running');

    const r2 = pp.clearPartialPause();
    assert.equal(r2.existed, false);
});

test('precedencia: .paused gana sobre .partial-pause.json', () => {
    resetFs();
    pp.setPartialPause([2490, 2491]);

    // Simular pausa completa
    const { PAUSE_FILE } = pp._paths();
    fs.writeFileSync(PAUSE_FILE, new Date().toISOString());

    const state = pp.getPipelineMode();
    assert.equal(state.mode, 'paused');
    assert.equal(pp.isIssueAllowed(2490), false);  // incluso el allowed queda bloqueado
    assert.equal(pp.isIssueAllowed(2491), false);
});

test('resumeAll elimina ambos markers', () => {
    resetFs();
    pp.setPartialPause([2490]);
    const { PAUSE_FILE } = pp._paths();
    fs.writeFileSync(PAUSE_FILE, new Date().toISOString());

    const result = pp.resumeAll();
    assert.equal(result.removedFull, true);
    assert.equal(result.removedPartial, true);
    assert.equal(pp.getPipelineMode().mode, 'running');
});

test('resumeAll sin markers es no-op', () => {
    resetFs();
    const result = pp.resumeAll();
    assert.equal(result.removedFull, false);
    assert.equal(result.removedPartial, false);
});

test('JSON corrupto → modo running (fail-open, no se cuelga)', () => {
    resetFs();
    const { PARTIAL_FILE } = pp._paths();
    fs.writeFileSync(PARTIAL_FILE, '{malformed json');

    const state = pp.getPipelineMode();
    assert.equal(state.mode, 'running');
});

test('JSON válido sin allowed_issues → modo running', () => {
    resetFs();
    const { PARTIAL_FILE } = pp._paths();
    fs.writeFileSync(PARTIAL_FILE, JSON.stringify({ other_field: 'x' }));

    const state = pp.getPipelineMode();
    assert.equal(state.mode, 'running');
});

test('allowed_issues vacío en el JSON → modo running', () => {
    resetFs();
    const { PARTIAL_FILE } = pp._paths();
    fs.writeFileSync(PARTIAL_FILE, JSON.stringify({ allowed_issues: [] }));

    const state = pp.getPipelineMode();
    assert.equal(state.mode, 'running');
});

test('isIssueAllowed(null|undefined|"abc") retorna false sin error', () => {
    resetFs();
    pp.setPartialPause([2490]);
    assert.equal(pp.isIssueAllowed(null), false);
    assert.equal(pp.isIssueAllowed(undefined), false);
    assert.equal(pp.isIssueAllowed('abc'), false);
});
