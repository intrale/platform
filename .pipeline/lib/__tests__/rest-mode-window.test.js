// Tests de .pipeline/lib/rest-mode-window.js (#2890 PR-A + #3241 schedule semanal)
// Cubre:
//   - CA-5.1 (isSkillAllowedNow dentro/fuera de ventana, bypass label,
//     timezone distinto al server) y validaciones de Sec-A03/A08.
//   - #3241 CA-1..CA-7: schema schedule semanal, compat hacia atrás,
//     isWithinWindow multi-periodo, cross-midnight, día vacío, validador
//     estricto (overlaps cross-midnight, start===end, claves inválidas,
//     cap de periodos), audit con schedule completo, slice enriquecido.
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
// validatePayload — entrada legacy (CA-2, compat hacia atrás)
// =========================================================================

test('validatePayload acepta un payload legacy completo y lo migra a schedule', () => {
    const r = rmw.validatePayload({
        active: true,
        start: '21:00',
        end: '08:00',
        timezone: 'America/Argentina/Buenos_Aires',
        days: [3, 1, 1, 5, 0], // sunday=0, monday=1, wednesday=3, friday=5
        manual: true,
    });
    assert.equal(r.ok, true);
    assert.equal(r.normalized.timezone, 'America/Argentina/Buenos_Aires');
    assert.equal(r.normalized.active, true);
    assert.equal(r.normalized.manual, true);
    // Schedule sintetizado desde legacy
    assert.deepEqual(r.normalized.schedule.sunday, [{ start: '21:00', end: '08:00' }]);
    assert.deepEqual(r.normalized.schedule.monday, [{ start: '21:00', end: '08:00' }]);
    assert.deepEqual(r.normalized.schedule.wednesday, [{ start: '21:00', end: '08:00' }]);
    assert.deepEqual(r.normalized.schedule.friday, [{ start: '21:00', end: '08:00' }]);
    assert.deepEqual(r.normalized.schedule.tuesday, []);
    assert.deepEqual(r.normalized.schedule.thursday, []);
    assert.deepEqual(r.normalized.schedule.saturday, []);
});

test('validatePayload rechaza HH:MM mal formado en legacy', () => {
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

test('validatePayload legacy completa días default cuando no viene', () => {
    const r = rmw.validatePayload({
        active: true,
        start: '00:00',
        end: '06:00',
    });
    assert.equal(r.ok, true);
    // Todos los días deben tener el mismo periodo
    for (const day of rmw.VALID_DAYS) {
        assert.deepEqual(r.normalized.schedule[day], [{ start: '00:00', end: '06:00' }]);
    }
});

test('validatePayload legacy start === end migra a {00:00→23:59} (día completo)', () => {
    const r = rmw.validatePayload({
        active: true,
        start: '00:00',
        end: '00:00',
        days: [1],
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.normalized.schedule.monday, [{ start: '00:00', end: '23:59' }]);
});

// =========================================================================
// validatePayload — entrada schedule (modelo nuevo #3241)
// =========================================================================

test('validatePayload acepta schedule semanal con varios periodos por día (CA-1)', () => {
    const r = rmw.validatePayload({
        active: true,
        timezone: 'UTC',
        schedule: {
            monday: [
                { start: '13:00', end: '14:00' },
                { start: '22:00', end: '23:00' },
            ],
            sunday: [{ start: '00:00', end: '23:59' }],
        },
    });
    assert.equal(r.ok, true);
    assert.equal(r.normalized.schedule.monday.length, 2);
    assert.equal(r.normalized.schedule.sunday.length, 1);
    assert.equal(r.normalized.schedule.tuesday.length, 0); // default `[]`
});

test('validatePayload rechaza 2 periodos solapados en el mismo día (CA-6)', () => {
    const r = rmw.validatePayload({
        active: true,
        schedule: {
            monday: [
                { start: '13:00', end: '15:00' },
                { start: '14:30', end: '16:00' },
            ],
        },
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.find(e => /solapados/.test(e)), `expected overlap error, got ${JSON.stringify(r.errors)}`);
});

test('validatePayload detecta overlap cross-midnight {22:00→07:00} vs {06:00→08:00} (SEC-3)', () => {
    // Detector ingenuo (start+dur) los marca OK. El algoritmo con split
    // wrap-around debe detectar overlap en [06:00-07:00].
    const r = rmw.validatePayload({
        active: true,
        schedule: {
            monday: [
                { start: '22:00', end: '07:00' },
                { start: '06:00', end: '08:00' },
            ],
        },
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.find(e => /solapados/.test(e)), `expected overlap error, got ${JSON.stringify(r.errors)}`);
});

test('validatePayload rechaza start === end salvo {00:00, 23:59} (CA-6)', () => {
    const bad = rmw.validatePayload({
        active: true,
        schedule: { monday: [{ start: '13:00', end: '13:00' }] },
    });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.find(e => /start === end/.test(e)));

    const good = rmw.validatePayload({
        active: true,
        schedule: { sunday: [{ start: '00:00', end: '23:59' }] },
    });
    assert.equal(good.ok, true);
});

test('validatePayload rechaza claves de día inválidas (anti prototype pollution PO-SEC-1)', () => {
    // JSON.parse de {"__proto__": ...} crea una own property (no setea prototipo).
    const payload = JSON.parse('{"active":true,"schedule":{"__proto__":[{"start":"00:00","end":"06:00"}]}}');
    const r = rmw.validatePayload(payload);
    assert.equal(r.ok, false);
    assert.ok(r.errors.find(e => /clave inválida/.test(e)),
        `expected invalid-key error, got ${JSON.stringify(r.errors)}`);
});

test('validatePayload rechaza key "constructor" (SEC-1)', () => {
    const payload = JSON.parse('{"active":true,"schedule":{"constructor":[{"start":"00:00","end":"06:00"}]}}');
    const r = rmw.validatePayload(payload);
    assert.equal(r.ok, false);
    assert.ok(r.errors.find(e => /clave inválida/.test(e)));
});

test('validatePayload rechaza > MAX_PERIODS_PER_DAY periodos en un día (SEC-2)', () => {
    assert.equal(rmw.MAX_PERIODS_PER_DAY, 24);
    // 25 periodos de 1 minuto cada uno
    const periods = [];
    for (let i = 0; i < 25; i++) {
        const start = String(Math.floor(i / 2)).padStart(2, '0') + ':' + (i % 2 ? '30' : '00');
        const end = String(Math.floor(i / 2)).padStart(2, '0') + ':' + (i % 2 ? '45' : '15');
        periods.push({ start, end });
    }
    const r = rmw.validatePayload({
        active: true,
        schedule: { monday: periods },
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.find(e => /máximo permitido/.test(e)));
});

test('validatePayload rechaza periodos con campos extras (anti payload smuggling)', () => {
    const r = rmw.validatePayload({
        active: true,
        schedule: {
            monday: [{ start: '13:00', end: '14:00', evil: 'inject' }],
        },
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.find(e => /campo desconocido/.test(e)));
});

test('validatePayload acepta día vacío (CA-5)', () => {
    const r = rmw.validatePayload({
        active: true,
        schedule: {
            monday: [{ start: '13:00', end: '17:00' }],
            saturday: [],
            sunday: [],
        },
    });
    assert.equal(r.ok, true);
    assert.equal(r.normalized.schedule.saturday.length, 0);
});

test('validatePayload rechaza schedule.day que no es array', () => {
    const r = rmw.validatePayload({
        active: true,
        schedule: { monday: 'no-array' },
    });
    assert.equal(r.ok, false);
});

test('validatePayload mixto schedule+legacy aplica schedule con warning (CA-8.6, PO-SEC-5)', () => {
    const r = rmw.validatePayload({
        active: true,
        start: '21:00',
        end: '08:00',
        days: [1, 2, 3],
        schedule: {
            monday: [{ start: '13:00', end: '14:00' }],
        },
    });
    assert.equal(r.ok, true);
    assert.ok(r.warnings && r.warnings.length > 0);
    assert.ok(r.warnings.find(w => /schedule toma precedencia/.test(w)));
    // El schedule explícito gana — monday tiene 13:00→14:00, NO 21:00→08:00.
    assert.deepEqual(r.normalized.schedule.monday, [{ start: '13:00', end: '14:00' }]);
    // Días legacy ignorados — tuesday queda vacío
    assert.deepEqual(r.normalized.schedule.tuesday, []);
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
// isWithinWindow — schedule model
// =========================================================================

function makeScheduleWindow(schedule, opts) {
    return Object.assign({
        active: true,
        timezone: 'UTC',
        manual: false,
        schedule,
    }, opts || {});
}

test('isWithinWindow false cuando active=false', () => {
    const win = makeScheduleWindow({
        monday: [{ start: '00:00', end: '23:59' }],
    }, { active: false });
    assert.equal(rmw.isWithinWindow(win, Date.now()), false);
});

test('isWithinWindow evalúa todos los periodos del día actual (CA-3)', () => {
    const win = makeScheduleWindow({
        monday: [
            { start: '08:00', end: '10:00' },
            { start: '13:00', end: '15:00' },
            { start: '20:00', end: '22:00' },
        ],
    });
    // 2026-01-05 = Monday UTC
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 5, 9, 0, 0)), true);    // dentro 1er periodo
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 5, 11, 0, 0)), false);  // entre periodos
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 5, 14, 0, 0)), true);   // dentro 2do periodo
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 5, 16, 0, 0)), false);  // entre periodos
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 5, 21, 0, 0)), true);   // dentro 3er periodo
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 5, 23, 0, 0)), false);  // fuera
});

test('isWithinWindow cross-midnight respeta día de origen (CA-4)', () => {
    const win = makeScheduleWindow({
        monday: [{ start: '22:00', end: '07:00' }],
    });
    // Lunes 23:00 → dentro (residual de lunes)
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 5, 23, 0, 0)), true);
    // Martes 02:00 → dentro (residual cross-midnight del lunes)
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 6, 2, 0, 0)), true);
    // Martes 06:59 → todavía dentro
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 6, 6, 59, 0)), true);
    // Martes 07:00 → fuera (end exclusivo)
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 6, 7, 0, 0)), false);
    // Martes 22:00 → fuera (martes no tiene periodos)
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 6, 22, 0, 0)), false);
});

test('isWithinWindow día vacío significa skill NO bloqueado ese día (CA-5)', () => {
    const win = makeScheduleWindow({
        monday: [{ start: '00:00', end: '23:59' }],
        saturday: [],
    });
    // 2026-01-03 = sábado UTC
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 3, 14, 0, 0)), false);
    // 2026-01-05 = lunes UTC
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 5, 14, 0, 0)), true);
});

test('isWithinWindow timezone distinto al server (Buenos Aires UTC-3)', () => {
    const win = makeScheduleWindow({
        monday: [{ start: '22:00', end: '08:00' }],
    }, { timezone: 'America/Argentina/Buenos_Aires' });
    // 2026-01-06 01:30 UTC = 2026-01-05 22:30 ART → lunes 22:30 ART → dentro
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 6, 1, 30, 0)), true);
    // 2026-01-06 12:00 UTC = 2026-01-06 09:00 ART → martes 09:00 ART → fuera
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 6, 12, 0, 0)), false);
});

// Compat: si window viene en shape legacy (sin schedule) sigue funcionando.
test('isWithinWindow LEGACY shape sigue funcionando (intra-día)', () => {
    const win = { active: true, start: '13:00', end: '17:00', timezone: 'UTC', days: [1] };
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 5, 14, 0, 0)), true);
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 5, 18, 0, 0)), false);
});

test('isWithinWindow LEGACY shape cross-midnight', () => {
    const win = { active: true, start: '22:00', end: '08:00', timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6] };
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 5, 23, 0, 0)), true);
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 6, 3, 0, 0)), true);
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 6, 9, 0, 0)), false);
});

test('isWithinWindow LEGACY shape ventana 24h cuando start === end', () => {
    const win = { active: true, start: '00:00', end: '00:00', timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6] };
    assert.equal(rmw.isWithinWindow(win, Date.UTC(2026, 0, 5, 14, 0, 0)), true);
});

// =========================================================================
// isSkillAllowedNow (PO-API-1 estable)
// =========================================================================

test('isSkillAllowedNow permite todo fuera de la ventana', () => {
    const window = makeScheduleWindow({
        monday: [{ start: '13:00', end: '17:00' }],
    });
    const r = rmw.isSkillAllowedNow('android-dev', Date.UTC(2026, 0, 5, 9, 0, 0), { window });
    assert.equal(r.allowed, true);
    assert.equal(r.reason, 'outside_window');
    assert.equal(r.withinWindow, false);
});

test('isSkillAllowedNow bloquea skill no determinístico dentro de la ventana', () => {
    const window = makeScheduleWindow({
        monday: [{ start: '13:00', end: '17:00' }],
    });
    const r = rmw.isSkillAllowedNow('android-dev', Date.UTC(2026, 0, 5, 14, 0, 0), { window });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'within_window_non_deterministic');
});

test('isSkillAllowedNow permite skill determinístico dentro de la ventana', () => {
    const window = makeScheduleWindow({
        monday: [{ start: '13:00', end: '17:00' }],
    });
    for (const skill of ['delivery', 'build', 'linter', 'tester']) {
        const r = rmw.isSkillAllowedNow(skill, Date.UTC(2026, 0, 5, 14, 0, 0), { window });
        assert.equal(r.allowed, true, `${skill} debería pasar`);
        assert.equal(r.reason, 'deterministic_skill');
        assert.equal(r.deterministic, true);
    }
});

test('isSkillAllowedNow bypass label vence el gate', () => {
    const window = makeScheduleWindow({
        monday: [{ start: '13:00', end: '17:00' }],
    });
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
    const window = makeScheduleWindow({
        monday: [{ start: '13:00', end: '17:00' }],
    });
    const r = rmw.isSkillAllowedNow('android-dev', Date.UTC(2026, 0, 5, 14, 0, 0), {
        window,
        cfg: { bypass_labels: ['urgent', 'hotfix'] },
        bypassLabels: ['urgent'],
    });
    assert.equal(r.allowed, true);
    assert.equal(r.matchedBypassLabel, 'urgent');
});

// =========================================================================
// setWindow + getWindow + audit (CA-7)
// =========================================================================

test('setWindow persiste schedule y getWindow lo lee de vuelta (CA-1)', () => {
    const dir = tmpDir('rmw-set-sched-');
    const r = rmw.setWindow({
        active: true,
        timezone: 'America/Argentina/Buenos_Aires',
        schedule: {
            monday: [{ start: '22:00', end: '07:00' }, { start: '13:00', end: '14:00' }],
            saturday: [],
            sunday: [{ start: '00:00', end: '23:59' }],
        },
    }, { pipelineDir: dir, actor: 'test' });
    assert.equal(r.ok, true);

    const w = rmw.getWindow({ pipelineDir: dir });
    assert.equal(w.active, true);
    assert.equal(w.timezone, 'America/Argentina/Buenos_Aires');
    assert.equal(w.schedule.monday.length, 2);
    assert.deepEqual(w.schedule.monday[0], { start: '22:00', end: '07:00' });
    assert.deepEqual(w.schedule.monday[1], { start: '13:00', end: '14:00' });
    assert.deepEqual(w.schedule.saturday, []);
    assert.deepEqual(w.schedule.sunday, [{ start: '00:00', end: '23:59' }]);
    assert.ok(w.updatedAt);
});

test('setWindow legacy payload migra a schedule en disco (CA-2)', () => {
    const dir = tmpDir('rmw-migr-');
    const r = rmw.setWindow({
        active: true,
        start: '21:00',
        end: '08:00',
        timezone: 'UTC',
        days: [1, 2, 3, 4, 5],
    }, { pipelineDir: dir, actor: 'test' });
    assert.equal(r.ok, true);

    // El archivo en disco YA debería estar en formato schedule, no legacy.
    const raw = readJson(path.join(dir, 'rest-mode.json'));
    assert.ok(raw.schedule, 'archivo debe tener `schedule`');
    assert.equal(raw.start, undefined, '`start` legacy NO debe persistir');
    assert.equal(raw.end, undefined, '`end` legacy NO debe persistir');
    assert.equal(raw.days, undefined, '`days` legacy NO debe persistir');
    // Schedule contiene los días configurados con el periodo
    for (const dayName of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']) {
        assert.deepEqual(raw.schedule[dayName], [{ start: '21:00', end: '08:00' }]);
    }
    assert.deepEqual(raw.schedule.saturday, []);
    assert.deepEqual(raw.schedule.sunday, []);
});

test('setWindow preserva campos `alert` de PR-C que ya existían en el archivo', () => {
    const dir = tmpDir('rmw-coexist-');
    fs.writeFileSync(path.join(dir, 'rest-mode.json'), JSON.stringify({
        alert: { active: false, raised_at: null, hour: null, actual_usd: 0 },
    }, null, 2));

    const r = rmw.setWindow({
        active: true,
        schedule: { monday: [{ start: '00:00', end: '06:00' }] },
        timezone: 'UTC',
    }, { pipelineDir: dir, actor: 'test' });
    assert.equal(r.ok, true);

    const raw = readJson(path.join(dir, 'rest-mode.json'));
    assert.equal(raw.active, true);
    assert.deepEqual(raw.schedule.monday, [{ start: '00:00', end: '06:00' }]);
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
    assert.equal(fs.existsSync(path.join(dir, 'rest-mode.json')), false);
});

test('setWindow audit trail contiene schedule completo en prev/next (CA-7)', () => {
    const dir = tmpDir('rmw-audit-');
    rmw.setWindow({
        active: true,
        schedule: { monday: [{ start: '21:00', end: '08:00' }] },
        timezone: 'UTC',
    }, { pipelineDir: dir, actor: 'manual' });
    rmw.setWindow({
        active: false,
        schedule: {
            monday: [{ start: '21:00', end: '08:00' }],
            tuesday: [{ start: '13:00', end: '14:00' }],
        },
        timezone: 'UTC',
    }, { pipelineDir: dir, actor: 'api' });

    const auditPath = path.join(dir, 'rest-mode-audit.jsonl');
    assert.equal(fs.existsSync(auditPath), true);
    const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const e1 = JSON.parse(lines[0]);
    const e2 = JSON.parse(lines[1]);
    assert.equal(e1.actor, 'manual');
    assert.equal(e2.actor, 'api');

    // CA-7: schedule completo en prev y next
    assert.ok(e1.next.schedule, 'next.schedule debe existir');
    assert.deepEqual(e1.next.schedule.monday, [{ start: '21:00', end: '08:00' }]);
    assert.deepEqual(e1.prev.schedule.monday, []); // arrancaba vacío

    assert.ok(e2.next.schedule);
    assert.deepEqual(e2.next.schedule.tuesday, [{ start: '13:00', end: '14:00' }]);
    assert.deepEqual(e2.prev.schedule.monday, [{ start: '21:00', end: '08:00' }]);
    assert.equal(e2.next.active, false);
    assert.equal(e2.prev.active, true);
    assert.ok(e1.ts);
});

test('setWindow devuelve warnings cuando payload trae schedule+legacy mixto', () => {
    const dir = tmpDir('rmw-warn-');
    const r = rmw.setWindow({
        active: true,
        start: '21:00', end: '08:00', days: [1, 2],
        schedule: { monday: [{ start: '13:00', end: '14:00' }] },
        timezone: 'UTC',
    }, { pipelineDir: dir, actor: 'test' });
    assert.equal(r.ok, true);
    assert.ok(r.warnings && r.warnings.length > 0);
    assert.ok(r.warnings.find(w => /schedule toma precedencia/.test(w)));
});

test('getWindow retorna defaults cuando el archivo no existe', () => {
    const dir = tmpDir('rmw-noent-');
    const w = rmw.getWindow({ pipelineDir: dir });
    assert.equal(w.active, false);
    assert.equal(w.start, null);
    assert.equal(w.end, null);
    assert.equal(w.timezone, 'America/Argentina/Buenos_Aires');
    assert.deepEqual(w.days, [0, 1, 2, 3, 4, 5, 6]);
    // Schedule está vacío por día
    for (const d of rmw.VALID_DAYS) {
        assert.deepEqual(w.schedule[d], []);
    }
});

test('getWindow tolera JSON corrupto sin tirar', () => {
    const dir = tmpDir('rmw-corrupt-');
    fs.writeFileSync(path.join(dir, 'rest-mode.json'), '{esto-no-es-json}');
    const w = rmw.getWindow({ pipelineDir: dir });
    assert.equal(w.active, false);
});

test('getWindow lee archivo legacy y sintetiza schedule en memoria (CA-2)', () => {
    const dir = tmpDir('rmw-readlegacy-');
    // Escribimos directo en formato legacy (simulando archivo viejo en disco)
    fs.writeFileSync(path.join(dir, 'rest-mode.json'), JSON.stringify({
        active: true,
        start: '22:00',
        end: '08:00',
        timezone: 'UTC',
        days: [1, 2, 3, 4, 5],
        manual: false,
        updatedAt: '2026-05-15T00:00:00Z',
    }));

    const w = rmw.getWindow({ pipelineDir: dir });
    assert.equal(w.active, true);
    assert.equal(w.start, '22:00');  // legacy fields preserved for compat
    assert.equal(w.end, '08:00');
    // Schedule sintetizado
    assert.deepEqual(w.schedule.monday, [{ start: '22:00', end: '08:00' }]);
    assert.deepEqual(w.schedule.friday, [{ start: '22:00', end: '08:00' }]);
    assert.deepEqual(w.schedule.saturday, []);
    assert.deepEqual(w.schedule.sunday, []);
});

test('getWindow sintetiza legacy fields desde schedule para retrocompat del pill', () => {
    const dir = tmpDir('rmw-pill-');
    rmw.setWindow({
        active: true,
        schedule: {
            tuesday: [{ start: '15:00', end: '17:00' }],
            friday: [{ start: '22:00', end: '23:00' }],
        },
        timezone: 'UTC',
    }, { pipelineDir: dir, actor: 'test' });

    const w = rmw.getWindow({ pipelineDir: dir });
    // Synthesize: primer día con periodos en orden VALID_DAYS (mon..sun) → tuesday
    assert.equal(w.start, '15:00');
    assert.equal(w.end, '17:00');
    // Días con periodos
    assert.deepEqual(w.days.sort(), [2, 5].sort()); // tuesday=2, friday=5
});

// =========================================================================
// Coherencia con DETERMINISTIC_SKILLS de pulpo.js
// =========================================================================

test('DETERMINISTIC_SKILLS coincide con el set documentado', () => {
    assert.deepEqual(
        [...rmw.DETERMINISTIC_SKILLS].sort(),
        ['build', 'delivery', 'linter', 'tester'].sort()
    );
});

// =========================================================================
// getFullState — coexistencia PR-A + PR-C
// =========================================================================

test('getFullState devuelve window y alert juntos (modelo schedule)', () => {
    const dir = tmpDir('rmw-full-');
    rmw.setWindow({
        active: true,
        schedule: { monday: [{ start: '00:00', end: '06:00' }] },
        timezone: 'UTC',
    }, { pipelineDir: dir, actor: 'test' });
    // Simulamos PR-C escribiendo su alert.
    const file = path.join(dir, 'rest-mode.json');
    const raw = readJson(file);
    raw.alert = { active: true, raised_at: '2026-01-01T01:00:00Z' };
    fs.writeFileSync(file, JSON.stringify(raw));

    const full = rmw.getFullState({ pipelineDir: dir });
    assert.equal(full.window.active, true);
    assert.deepEqual(full.window.schedule.monday, [{ start: '00:00', end: '06:00' }]);
    assert.equal(full.alert.active, true);
});

// =========================================================================
// describeRestModeNow (CA-Slice)
// =========================================================================

test('describeRestModeNow devuelve shape enriquecido cuando hay periodo activo', () => {
    const win = makeScheduleWindow({
        monday: [
            { start: '13:00', end: '15:00' },
            { start: '20:00', end: '22:00' },
        ],
    });
    // 2026-01-05 14:00 UTC = lunes mediodía → dentro 1er periodo
    const r = rmw.describeRestModeNow(win, Date.UTC(2026, 0, 5, 14, 0, 0));
    assert.equal(r.active, true);
    assert.equal(r.isWithinNow, true);
    assert.deepEqual(r.currentPeriod, { start: '13:00', end: '15:00' });
    // nextPeriod: el de las 20:00 hoy
    assert.deepEqual(r.nextPeriod, { start: '20:00', end: '22:00', when: 'today' });
    assert.equal(r.periodsToday, 2);
});

test('describeRestModeNow nextPeriod cae en otro día cuando hoy no hay más', () => {
    const win = makeScheduleWindow({
        monday: [{ start: '08:00', end: '10:00' }],
        wednesday: [{ start: '15:00', end: '17:00' }],
    });
    // 2026-01-05 11:00 UTC = lunes 11:00 → fuera, próximo periodo es miércoles
    const r = rmw.describeRestModeNow(win, Date.UTC(2026, 0, 5, 11, 0, 0));
    assert.equal(r.isWithinNow, false);
    assert.equal(r.currentPeriod, null);
    assert.equal(r.nextPeriod.start, '15:00');
    assert.equal(r.nextPeriod.when, 'wednesday');
});

test('describeRestModeNow nextPeriod when="tomorrow" para día siguiente', () => {
    const win = makeScheduleWindow({
        monday: [{ start: '08:00', end: '10:00' }],
        tuesday: [{ start: '09:00', end: '11:00' }],
    });
    const r = rmw.describeRestModeNow(win, Date.UTC(2026, 0, 5, 11, 0, 0));
    assert.equal(r.nextPeriod.when, 'tomorrow');
    assert.equal(r.nextPeriod.start, '09:00');
});

test('describeRestModeNow currentPeriod detecta residual cross-midnight de ayer', () => {
    const win = makeScheduleWindow({
        monday: [{ start: '22:00', end: '07:00' }],
    });
    // 2026-01-06 02:00 UTC = martes 02:00 → residual cross-midnight del lunes
    const r = rmw.describeRestModeNow(win, Date.UTC(2026, 0, 6, 2, 0, 0));
    assert.equal(r.isWithinNow, true);
    assert.deepEqual(r.currentPeriod, { start: '22:00', end: '07:00' });
    assert.equal(r.periodsToday, 0); // martes no tiene periodos definidos
});

test('describeRestModeNow active=false devuelve shape inactivo (isWithinNow=false)', () => {
    const win = makeScheduleWindow({
        monday: [{ start: '00:00', end: '23:59' }],
    }, { active: false });
    const r = rmw.describeRestModeNow(win, Date.UTC(2026, 0, 5, 14, 0, 0));
    assert.equal(r.active, false);
    assert.equal(r.isWithinNow, false);
    assert.equal(r.currentPeriod, null);
});

test('describeRestModeNow schedule vacío → nextPeriod null', () => {
    const win = makeScheduleWindow({});
    const r = rmw.describeRestModeNow(win, Date.UTC(2026, 0, 5, 14, 0, 0));
    assert.equal(r.isWithinNow, false);
    assert.equal(r.nextPeriod, null);
    assert.equal(r.periodsToday, 0);
});

// =========================================================================
// detectOverlapsInDay — algoritmo de overlap con wrap-around
// =========================================================================

test('detectOverlapsInDay no falsa-positiva con un solo cross-midnight', () => {
    const { detectOverlapsInDay } = rmw.__forTestsOnly__;
    const err = detectOverlapsInDay([{ start: '22:00', end: '07:00' }], 'monday');
    assert.equal(err, null);
});

test('detectOverlapsInDay sin periodos → null', () => {
    const { detectOverlapsInDay } = rmw.__forTestsOnly__;
    assert.equal(detectOverlapsInDay([], 'monday'), null);
});

test('detectOverlapsInDay periodos contiguos NO solapan ({13:00→14:00}, {14:00→15:00})', () => {
    const { detectOverlapsInDay } = rmw.__forTestsOnly__;
    const err = detectOverlapsInDay([
        { start: '13:00', end: '14:00' },
        { start: '14:00', end: '15:00' },
    ], 'monday');
    assert.equal(err, null);
});

test('detectOverlapsInDay tres cross-midnight + intra solapan correctamente', () => {
    const { detectOverlapsInDay } = rmw.__forTestsOnly__;
    // {22:00→23:30} + {22:30→07:00} → overlap en [22:30, 23:30]
    const err = detectOverlapsInDay([
        { start: '22:00', end: '23:30' },
        { start: '22:30', end: '07:00' },
    ], 'monday');
    assert.ok(err && /solapados/.test(err));
});
