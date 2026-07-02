// =============================================================================
// wave-audit-slice.test.js — Slice del dashboard `waveIssueAuditSlice` (#4371
// CA-8/CA-10): tail de eventos, stats 24h, clasificación visual y estado de la
// cadena.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/wave-audit-slice.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let slices;
let waveAudit;

function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-audit-slice-'));
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    delete require.cache[require.resolve('../dashboard-slices')];
    delete require.cache[require.resolve('../wave-audit')];
    delete require.cache[require.resolve('../audit-log')];
    slices = require('../dashboard-slices');
    waveAudit = require('../wave-audit');
    return dir;
}

function teardown(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    delete process.env.PIPELINE_DIR_OVERRIDE;
}

// ─── clasificación visual ────────────────────────────────────────────────────

test('classifyWaveAuditVisual mapea actor→estado y prioridad→D', () => {
    const c = require('../dashboard-slices')._classifyWaveAuditVisual;
    assert.equal(c({ event: 'issue_added', actor: 'Leo' }), 'human');
    assert.equal(c({ event: 'issue_added', actor: 'System' }), 'subsystem');
    assert.equal(c({ event: 'issue_added', actor: 'pulpo:cleanup' }), 'subsystem');
    assert.equal(c({ event: 'issue_added', actor: 'desconocido' }), 'unauthorized');
    assert.equal(c({ event: 'issue_added', actor: null }), 'unauthorized');
    assert.equal(c({ event: 'priority_changed', actor: 'Leo' }), 'priority');
});

// ─── slice happy path ────────────────────────────────────────────────────────

test('waveIssueAuditSlice devuelve entries, stats 24h y chain OK', () => {
    const dir = setup();
    try {
        waveAudit.recordWaveEvent({ event: 'issue_added', wave: 3, issue: 100, actor: 'Leo' });
        waveAudit.recordWaveEvent({ event: 'priority_changed', issue: 100, actor: 'Leo', prioridad_nueva: 'priority:high' });
        waveAudit.recordWaveEvent({ event: 'issue_removed', wave: 3, issue: 100, actor: 'desconocido' });

        const s = slices.waveIssueAuditSlice({}, { limit: 5 });
        assert.equal(s.entries.length, 3);
        assert.equal(s.stats.total, 3);
        assert.equal(s.stats.cambios_prioridad, 1);
        assert.equal(s.stats.sin_autoria, 1);
        assert.equal(s.stats.con_autoria, 2);
        assert.equal(s.chain_broken, false);
        assert.equal(s.has_unauthorized, true);
        // La última entry es la más reciente (issue_removed) y su visual es C.
        assert.equal(s.entries[2].visual, 'unauthorized');
    } finally {
        teardown(dir);
    }
});

test('waveIssueAuditSlice sin log devuelve vacío sin romper', () => {
    const dir = setup();
    try {
        const s = slices.waveIssueAuditSlice({}, {});
        assert.deepEqual(s.entries, []);
        assert.equal(s.stats.total, 0);
        assert.equal(s.chain_broken, false);
    } finally {
        teardown(dir);
    }
});

test('waveIssueAuditSlice refleja chain roto', () => {
    const dir = setup();
    try {
        waveAudit.recordWaveEvent({ event: 'issue_added', wave: 1, issue: 10, actor: 'Leo' });
        waveAudit.recordWaveEvent({ event: 'issue_added', wave: 1, issue: 11, actor: 'Leo' });
        // Corromper la primera línea.
        const p = waveAudit._paths().AUDIT_FILE;
        const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
        const t = JSON.parse(lines[0]); t.issue = 777; lines[0] = JSON.stringify(t);
        fs.writeFileSync(p, lines.join('\n') + '\n');

        const s = slices.waveIssueAuditSlice({}, {});
        assert.equal(s.chain_broken, true);
        assert.equal(s.chain_broken_at, 0);
    } finally {
        teardown(dir);
    }
});
