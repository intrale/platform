// Tests de integración del gate de modo descanso.
// Cubre:
//   - CA-5.3 (issue con skill po queda en pendiente dentro de la ventana,
//     avanza al cerrar) y CA-5.4 (priority:critical hace bypass) emulando
//     el flujo de pulpo.js sin lanzar el pulpo de verdad.
//   - #3241 round-trip set/get con schedule, audit con schedule completo,
//     migración legacy → schedule en el primer write.
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

// El gate del pulpo es una composición:
//   if (!rmw.isSkillAllowedNow(skill, now, { cfg, bypassLabels }).allowed) {
//      // queda en pendiente/, sin penalizar
//   }
// Acá lo simulamos tal cual.
function simulatePulpoGate(skill, issueLabels, now, opts) {
    const r = rmw.isSkillAllowedNow(skill, now, {
        cfg: opts.cfg,
        bypassLabels: issueLabels,
        pipelineDir: opts.pipelineDir,
    });
    return { advances: r.allowed, reason: r.reason };
}

// =========================================================================
// CA-5.3 — issue con skill `po` queda en pendiente/ dentro de la ventana
// =========================================================================

test('CA-5.3: skill po dentro de ventana NO avanza, fuera SI avanza', () => {
    const dir = tmpDir('rmw-int-ca53-');
    rmw.setWindow({
        active: true,
        schedule: {
            monday: [{ start: '13:00', end: '17:00' }],
            tuesday: [{ start: '13:00', end: '17:00' }],
            wednesday: [{ start: '13:00', end: '17:00' }],
            thursday: [{ start: '13:00', end: '17:00' }],
            friday: [{ start: '13:00', end: '17:00' }],
            saturday: [{ start: '13:00', end: '17:00' }],
            sunday: [{ start: '13:00', end: '17:00' }],
        },
        timezone: 'UTC',
    }, { pipelineDir: dir, actor: 'test' });

    const insideTick = simulatePulpoGate('po', [], Date.UTC(2026, 0, 5, 14, 0, 0), {
        cfg: { bypass_labels: ['priority:critical'] },
        pipelineDir: dir,
    });
    assert.equal(insideTick.advances, false);
    assert.equal(insideTick.reason, 'within_window_non_deterministic');

    const outsideTick = simulatePulpoGate('po', [], Date.UTC(2026, 0, 5, 18, 0, 0), {
        cfg: { bypass_labels: ['priority:critical'] },
        pipelineDir: dir,
    });
    assert.equal(outsideTick.advances, true);
    assert.equal(outsideTick.reason, 'outside_window');
});

// =========================================================================
// CA-5.4 — bypass por label priority:critical
// =========================================================================

test('CA-5.4: ventana activa + priority:critical → bypass', () => {
    const dir = tmpDir('rmw-int-ca54-');
    rmw.setWindow({
        active: true,
        schedule: {
            monday: [{ start: '13:00', end: '17:00' }],
        },
        timezone: 'UTC',
    }, { pipelineDir: dir, actor: 'test' });

    const r = simulatePulpoGate('po', ['priority:critical', 'enhancement'], Date.UTC(2026, 0, 5, 14, 0, 0), {
        cfg: { bypass_labels: ['priority:critical'] },
        pipelineDir: dir,
    });
    assert.equal(r.advances, true);
    assert.equal(r.reason, 'bypass_label');
});

// =========================================================================
// CA-1.5 — solo skills determinísticos pasan dentro de la ventana
// =========================================================================

test('CA-1.5: dentro de la ventana, sólo delivery/builder/linter/tester pasan', () => {
    const dir = tmpDir('rmw-int-ca15-');
    rmw.setWindow({
        active: true,
        schedule: {
            monday: [{ start: '00:00', end: '23:59' }],
        },
        timezone: 'UTC',
    }, { pipelineDir: dir, actor: 'test' });

    const now = Date.UTC(2026, 0, 5, 12, 0, 0); // lunes mediodía UTC, dentro
    const cfg = { bypass_labels: ['priority:critical'] };

    for (const skill of ['delivery', 'build', 'linter', 'tester']) {
        const r = simulatePulpoGate(skill, [], now, { cfg, pipelineDir: dir });
        assert.equal(r.advances, true, `${skill} debería pasar`);
    }
    for (const skill of ['po', 'ux', 'guru', 'security', 'planner', 'qa', 'review',
        'android-dev', 'backend-dev', 'web-dev', 'pipeline-dev']) {
        const r = simulatePulpoGate(skill, [], now, { cfg, pipelineDir: dir });
        assert.equal(r.advances, false, `${skill} NO debería pasar`);
    }
});

// =========================================================================
// CA-1.9 — fuera de ventana o active=false → sin restricciones
// =========================================================================

test('CA-1.9: active=false permite TODO sin importar la hora', () => {
    const dir = tmpDir('rmw-int-ca19a-');
    rmw.setWindow({
        active: false,
        schedule: {
            monday: [{ start: '13:00', end: '17:00' }],
        },
        timezone: 'UTC',
    }, { pipelineDir: dir, actor: 'test' });

    const now = Date.UTC(2026, 0, 5, 14, 0, 0);
    const cfg = { bypass_labels: ['priority:critical'] };

    for (const skill of ['po', 'android-dev', 'qa', 'guru', 'review']) {
        const r = simulatePulpoGate(skill, [], now, { cfg, pipelineDir: dir });
        assert.equal(r.advances, true, `${skill} debería pasar (active=false)`);
    }
});

test('CA-1.9: archivo ausente → ventana inactiva, todo permitido (fail-open)', () => {
    const dir = tmpDir('rmw-int-noent-');
    const now = Date.UTC(2026, 0, 5, 14, 0, 0);
    const r = simulatePulpoGate('po', [], now, {
        cfg: { bypass_labels: ['priority:critical'] },
        pipelineDir: dir,
    });
    assert.equal(r.advances, true);
});

// =========================================================================
// #3241 — Round-trip set/get con schedule semanal (CA-1, CA-3)
// =========================================================================

test('#3241 round-trip: set schedule complejo y recuperar idéntico', () => {
    const dir = tmpDir('rmw-int-rt-');
    const input = {
        active: true,
        timezone: 'America/Argentina/Buenos_Aires',
        manual: false,
        schedule: {
            monday: [
                { start: '06:00', end: '08:00' },
                { start: '13:00', end: '14:00' },
                { start: '22:00', end: '23:30' },
            ],
            tuesday: [{ start: '15:00', end: '17:00' }],
            wednesday: [],
            thursday: [{ start: '08:00', end: '12:00' }],
            friday: [],
            saturday: [],
            sunday: [{ start: '00:00', end: '23:59' }],
        },
    };
    const r = rmw.setWindow(input, { pipelineDir: dir, actor: 'test' });
    assert.equal(r.ok, true);
    const w = rmw.getWindow({ pipelineDir: dir });
    assert.equal(w.active, true);
    assert.equal(w.timezone, 'America/Argentina/Buenos_Aires');
    for (const day of rmw.VALID_DAYS) {
        assert.deepEqual(w.schedule[day], input.schedule[day], `${day} round-trip`);
    }
});

// =========================================================================
// #3241 — Migración legacy → schedule en primer write (CA-2)
// =========================================================================

test('#3241 migración: archivo legacy en disco al boot se interpreta y migra al primer setWindow', () => {
    const dir = tmpDir('rmw-int-migr-');
    // 1. Simular que en disco hay un archivo legacy (formato pre-#3241)
    fs.writeFileSync(path.join(dir, 'rest-mode.json'), JSON.stringify({
        active: true,
        start: '22:00',
        end: '08:00',
        timezone: 'UTC',
        days: [1, 2, 3, 4, 5], // lun-vie
        manual: false,
        updatedAt: '2026-05-01T00:00:00Z',
    }, null, 2));

    // 2. Boot lee correctamente (sintetiza schedule en memoria)
    const wBoot = rmw.getWindow({ pipelineDir: dir });
    assert.equal(wBoot.active, true);
    assert.equal(wBoot.start, '22:00');
    assert.equal(wBoot.end, '08:00');
    assert.deepEqual(wBoot.schedule.monday, [{ start: '22:00', end: '08:00' }]);
    assert.deepEqual(wBoot.schedule.saturday, []);

    // 3. isWithinWindow sigue funcionando contra el archivo legacy en disco
    //    (sintetizado lazy desde legacy).
    // 2026-01-05 23:00 UTC = lunes 23:00 UTC → dentro
    const verdictInside = rmw.isSkillAllowedNow('po', Date.UTC(2026, 0, 5, 23, 0, 0), {
        cfg: { bypass_labels: ['priority:critical'] },
        pipelineDir: dir,
    });
    assert.equal(verdictInside.allowed, false);
    assert.equal(verdictInside.reason, 'within_window_non_deterministic');

    // 4. Primer setWindow → migra el archivo a schedule
    rmw.setWindow({
        active: true,
        schedule: {
            monday: [{ start: '22:00', end: '08:00' }],
            tuesday: [{ start: '22:00', end: '08:00' }],
        },
        timezone: 'UTC',
    }, { pipelineDir: dir, actor: 'api' });

    const raw = readJson(path.join(dir, 'rest-mode.json'));
    assert.ok(raw.schedule, 'archivo debe tener schedule tras primer write');
    assert.equal(raw.start, undefined, 'campo legacy start debe haber desaparecido');
    assert.equal(raw.end, undefined, 'campo legacy end debe haber desaparecido');
    assert.equal(raw.days, undefined, 'campo legacy days debe haber desaparecido');
});

test('#3241 migración: archivo legacy con start===end (24h) migra a {00:00→23:59}', () => {
    const dir = tmpDir('rmw-int-migr24-');
    fs.writeFileSync(path.join(dir, 'rest-mode.json'), JSON.stringify({
        active: true,
        start: '00:00',
        end: '00:00', // legacy: 24h window
        timezone: 'UTC',
        days: [0, 1, 2, 3, 4, 5, 6],
        manual: false,
    }));

    const w = rmw.getWindow({ pipelineDir: dir });
    // Schedule sintetizado: cada día tiene un periodo 00:00→23:59
    for (const day of rmw.VALID_DAYS) {
        assert.deepEqual(w.schedule[day], [{ start: '00:00', end: '23:59' }]);
    }
});

// =========================================================================
// #3241 — Audit con schedule completo en prev/next (CA-7)
// =========================================================================

test('#3241 audit jsonl: prev y next contienen schedule completo (CA-7)', () => {
    const dir = tmpDir('rmw-int-audit-');

    // First write
    rmw.setWindow({
        active: true,
        schedule: { monday: [{ start: '08:00', end: '10:00' }] },
        timezone: 'UTC',
    }, { pipelineDir: dir, actor: 'op1' });

    // Second write: agregar otro día
    rmw.setWindow({
        active: true,
        schedule: {
            monday: [{ start: '08:00', end: '10:00' }],
            wednesday: [{ start: '15:00', end: '17:00' }],
        },
        timezone: 'UTC',
    }, { pipelineDir: dir, actor: 'op2' });

    const lines = fs.readFileSync(path.join(dir, 'rest-mode-audit.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const e2 = JSON.parse(lines[1]);

    // prev tiene monday con periodo
    assert.deepEqual(e2.prev.schedule.monday, [{ start: '08:00', end: '10:00' }]);
    assert.deepEqual(e2.prev.schedule.wednesday, []);
    // next tiene monday y wednesday
    assert.deepEqual(e2.next.schedule.monday, [{ start: '08:00', end: '10:00' }]);
    assert.deepEqual(e2.next.schedule.wednesday, [{ start: '15:00', end: '17:00' }]);
});

// =========================================================================
// #3241 — Periodos nocturnos cross-midnight + bypass labels regresión
// =========================================================================

test('#3241 cross-midnight: periodo {22:00→07:00} respeta día de origen', () => {
    const dir = tmpDir('rmw-int-cm-');
    rmw.setWindow({
        active: true,
        schedule: { monday: [{ start: '22:00', end: '07:00' }] },
        timezone: 'UTC',
    }, { pipelineDir: dir, actor: 'test' });

    // 2026-01-06 02:00 UTC = martes 02:00 → residual cross-midnight del lunes
    const r = simulatePulpoGate('po', [], Date.UTC(2026, 0, 6, 2, 0, 0), {
        cfg: { bypass_labels: ['priority:critical'] },
        pipelineDir: dir,
    });
    assert.equal(r.advances, false, 'martes 02:00 UTC todavía dentro de residual lunes');

    // 2026-01-06 08:00 UTC = martes 08:00 → fuera
    const r2 = simulatePulpoGate('po', [], Date.UTC(2026, 0, 6, 8, 0, 0), {
        cfg: { bypass_labels: ['priority:critical'] },
        pipelineDir: dir,
    });
    assert.equal(r2.advances, true);
});

test('#3241 día vacío (saturday: []) skill NO se bloquea ese día', () => {
    const dir = tmpDir('rmw-int-empty-');
    rmw.setWindow({
        active: true,
        schedule: {
            monday: [{ start: '00:00', end: '23:59' }],
            saturday: [],
        },
        timezone: 'UTC',
    }, { pipelineDir: dir, actor: 'test' });

    // 2026-01-03 = sábado UTC
    const r = simulatePulpoGate('po', [], Date.UTC(2026, 0, 3, 14, 0, 0), {
        cfg: { bypass_labels: ['priority:critical'] },
        pipelineDir: dir,
    });
    assert.equal(r.advances, true, 'sábado sin periodos → skill avanza');
});

test('#3241 regresión: bypass labels siguen funcionando con schedule', () => {
    const dir = tmpDir('rmw-int-bypass-');
    rmw.setWindow({
        active: true,
        schedule: { monday: [{ start: '13:00', end: '17:00' }] },
        timezone: 'UTC',
    }, { pipelineDir: dir, actor: 'test' });

    const r = simulatePulpoGate('po', ['priority:critical'], Date.UTC(2026, 0, 5, 14, 0, 0), {
        cfg: { bypass_labels: ['priority:critical'] },
        pipelineDir: dir,
    });
    assert.equal(r.advances, true);
    assert.equal(r.reason, 'bypass_label');
});

// =========================================================================
// CA-1.4 — días configurables (regresión con legacy en disco)
// =========================================================================

test('CA-1.4: gate respeta días configurados (sábado sin periodo → permite)', () => {
    const dir = tmpDir('rmw-int-ca14-');
    rmw.setWindow({
        active: true,
        schedule: {
            monday: [{ start: '13:00', end: '17:00' }],
            tuesday: [{ start: '13:00', end: '17:00' }],
            wednesday: [{ start: '13:00', end: '17:00' }],
            thursday: [{ start: '13:00', end: '17:00' }],
            friday: [{ start: '13:00', end: '17:00' }],
            // saturday y sunday vacíos
        },
        timezone: 'UTC',
    }, { pipelineDir: dir, actor: 'test' });

    const cfg = { bypass_labels: ['priority:critical'] };

    // Sábado 14:00 UTC → fuera de gate
    const sat = simulatePulpoGate('po', [], Date.UTC(2026, 0, 3, 14, 0, 0), {
        cfg, pipelineDir: dir,
    });
    assert.equal(sat.advances, true);

    // Lunes 14:00 UTC → bloqueado
    const mon = simulatePulpoGate('po', [], Date.UTC(2026, 0, 5, 14, 0, 0), {
        cfg, pipelineDir: dir,
    });
    assert.equal(mon.advances, false);
});

// =========================================================================
// Coherencia API estable (PO-API-1): pulpo.js:4019 sin cambios
// =========================================================================

test('PO-API-1: isSkillAllowedNow firma estable (skill, now, {cfg, bypassLabels, pipelineDir})', () => {
    const dir = tmpDir('rmw-api-');
    rmw.setWindow({
        active: true,
        schedule: { monday: [{ start: '13:00', end: '17:00' }] },
        timezone: 'UTC',
    }, { pipelineDir: dir, actor: 'test' });

    // Llamada idéntica a pulpo.js:4019
    const verdict = rmw.isSkillAllowedNow('po', Date.UTC(2026, 0, 5, 14, 0, 0), {
        cfg: { bypass_labels: ['priority:critical'] },
        bypassLabels: ['enhancement'],
        pipelineDir: dir,
    });
    assert.equal(typeof verdict.allowed, 'boolean');
    assert.equal(typeof verdict.reason, 'string');
    assert.equal(typeof verdict.withinWindow, 'boolean');
    assert.equal(typeof verdict.deterministic, 'boolean');
});
