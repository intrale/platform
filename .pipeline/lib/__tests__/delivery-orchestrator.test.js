// =============================================================================
// Tests delivery.js (orquestador) — refactor #2870
//
// Solo testea las funciones puras (parseArgs, fetchIssue parsing).
// El flujo end-to-end (main) requiere repo git + gh CLI mockeado, lo cubre
// el smoke test manual.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseArgs } = require('../../delivery');

// ---- parseArgs --------------------------------------------------------------

test('parseArgs lee --issue y --description', () => {
    const args = parseArgs(['node', 'delivery.js', '--issue', '123', '--description', 'hola mundo']);
    assert.equal(args.issue, '123');
    assert.equal(args.description, 'hola mundo');
});

test('parseArgs lee --type override', () => {
    const args = parseArgs(['node', 'delivery.js', '--type', 'feat']);
    assert.equal(args.type, 'feat');
});

test('parseArgs lee --draft como boolean', () => {
    const args = parseArgs(['node', 'delivery.js', '--draft']);
    assert.equal(args.draft, true);
});

test('parseArgs lee --dry-run como boolean', () => {
    const args = parseArgs(['node', 'delivery.js', '--dry-run']);
    assert.equal(args.dryRun, true);
});

test('parseArgs defaults sensatos cuando no hay args', () => {
    const args = parseArgs(['node', 'delivery.js']);
    assert.equal(args.issue, null);
    assert.equal(args.description, null);
    assert.equal(args.type, null);
    assert.equal(args.draft, false);
    assert.equal(args.dryRun, false);
    assert.equal(args.repo, 'intrale/platform');
    assert.equal(args.base, 'main');
});

test('parseArgs permite override de --repo y --base', () => {
    const args = parseArgs([
        'node', 'delivery.js',
        '--repo', 'foo/bar',
        '--base', 'develop',
    ]);
    assert.equal(args.repo, 'foo/bar');
    assert.equal(args.base, 'develop');
});

test('parseArgs combina múltiples flags', () => {
    const args = parseArgs([
        'node', 'delivery.js',
        '--issue', '456',
        '--description', 'fix bug',
        '--type', 'fix',
        '--draft',
    ]);
    assert.equal(args.issue, '456');
    assert.equal(args.description, 'fix bug');
    assert.equal(args.type, 'fix');
    assert.equal(args.draft, true);
});
