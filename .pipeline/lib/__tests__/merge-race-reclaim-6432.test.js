'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const humanBlock = require('../human-block');
const core = require('../brazo-desbloqueo-core');
const ledgerStore = require('../merge-race-reclaim-ledger');

const SHA = 'a'.repeat(40);
function marker(overrides = {}) { return { issue: 6432, precondition: { type: 'merge_checks_race', pr: 6500, head_sha: SHA }, ...overrides }; }
function pr(overrides = {}) { return { number: 6500, url: 'https://github.com/intrale/platform/pull/6500', labels: [{ name: 'qa:passed' }], headRefName: 'agent/6432-rescate', isCrossRepository: false, headRepositoryOwner: { login: 'intrale' }, state: 'OPEN', mergeStateStatus: 'CLEAN', headRefOid: SHA, ...overrides }; }

test('normalizePrecondition acepta sólo PR canónico y SHA completo', () => {
  assert.deepEqual(humanBlock.normalizePrecondition({ type: 'merge_checks_race', pr: 6500, head_sha: SHA.toUpperCase() }), { type: 'merge_checks_race', pr: 6500, head_sha: SHA });
  for (const value of ['6500', '06500', 0, -1, 1.5]) assert.deepEqual(humanBlock.normalizePrecondition({ type: 'merge_checks_race', pr: value, head_sha: SHA }), { type: 'human_judgment' });
  for (const value of ['a'.repeat(7), 'a'.repeat(41), 'z'.repeat(40), null]) assert.deepEqual(humanBlock.normalizePrecondition({ type: 'merge_checks_race', pr: 6500, head_sha: value }), { type: 'human_judgment' });
});

test('dependency tiene precedencia sobre merge_checks_race', () => {
  assert.deepEqual(humanBlock.classifyPrecondition([{ depende_de: [12], precondicion_merge_checks: { pr: 6500, head_sha: SHA } }], [], { issue: 6432 }), { type: 'dependency', depends_on: [12] });
});

test('selector reclama únicamente PR propio, pinneado, mergeable y con qa:passed', () => {
  const result = core.selectMergeRaceBlocksToReclaim({ markers: [marker()], prStates: { 6500: pr() }, ledger: {} });
  assert.deepEqual(result.toReclaim, [marker()]);
  const denied = [
    pr({ headRefOid: 'b'.repeat(40) }), pr({ isCrossRepository: true }), pr({ headRepositoryOwner: { login: 'otro' } }),
    pr({ headRefName: 'agent/64321-rescate' }), pr({ labels: [{ name: 'qa:skipped' }] }), pr({ state: 'CLOSED' }), pr({ mergeStateStatus: 'BLOCKED' }),
  ];
  for (const state of denied) assert.equal(core.selectMergeRaceBlocksToReclaim({ markers: [marker()], prStates: { 6500: state }, ledger: {} }).toReclaim.length, 0);
});

test('selector ignora otros tipos y degrada al agotar intentos', () => {
  const other = [{ issue: 1, precondition: { type: 'human_judgment' } }, { issue: 2, precondition: { type: 'dependency', depends_on: [3] } }];
  const untouched = core.selectMergeRaceBlocksToReclaim({ markers: other, prStates: {}, ledger: {} });
  assert.deepEqual(untouched, { toReclaim: [], toDegrade: [], skipped: [] });
  const exhausted = core.selectMergeRaceBlocksToReclaim({ markers: [marker()], prStates: { 6500: pr() }, ledger: { 6432: { pr: 6500, head_sha: SHA, attempts: 3 } }, maxAttempts: 3 });
  assert.deepEqual(exhausted.toDegrade, [marker()]);
});

test('ledger persiste intentos por issue y degradación pegajosa', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-race-'));
  const file = path.join(dir, 'ledger.json');
  ledgerStore.recordAttempt({ issue: 6432, pr: 6500, head_sha: SHA, file });
  ledgerStore.recordAttempt({ issue: 6432, pr: 6500, head_sha: SHA, file });
  ledgerStore.markDegraded({ issue: 6432, pr: 6500, head_sha: SHA, file });
  const entry = ledgerStore.getEntry(6432, file);
  assert.equal(entry.attempts, 2); assert.equal(entry.degraded, true);
});
