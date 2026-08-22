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

// =============================================================================
// #5421 CA-9 — skills afectados + retrocompatibilidad del formato del archivo.
// =============================================================================

const { recordSkill, readSkills } = require('../worktree-notif-dedup');

test('CA-9 — 3 escaladas del mismo (issue, fase) con skills distintos ⇒ UNA sola alerta', () => {
    const stateDir = tmpStateDir();
    try {
        let alertas = 0;
        for (const skill of ['po', 'review', 'ux']) {
            // Orden real del pulpo: recordSkill ANTES de shouldNotify.
            recordSkill(1123, 'validacion', skill, { stateDir });
            if (shouldNotify(1123, 'validacion', { stateDir })) {
                alertas += 1;
                markNotified(1123, 'validacion', { stateDir });
            }
        }
        assert.equal(alertas, 1, 'el dedup debe colapsar las 3 escaladas en una alerta');
        assert.deepEqual(readSkills(1123, 'validacion', { stateDir }), ['po', 'review', 'ux']);
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
    }
});

test('CA-9 — recordSkill NO marca como notificado (no se come la primera alerta)', () => {
    const stateDir = tmpStateDir();
    try {
        recordSkill(1123, 'validacion', 'po', { stateDir });
        assert.equal(shouldNotify(1123, 'validacion', { stateDir }), true);
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
    }
});

test('CA-9 — los skills registrados sobreviven a markNotified', () => {
    const stateDir = tmpStateDir();
    try {
        recordSkill(1123, 'validacion', 'po', { stateDir });
        markNotified(1123, 'validacion', { stateDir });
        recordSkill(1123, 'validacion', 'review', { stateDir });
        assert.deepEqual(readSkills(1123, 'validacion', { stateDir }), ['po', 'review']);
        // Y el dedup sigue vigente después de registrar el segundo skill.
        assert.equal(shouldNotify(1123, 'validacion', { stateDir }), false);
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
    }
});

test('CA-9 — recordSkill es idempotente (no duplica)', () => {
    const stateDir = tmpStateDir();
    try {
        recordSkill(1123, 'validacion', 'po', { stateDir });
        recordSkill(1123, 'validacion', 'po', { stateDir });
        assert.deepEqual(readSkills(1123, 'validacion', { stateDir }), ['po']);
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
    }
});

test('CA-9 — recordSkill rechaza skills con forma inválida (no los escribe)', () => {
    const stateDir = tmpStateDir();
    try {
        assert.equal(recordSkill(1123, 'validacion', '../escape', { stateDir }), false);
        assert.equal(recordSkill(1123, 'validacion', 'PO', { stateDir }), false);
        assert.equal(recordSkill(1123, 'validacion', '', { stateDir }), false);
        assert.deepEqual(readSkills(1123, 'validacion', { stateDir }), []);
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
    }
});

test('CA-9 — readSkills devuelve [] con filename inválido, sin lanzar', () => {
    assert.deepEqual(readSkills('abc', 'entrega', { stateDir: '/tmp' }), []);
    assert.deepEqual(readSkills(1123, '../escape', { stateDir: '/tmp' }), []);
});

test('retrocompat — un archivo legacy (timestamp ISO plano) sigue dedupeando', () => {
    const stateDir = tmpStateDir();
    try {
        // Formato viejo: exactamente lo que hay hoy vivo en `state/`.
        const p = buildDedupPath(1123, 'validacion', stateDir);
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(p, new Date().toISOString(), 'utf8');
        // Si lo tratáramos como corrupto, esto daría true y re-floodearía Telegram.
        assert.equal(shouldNotify(1123, 'validacion', { stateDir }), false);
        assert.deepEqual(readSkills(1123, 'validacion', { stateDir }), []);
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
    }
});

test('retrocompat — un archivo legacy vencido sí re-notifica (TTL respetado)', () => {
    const stateDir = tmpStateDir();
    try {
        const p = buildDedupPath(1123, 'validacion', stateDir);
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(p, new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), 'utf8');
        assert.equal(shouldNotify(1123, 'validacion', { stateDir }), true);
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
    }
});

test('retrocompat — recordSkill sobre un archivo legacy preserva el ts (no re-notifica)', () => {
    const stateDir = tmpStateDir();
    try {
        const p = buildDedupPath(1123, 'validacion', stateDir);
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(p, new Date().toISOString(), 'utf8');
        recordSkill(1123, 'validacion', 'review', { stateDir });
        assert.equal(shouldNotify(1123, 'validacion', { stateDir }), false);
        assert.deepEqual(readSkills(1123, 'validacion', { stateDir }), ['review']);
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
    }
});

test('contenido corrupto → se re-notifica (conservador) y skills vacíos', () => {
    const stateDir = tmpStateDir();
    try {
        const p = buildDedupPath(1123, 'validacion', stateDir);
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(p, '{esto no es json', 'utf8');
        assert.equal(shouldNotify(1123, 'validacion', { stateDir }), true);
        assert.deepEqual(readSkills(1123, 'validacion', { stateDir }), []);
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
    }
});
