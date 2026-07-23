// Tests del filtro `shouldRunQaPreflight(skill, fase)` y la whitelist
// `SKILLS_THAT_NEED_EMULATOR` (issue #3140).
//
// Bug original: `pulpo.js` disparaba `preflightQaChecks` (y por extensión
// `requestEmulator`) para CUALQUIER skill en fase `verificacion`. Esto levantaba
// el emulador Android innecesariamente durante modo descanso cuando solo corrían
// skills determinísticos (`tester` / `security`).
//
// Cubre los CAs:
// - CA-1 — Existe la whitelist `SKILLS_THAT_NEED_EMULATOR` con contenido `['qa']`.
// - CA-2/CA-4 — `shouldRunQaPreflight` filtra por skill correctamente.
// - CA-3 — `qa` en `verificacion` sigue disparando preflight.
// - CA-5 — Las 3 combinaciones del set `[tester, security, qa]` están testeadas.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Levantar pulpo.js en modo test (no inicia singleton ni mainLoop)
process.env.PULPO_NO_AUTOSTART = '1';
const pulpo = require('../pulpo.js');

// ----- CA-1: la whitelist existe y contiene solo `qa` ---------------------------

test('SKILLS_THAT_NEED_EMULATOR es un Set y contiene únicamente "qa"', () => {
    assert.ok(pulpo.SKILLS_THAT_NEED_EMULATOR instanceof Set, 'debe ser un Set');
    assert.equal(pulpo.SKILLS_THAT_NEED_EMULATOR.size, 1);
    assert.ok(pulpo.SKILLS_THAT_NEED_EMULATOR.has('qa'));
});

test('SKILLS_THAT_NEED_EMULATOR NO contiene skills determinísticos', () => {
    const determ = ['tester', 'security', 'builder', 'review', 'pipeline-dev', 'po', 'planner', 'guru', 'ux'];
    for (const skill of determ) {
        assert.ok(
            !pulpo.SKILLS_THAT_NEED_EMULATOR.has(skill),
            `'${skill}' no debería disparar emulador en verificacion`,
        );
    }
});

// ----- CA-3: `qa` en `verificacion` SÍ dispara preflight -----------------------

test('shouldRunQaPreflight("qa", "verificacion") === true', () => {
    assert.equal(pulpo.shouldRunQaPreflight('qa', 'verificacion'), true);
});

// ----- CA-4: `tester` y `security` en `verificacion` NO disparan preflight -----

test('shouldRunQaPreflight("tester", "verificacion") === false', () => {
    assert.equal(pulpo.shouldRunQaPreflight('tester', 'verificacion'), false);
});

test('shouldRunQaPreflight("security", "verificacion") === false', () => {
    assert.equal(pulpo.shouldRunQaPreflight('security', 'verificacion'), false);
});

// ----- CA-5: cobertura completa del set actual de verificacion -----------------

test('cobertura de las 3 combinaciones del set [tester, security, qa] en verificacion', () => {
    const cases = [
        { skill: 'tester', expected: false },
        { skill: 'security', expected: false },
        { skill: 'qa', expected: true },
    ];
    for (const { skill, expected } of cases) {
        assert.equal(
            pulpo.shouldRunQaPreflight(skill, 'verificacion'),
            expected,
            `'${skill}' en verificacion debería retornar ${expected}`,
        );
    }
});

// ----- Casos colaterales: otras fases nunca disparan preflight ------------------

test('shouldRunQaPreflight no dispara en fases distintas de "verificacion" (aunque sea qa)', () => {
    const otherPhases = ['analisis', 'criterios', 'validacion', 'dev', 'build', 'aprobacion', 'entrega'];
    for (const fase of otherPhases) {
        assert.equal(
            pulpo.shouldRunQaPreflight('qa', fase),
            false,
            `qa en fase '${fase}' no debe disparar preflight (solo 'verificacion' aplica)`,
        );
    }
});

test('shouldRunQaPreflight es defensivo ante inputs nulos / vacíos', () => {
    assert.equal(pulpo.shouldRunQaPreflight(null, 'verificacion'), false);
    assert.equal(pulpo.shouldRunQaPreflight(undefined, 'verificacion'), false);
    assert.equal(pulpo.shouldRunQaPreflight('qa', null), false);
    assert.equal(pulpo.shouldRunQaPreflight('qa', undefined), false);
    assert.equal(pulpo.shouldRunQaPreflight('', ''), false);
});
