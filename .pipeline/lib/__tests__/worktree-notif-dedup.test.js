// =============================================================================
// Tests worktree-notif-dedup.js — dedup persistente de notificaciones Telegram
// (#2591 CA-4 / security CA-4).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { shouldNotify, markNotified, clearDedup, buildDedupPath } = require('../worktree-notif-dedup');

function tmpStateDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wt-dedup-'));
}

test('shouldNotify — true en primera invocación (sin dedup previo)', () => {
    const stateDir = tmpStateDir();
    try {
        assert.equal(shouldNotify(2505, 'entrega', { stateDir }), true);
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
    }
});

test('shouldNotify — false inmediatamente después de markNotified', () => {
    const stateDir = tmpStateDir();
    try {
        markNotified(2505, 'entrega', { stateDir });
        assert.equal(shouldNotify(2505, 'entrega', { stateDir }), false);
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
    }
});

test('shouldNotify — true después de TTL expirado', () => {
    const stateDir = tmpStateDir();
    try {
        const past = Date.now() - 25 * 60 * 60 * 1000; // 25h atrás
        markNotified(2505, 'entrega', { stateDir, now: past });
        assert.equal(shouldNotify(2505, 'entrega', { stateDir }), true);
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
    }
});

test('shouldNotify — false antes de TTL', () => {
    const stateDir = tmpStateDir();
    try {
        const recent = Date.now() - 1 * 60 * 60 * 1000; // 1h atrás
        markNotified(2505, 'entrega', { stateDir, now: recent });
        assert.equal(shouldNotify(2505, 'entrega', { stateDir }), false);
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
    }
});

test('shouldNotify — dedup per-(issue,fase): distintas faseses cuentan separado', () => {
    const stateDir = tmpStateDir();
    try {
        markNotified(2505, 'entrega', { stateDir });
        assert.equal(shouldNotify(2505, 'entrega', { stateDir }), false);
        assert.equal(shouldNotify(2505, 'build', { stateDir }), true);
        assert.equal(shouldNotify(9999, 'entrega', { stateDir }), true);
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
    }
});

test('shouldNotify — true si contenido del dedup está corrupto', () => {
    const stateDir = tmpStateDir();
    try {
        const file = buildDedupPath(2505, 'entrega', stateDir);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'no-es-un-timestamp', 'utf8');
        assert.equal(shouldNotify(2505, 'entrega', { stateDir }), true);
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
    }
});

test('clearDedup — borra el archivo de dedup', () => {
    const stateDir = tmpStateDir();
    try {
        markNotified(2505, 'entrega', { stateDir });
        assert.equal(shouldNotify(2505, 'entrega', { stateDir }), false);
        clearDedup(2505, 'entrega', { stateDir });
        assert.equal(shouldNotify(2505, 'entrega', { stateDir }), true);
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
    }
});

test('buildDedupPath — issue inválido lanza', () => {
    assert.throws(() => buildDedupPath('abc', 'entrega', '/tmp/x'));
    assert.throws(() => buildDedupPath('1;rm', 'entrega', '/tmp/x'));
});

test('buildDedupPath — fase inválida lanza', () => {
    assert.throws(() => buildDedupPath(2505, 'Entrega', '/tmp/x'));   // mayúscula
    assert.throws(() => buildDedupPath(2505, '../escape', '/tmp/x')); // path traversal
    assert.throws(() => buildDedupPath(2505, 'fase con espacios', '/tmp/x'));
});

test('shouldNotify — false (silent abort) si filename es inválido', () => {
    // No queremos que un caller con bug pueda escribir paths arbitrarios.
    assert.equal(shouldNotify('abc', 'entrega', { stateDir: '/tmp' }), false);
});

test('markNotified — false silencioso si filename inválido', () => {
    assert.equal(markNotified(2505, '../escape', { stateDir: '/tmp' }), false);
});
