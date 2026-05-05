// Tests de .pipeline/lib/rest-mode-window.js (#2890 PR-A)
// Cubre CA-5.1 (isSkillAllowedNow dentro/fuera de ventana, bypass label,
// timezone distinto al server) y validaciones de Sec-A03/A08.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rmw = require('../rest-mode-window');

function tmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// =========================================================================
// validatePayload
// =========================================================================

test('validatePayload acepta un payload completo y normaliza days', () => {
    const r = rmw.validatePayload({
        active: true,
        start: '21:00',
        end: '08:00',
        timezone: 'America/Argentina/Buenos_Aires',
        days: [3, 1, 1, 5, 0],
        manual: true,
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.normalized.days, [0, 1, 3, 5]);
    assert.equal(r.normalized.timezone, 'America/Argentina/Buenos_Aires');
});

test('validatePayload rechaza HH:MM mal formado', () => {
    const r = rmw.validatePayload({ active: true, start: '24:00', end: '08:00' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.find(e => /start/.test(e)));
});

test('validatePayload rechaza minutos fuera de rango', () => {
    const r = rmw.validatePayload({ active: true, start: '12:60', end: '08:00' });
    assert.equal(r.ok, false);
});

test('validatePayload rechaza timezone fuera del whitelist (CA-Sec-A03)', () => {
    const r = rmw.validatePayload({
        active: true,
        start: '00:00',
        end: '06:00',
        timezone: 'Foo/Bar_Invalid',
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.find(e => /timezone/.test(e)));
});

test('validatePayload rechaza days fuera de [0..6]', () => {
    const r = rmw.validatePayload({
        active: true,
        start: '00:00',
        end: '06:00',
        days: [7, 8, -1],
    });
    assert.equal(r.ok, false);
});

test('validatePayload rechaza days vacíos', () => {
    const r = rmw.validatePayload({
        active: true,
        start: '00:00',
        end: '06:00',
        days: [],
    });
    assert.equal(r.ok, false);
});

test('validatePayload completa days default cuando no viene', () => {
    const r = rmw.validatePayload({
        active: true,
        start: '00:00',
        end: '06:00',
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.normalized.days, [0, 1, 2, 3, 4, 5, 6]);
});

// =========================================================================
// timezoneIsSupported
// =========================================================================

test('timezoneIsSupported reconoce zonas estándar', () => {
    assert.equal(rmw.timezoneIsSupported('UTC'), true);
    assert.equal(rmw.timezoneIsSupported('America/Argentina/Buenos_Aires'), true);
    assert.equal(rmw.timezoneIsSupported('Foo/Bar'), false);
    assert.equal(rmw.timezoneIsSupported(''), false);
    assert.equal(rmw.timezoneIsSupported(null), false);
});

// =========================================================================
// isWithinWindow
// =========================================================================

test('isWithinWindow false cuando active=false', () => {
    const win = { active: false, start: '00:00', end: '23:59', timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6] };
    assert.equal(rmw.isWithinWindow(win, Date.now()), false);
});

test('isWithinWindow ventana intra-día (UTC)', () => {
    const win = { active: true, start: '13:00', end: '17:00', timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6] };
    // 2026-01-05 = Monday (day 1)
    const inside = Date.UTC(2026, 0, 5, 14, 30, 0);
    const outside = Date.UTC(2026, 0, 5, 18, 0, 0);
    assert.equal(rmw.isWithinWindow(win, inside), true);
    assert.equal(rmw.isWithinWindow(win, outside), false);
});

test('isWithinWindow ventana cross-midnight (22:00 → 08:00)', () => {
    const win = { active: true, start: '22:00', end: '08:00', timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6] };
    // 2026-01-05 23:00 UTC (lunes a las 23h) → dentro
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 5, 23, 0, 0)), true);
    // 2026-01-06 03:00 UTC (martes 03:00) → todavía dentro
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 6, 3, 0, 0)), true);
    // 2026-01-06 09:00 UTC (martes 09:00) → fuera
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 6, 9, 0, 0)), false);
});

test('isWithinWindow respeta días de la semana', () => {
    // Lun-vie únicamente
    const win = { active: true, start: '13:00', end: '17:00', timezone: 'UTC', days: [1, 2, 3, 4, 5] };
    // 2026-01-03 es sábado (day 6) — fuera
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 3, 14, 0, 0)), false);
    // 2026-01-05 es lunes (day 1) — dentro
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 5, 14, 0, 0)), true);
});

test('isWithinWindow ventana 24h cuando start === end', () => {
    const win = { active: true, start: '00:00', end: '00:00', timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6] };
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 5, 14, 0, 0)), true);
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 5, 0, 0, 0)), true);
});

test('isWithinWindow timezone distinto al server (Buenos Aires UTC-3)', () => {
    // Ventana 22:00-08:00 ART. Server simula UTC.
    // 2026-01-06 01:00 UTC = 2026-01-05 22:00 ART (martes 01:00 UTC = lunes 22:00 ART) → dentro
    const win = { active: true, start: '22:00', end: '08:00', timezone: 'America/Argentina/Buenos_Aires', days: [0, 1, 2, 3, 4, 5, 6] };
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 6, 1, 30, 0)), true);
    // 2026-01-06 12:00 UTC = 2026-01-06 09:00 ART → fuera
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 6, 12, 0, 0)), false);
});

// =========================================================================
// isSkillAllowedNow
// =========================================================================

test('isSkillAllowedNow permite todo fuera de la ventana', () => {
    const window = { active: true, start: '13:00', end: '17:00', timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6] };
    const r = rmw.isSkillAllowedNow('android-dev', Date.UTC(2026, 0, 5, 9, 0, 0), { window });
    assert.equal(r.allowed, true);
    assert.equal(r.reason, 'outside_window');
    assert.equal(r.withinWindow, false);
});

test('isSkillAllowedNow bloquea skill no determinístico dentro de la ventana', () => {
    const window = { active: true, start: '13:00', end: '17:00', timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6] };
    const r = rmw.isSkillAllowedNow('android-dev', Date.UTC(2026, 0, 5, 14, 0, 0), { window });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'within_window_non_deterministic');
});

test('isSkillAllowedNow permite skill determinístico dentro de la ventana', () => {
    const window = { active: true, start: '13:00', end: '17:00', timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6] };
    for (const skill of ['delivery', 'builder', 'linter', 'tester']) {
        const r = rmw.isSkillAllowedNow(skill, Date.UTC(2026, 0, 5, 14, 0, 0), { window });
        assert.equal(r.allowed, true, `${skill} debería pasar`);
        assert.equal(r.reason, 'deterministic_skill');
        assert.equal(r.deterministic, true);
    }
});

test('isSkillAllowedNow bypass label vence el gate (CA-1.7)', () => {
    const window = { active: true, start: '13:00', end: '17:00', timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6] };
    const r = rmw.isSkillAllowedNow('android-dev', Date.UTC(2026, 0, 5, 14, 0, 0), {
        window,
        cfg: { bypass_labels: ['priority:critical'] },
        bypassLabels: ['priority:critical', 'enhancement'],
    });
    assert.equal(r.allowed, true);
    assert.equal(r.reason, 'bypass_label');
    assert.equal(r.matchedBypassLabel, 'priority:critical');
});

test('isSkillAllowedNow bypass labels custom desde cfg', () => {
    const window = { active: true, start: '13:00', end: '17:00', timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6] };
    const r = rmw.isSkillAllowedNow('android-dev', Date.UTC(2026, 0, 5, 14, 0, 0), {
        window,
        cfg: { bypass_labels: ['urgent', 'hotfix'] },
        bypassLabels: ['urgent'],
    });
    assert.equal(r.allowed, true);
    assert.equal(r.matchedBypassLabel, 'urgent');
});

test('isSkillAllowedNow timezone distinto al server (lunes 23h ART = martes 02h UTC)', () => {
    // CA-5.1 — ventana 22:00-08:00 ART, server simula UTC.
    const window = { active: true, start: '22:00', end: '08:00', timezone: 'America/Argentina/Buenos_Aires', days: [0, 1, 2, 3, 4, 5, 6] };
    // 2026-01-06 02:00 UTC = 2026-01-05 23:00 ART (lunes 23h) → dentro
    const r = rmw.isSkillAllowedNow('android-dev', Date.UTC(2026, 0, 6, 2, 0, 0), { window });
    assert.equal(r.allowed, false);
    assert.equal(r.withinWindow, true);
});

// =========================================================================
// setWindow + getWindow + audit (CA-Sec-A08)
// =========================================================================

test('setWindow persiste atómicamente y getWindow lo lee de vuelta (CA-1.1, CA-1.2)', () => {
    const dir = tmpDir('rmw-set-');
    const r = rmw.setWindow({
        active: true,
        start: '21:00',
        end: '08:00',
        timezone: 'America/Argentina/Buenos_Aires',
        days: [1, 2, 3, 4, 5],
    }, { pipelineDir: dir, actor: 'test' });
    assert.equal(r.ok, true);
    const w = rmw.getWindow({ pipelineDir: dir });
    assert.equal(w.active, true);
    assert.equal(w.start, '21:00');
    assert.equal(w.end, '08:00');
    assert.equal(w.timezone, 'America/Argentina/Buenos_Aires');
    assert.deepEqual(w.days, [1, 2, 3, 4, 5]);
    assert.ok(w.updatedAt);
});

test('setWindow preserva campos `alert` de PR-C que ya existían en el archivo', () => {
    const dir = tmpDir('rmw-coexist-');
    // Simulamos que PR-C escribió primero su `alert`.
    fs.writeFileSync(path.join(dir, 'rest-mode.json'), JSON.stringify({
        alert: { active: false, raised_at: null, hour: null, actual_usd: 0 },
    }, null, 2));

    const r = rmw.setWindow({
        active: true,
        start: '00:00',
        end: '06:00',
        timezone: 'UTC',
        days: [0, 1, 2, 3, 4, 5, 6],
    }, { pipelineDir: dir, actor: 'test' });
    assert.equal(r.ok, true);

    const raw = readJson(path.join(dir, 'rest-mode.json'));
    assert.equal(raw.active, true);
    assert.equal(raw.start, '00:00');
    assert.ok(raw.alert, 'campo alert de PR-C debe persistir');
    assert.equal(raw.alert.active, false);
});

test('setWindow rechaza payload inválido y NO escribe el archivo', () => {
    const dir = tmpDir('rmw-invalid-');
    const r = rmw.setWindow({ active: true, start: 'malo', end: '08:00' }, {
        pipelineDir: dir, actor: 'test',
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0);
    // No se debe haber creado el archivo de estado.
    assert.equal(fs.existsSync(path.join(dir, 'rest-mode.json')), false);
});

test('setWindow appendea entrada al audit trail (CA-Sec-A08)', () => {
    const dir = tmpDir('rmw-audit-');
    rmw.setWindow({
        active: true, start: '21:00', end: '08:00',
        timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6],
    }, { pipelineDir: dir, actor: 'manual' });
    rmw.setWindow({
        active: false, start: '21:00', end: '08:00',
        timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6],
    }, { pipelineDir: dir, actor: 'api' });

    const auditPath = path.join(dir, 'rest-mode-audit.jsonl');
    assert.equal(fs.existsSync(auditPath), true);
    const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const e1 = JSON.parse(lines[0]);
    const e2 = JSON.parse(lines[1]);
    assert.equal(e1.actor, 'manual');
    assert.equal(e2.actor, 'api');
    assert.equal(e1.next.active, true);
    assert.equal(e2.prev.active, true);
    assert.equal(e2.next.active, false);
    assert.ok(e1.ts);
});

test('getWindow retorna defaults cuando el archivo no existe', () => {
    const dir = tmpDir('rmw-noent-');
    const w = rmw.getWindow({ pipelineDir: dir });
    assert.equal(w.active, false);
    assert.equal(w.start, null);
    assert.equal(w.end, null);
    assert.equal(w.timezone, 'America/Argentina/Buenos_Aires');
    assert.deepEqual(w.days, [0, 1, 2, 3, 4, 5, 6]);
});

test('getWindow tolera JSON corrupto sin tirar', () => {
    const dir = tmpDir('rmw-corrupt-');
    fs.writeFileSync(path.join(dir, 'rest-mode.json'), '{esto-no-es-json}');
    const w = rmw.getWindow({ pipelineDir: dir });
    assert.equal(w.active, false);
});

// =========================================================================
// Coherencia con DETERMINISTIC_SKILLS de pulpo.js
// =========================================================================

test('DETERMINISTIC_SKILLS coincide con el set documentado', () => {
    // Si pulpo.js cambia su set, este test obliga a actualizar el módulo.
    assert.deepEqual(
        [...rmw.DETERMINISTIC_SKILLS].sort(),
        ['builder', 'delivery', 'linter', 'tester'].sort()
    );
});

// =========================================================================
// getFullState — coexistencia PR-A + PR-C
// =========================================================================

test('getFullState devuelve window y alert juntos', () => {
    const dir = tmpDir('rmw-full-');
    fs.writeFileSync(path.join(dir, 'rest-mode.json'), JSON.stringify({
        active: true, start: '00:00', end: '06:00', timezone: 'UTC',
        days: [0, 1, 2, 3, 4, 5, 6], updatedAt: '2026-01-01T00:00:00Z',
        alert: { active: true, raised_at: '2026-01-01T01:00:00Z' },
    }));
    const full = rmw.getFullState({ pipelineDir: dir });
    assert.equal(full.window.active, true);
    assert.equal(full.alert.active, true);
});
