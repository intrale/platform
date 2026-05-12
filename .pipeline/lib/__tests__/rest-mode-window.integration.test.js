// Tests de integración del gate de modo descanso.
// Cubre el escenario CA-5.3 (issue con skill po queda en pendiente/ dentro
// de la ventana, avanza al cerrar) y CA-5.4 (priority:critical hace bypass)
// emulando el flujo de pulpo.js sin lanzar el pulpo de verdad.
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
        start: '13:00',
        end: '17:00',
        timezone: 'UTC',
        days: [0, 1, 2, 3, 4, 5, 6],
    }, { pipelineDir: dir, actor: 'test' });

    // Dentro de la ventana — queda en pendiente.
    const insideTick = simulatePulpoGate('po', [], Date.UTC(2026, 0, 5, 14, 0, 0), {
        cfg: { bypass_labels: ['priority:critical'] },
        pipelineDir: dir,
    });
    assert.equal(insideTick.advances, false);
    assert.equal(insideTick.reason, 'within_window_non_deterministic');

    // Cerramos la ventana (simular tick siguiente fuera del rango horario):
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
        start: '13:00',
        end: '17:00',
        timezone: 'UTC',
        days: [0, 1, 2, 3, 4, 5, 6],
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
        start: '00:00',
        end: '23:59',
        timezone: 'UTC',
        days: [0, 1, 2, 3, 4, 5, 6],
    }, { pipelineDir: dir, actor: 'test' });

    const now = Date.UTC(2026, 0, 5, 12, 0, 0); // mediodia UTC, dentro
    const cfg = { bypass_labels: ['priority:critical'] };

    // Determinísticos pasan.
    for (const skill of ['delivery', 'build', 'linter', 'tester']) {
        const r = simulatePulpoGate(skill, [], now, { cfg, pipelineDir: dir });
        assert.equal(r.advances, true, `${skill} debería pasar`);
    }

    // LLM-based no pasan.
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
        start: '13:00',
        end: '17:00',
        timezone: 'UTC',
        days: [0, 1, 2, 3, 4, 5, 6],
    }, { pipelineDir: dir, actor: 'test' });

    const now = Date.UTC(2026, 0, 5, 14, 0, 0); // dentro del rango si estuviera activa
    const cfg = { bypass_labels: ['priority:critical'] };

    for (const skill of ['po', 'android-dev', 'qa', 'guru', 'review']) {
        const r = simulatePulpoGate(skill, [], now, { cfg, pipelineDir: dir });
        assert.equal(r.advances, true, `${skill} debería pasar (active=false)`);
    }
});

test('CA-1.9: archivo ausente → ventana inactiva, todo permitido (fail-open)', () => {
    const dir = tmpDir('rmw-int-noent-');
    // No llamamos a setWindow → archivo no existe.
    const now = Date.UTC(2026, 0, 5, 14, 0, 0);
    const r = simulatePulpoGate('po', [], now, {
        cfg: { bypass_labels: ['priority:critical'] },
        pipelineDir: dir,
    });
    assert.equal(r.advances, true);
});

// =========================================================================
// CA-1.4 — días configurables
// =========================================================================

test('CA-1.4: gate se desactiva en días no configurados aun dentro de horario', () => {
    const dir = tmpDir('rmw-int-ca14-');
    // Lun-vie únicamente
    rmw.setWindow({
        active: true,
        start: '13:00',
        end: '17:00',
        timezone: 'UTC',
        days: [1, 2, 3, 4, 5],
    }, { pipelineDir: dir, actor: 'test' });

    const cfg = { bypass_labels: ['priority:critical'] };

    // Sábado (day=6), 14:00 UTC — fin de semana → fuera de gate
    const sat = simulatePulpoGate('po', [], Date.UTC(2026, 0, 3, 14, 0, 0), {
        cfg, pipelineDir: dir,
    });
    assert.equal(sat.advances, true);

    // Lunes (day=1), 14:00 UTC — laborable → bloqueado
    const mon = simulatePulpoGate('po', [], Date.UTC(2026, 0, 5, 14, 0, 0), {
        cfg, pipelineDir: dir,
    });
    assert.equal(mon.advances, false);
});
