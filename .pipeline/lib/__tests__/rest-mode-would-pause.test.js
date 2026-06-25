// Tests del cómputo read-only `wouldPauseSkills` + `nowLocal` que el GET
// /api/rest-mode expone para el preview del timeline (#3964, EP8-H11, CA-6/CA-4).
//
// El cómputo vive inline en `.pipeline/dashboard.js` (closures del handler GET),
// reusando `restModeWindow.isSkillAllowedNow` + `DETERMINISTIC_SKILLS` y
// `partsInTz`. Estos tests:
//   1. Verifican estructuralmente que el handler agrega los campos nuevos y
//      reutiliza la lista canónica (no mirrorea DETERMINISTIC_SKILLS).
//   2. Ejercitan la lógica de clasificación contra el módulo real: un skill
//      no-determinístico se pausa; uno determinístico no.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const rmw = require(path.resolve(__dirname, '..', 'rest-mode-window.js'));
const DASHBOARD_PATH = path.resolve(__dirname, '..', '..', 'dashboard.js');
const dashboardSrc = fs.readFileSync(DASHBOARD_PATH, 'utf8');

test('el GET /api/rest-mode agrega wouldPauseSkills y nowLocal al payload', () => {
    assert.match(dashboardSrc, /wouldPauseSkills/);
    assert.match(dashboardSrc, /nowLocal/);
    assert.match(dashboardSrc, /computeWouldPauseSkills/);
    assert.match(dashboardSrc, /computeNowLocal/);
});

test('el cómputo reutiliza la lista canónica (isSkillAllowedNow), no mirrorea DETERMINISTIC_SKILLS en el cliente', () => {
    // El handler debe clasificar vía isSkillAllowedNow + el flag deterministic,
    // y derivar el catálogo de skills_por_fase (config), no hardcodear skills.
    assert.match(dashboardSrc, /isSkillAllowedNow\(/);
    assert.match(dashboardSrc, /skills_por_fase/);
    assert.match(dashboardSrc, /cls\.deterministic === false/);
});

test('el endpoint POST loopback-only NO fue modificado (sigue presente)', () => {
    assert.match(dashboardSrc, /loopback-only endpoint, got remote=/);
    assert.match(dashboardSrc, /body\.length > 16 \* 1024/);
});

test('clasificación: skill NO determinístico queda pausado durante la ventana', () => {
    const window = { active: true, timezone: 'UTC', schedule: { monday: [{ start: '00:00', end: '23:59' }] } };
    // forzamos "dentro de ventana" con un lunes a las 12:00 UTC
    const mondayNoon = Date.UTC(2026, 5, 22, 12, 0, 0); // 2026-06-22 es lunes
    for (const skill of ['guru', 'backend-dev', 'pipeline-dev', 'po', 'ux']) {
        const cls = rmw.isSkillAllowedNow(skill, mondayNoon, { window, cfg: {} });
        assert.equal(cls.deterministic, false, skill + ' debería ser no-determinístico');
    }
});

test('clasificación: skill determinístico NO se pausa (no entra en wouldPauseSkills)', () => {
    const window = { active: true, timezone: 'UTC', schedule: { monday: [{ start: '00:00', end: '23:59' }] } };
    const mondayNoon = Date.UTC(2026, 5, 22, 12, 0, 0);
    for (const skill of rmw.DETERMINISTIC_SKILLS) {
        const cls = rmw.isSkillAllowedNow(skill, mondayNoon, { window, cfg: {} });
        assert.equal(cls.deterministic, true, skill + ' debería ser determinístico');
        assert.equal(cls.allowed, true, skill + ' determinístico siempre allowed');
    }
});

test('el flag deterministic es estable aún fuera de ventana (lo usa el preview)', () => {
    const window = { active: false, timezone: 'UTC', schedule: {} };
    const cls = rmw.isSkillAllowedNow('guru', Date.now(), { window, cfg: {} });
    assert.equal(cls.deterministic, false);
    assert.equal(cls.reason, 'outside_window');
});

test('partsInTz da hora/weekday usable para el marcador "ahora" (CA-4)', () => {
    const mondayNoon = Date.UTC(2026, 5, 22, 12, 0, 0);
    const parts = rmw.partsInTz('UTC', mondayNoon);
    assert.equal(parts.hour, 12);
    assert.equal(parts.minute, 0);
    assert.equal(parts.weekday, 1); // lunes
});
