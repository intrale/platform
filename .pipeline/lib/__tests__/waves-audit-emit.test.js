// =============================================================================
// waves-audit-emit.test.js — Verifica que las mutaciones de waves.js emitan el
// evento de audit correcto (#4371 CA-1/2/4) y que un fallo del audit NO rompa la
// mutación (CA-12, emisión aditiva y best-effort).
//
// Ejecutar:  node --test .pipeline/lib/__tests__/waves-audit-emit.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let waves;
let waveAudit;

function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-audit-emit-'));
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    delete require.cache[require.resolve('../waves')];
    delete require.cache[require.resolve('../wave-audit')];
    delete require.cache[require.resolve('../audit-log')];
    waves = require('../waves');
    waveAudit = require('../wave-audit');
    waves.invalidateCache();
    return dir;
}

function teardown(dir) {
    if (waves) waves.invalidateCache();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    delete process.env.PIPELINE_DIR_OVERRIDE;
}

function sampleState() {
    return {
        version: '1.0',
        meta: { created_at: '2026-06-01T00:00:00.000Z', updated_at: '2026-06-01T00:00:00.000Z', updated_by: 'System', source: 'manual', note: 'fixture' },
        active_wave: { number: 1, name: 'Ola activa', goal: 'g', started_at: '2026-06-01T10:00:00.000Z', issues: [{ number: 3451 }] },
        planned_waves: [
            { number: 2, name: 'Ola B', goal: 'g', issues: [{ number: 3460 }] },
            { number: 3, name: 'Ola C', issues: [{ number: 3470 }] },
        ],
        archived_waves: [],
        dependencies: [],
    };
}

function writeFixture(dir, state) {
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(state, null, 2));
}

// ─── issue_added ────────────────────────────────────────────────────────────

test('addIssueToWave emite issue_added con estado previo/posterior y actor (CA-1)', () => {
    const dir = setup();
    try {
        writeFixture(dir, sampleState());
        waves.addIssueToWave(2, { number: 5000 }, { updated_by: 'Leo', note: 'mover acá' });
        const ev = waveAudit.readAllEvents();
        assert.equal(ev.length, 1);
        assert.equal(ev[0].event, 'issue_added');
        assert.equal(ev[0].wave, 2);
        assert.equal(ev[0].issue, 5000);
        assert.equal(ev[0].actor, 'Leo');
        assert.deepEqual(ev[0].estado_previo, { issues: [3460] });
        assert.deepEqual(ev[0].estado_posterior, { issues: [3460, 5000] });
    } finally {
        teardown(dir);
    }
});

test('addIssueToWave no-op (issue ya en la ola) NO emite audit', () => {
    const dir = setup();
    try {
        writeFixture(dir, sampleState());
        waves.addIssueToWave(2, { number: 3460 }); // ya está
        assert.equal(waveAudit.readAllEvents().length, 0);
    } finally {
        teardown(dir);
    }
});

// ─── issue_removed ──────────────────────────────────────────────────────────

test('removeIssueFromWave emite issue_removed (CA-2)', () => {
    const dir = setup();
    try {
        writeFixture(dir, sampleState());
        waves.removeIssueFromWave(2, 3460, { updated_by: 'Leo' });
        const ev = waveAudit.readAllEvents();
        assert.equal(ev.length, 1);
        assert.equal(ev[0].event, 'issue_removed');
        assert.equal(ev[0].wave, 2);
        assert.equal(ev[0].issue, 3460);
        assert.deepEqual(ev[0].estado_previo, { issues: [3460] });
        assert.deepEqual(ev[0].estado_posterior, { issues: [] });
    } finally {
        teardown(dir);
    }
});

test('removeIssueFromWave no-op (issue ausente) NO emite audit', () => {
    const dir = setup();
    try {
        writeFixture(dir, sampleState());
        waves.removeIssueFromWave(2, 9999);
        assert.equal(waveAudit.readAllEvents().length, 0);
    } finally {
        teardown(dir);
    }
});

// ─── wave_promoted + wave_archived ──────────────────────────────────────────

test('promoteWaveToActive emite wave_archived (previa) + wave_promoted (CA-4)', () => {
    const dir = setup();
    try {
        writeFixture(dir, sampleState());
        waves.promoteWaveToActive(2, { updated_by: 'Leo', note: 'cierre ola 1' });
        const ev = waveAudit.readAllEvents();
        assert.equal(ev.length, 2);
        assert.equal(ev[0].event, 'wave_archived');
        assert.equal(ev[0].wave, 1);
        assert.equal(ev[0].estado_posterior, 'archived');
        assert.equal(ev[1].event, 'wave_promoted');
        assert.equal(ev[1].wave, 2);
        assert.equal(ev[1].estado_posterior, 'active');
    } finally {
        teardown(dir);
    }
});

test('promoteWaveToActive sin activa previa emite solo wave_promoted', () => {
    const dir = setup();
    try {
        const st = sampleState();
        st.active_wave = null;
        writeFixture(dir, st);
        waves.promoteWaveToActive(2, { updated_by: 'Leo' });
        const ev = waveAudit.readAllEvents();
        assert.equal(ev.length, 1);
        assert.equal(ev[0].event, 'wave_promoted');
    } finally {
        teardown(dir);
    }
});

// ─── CA-12: audit best-effort — un fallo del audit NO rompe la mutación ──────

test('CA-12: si el audit falla, la mutación de la ola igual persiste', () => {
    const dir = setup();
    try {
        writeFixture(dir, sampleState());
        // Forzar fallo del audit: monkeypatch recordWaveEvent para que tire.
        const original = waveAudit.recordWaveEvent;
        waveAudit.recordWaveEvent = () => { throw new Error('audit caído'); };
        try {
            assert.doesNotThrow(() => waves.addIssueToWave(2, { number: 6000 }, { updated_by: 'Leo' }));
        } finally {
            waveAudit.recordWaveEvent = original;
        }
        // La mutación persistió pese al fallo del audit.
        const fresh = JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
        const wave2 = fresh.planned_waves.find((w) => w.number === 2);
        assert.ok(wave2.issues.some((i) => i.number === 6000), 'el issue se agregó igual');
        // Y no se escribió audit (el emisor falló, best-effort tragó el error).
        assert.equal(waveAudit.readAllEvents().length, 0);
    } finally {
        teardown(dir);
    }
});
