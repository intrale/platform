// =============================================================================
// Tests workfile-name.js — frontera FS segura (EP5-H1, #3938, CA-7/CA-8)
//
// Cubre:
//   - issueFromFile / skillFromFile: invariancia de comportamiento legacy (CA-5)
//   - parseWorkfileName: validación estricta de issue numérico + skill allowlist
//   - Tests negativos de path-traversal: issue='../../etc', skill desconocido,
//     separadores de path, null byte, dotfiles → rechazo (CA-7)
//   - buildSkillAllowlist: derivación desde config.skills_por_fase
//   - Fixtures con valores dummy, sin tokens reales (CA-8)
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  issueFromFile,
  skillFromFile,
  parseWorkfileName,
  isValidWorkfileName,
  buildSkillAllowlist,
} = require('../workfile-name');

// Config dummy con la misma forma que config.yaml (sin secrets, CA-8).
const CONFIG_DUMMY = {
  pipelines: {
    definicion: {
      fases: ['analisis', 'criterios', 'sizing'],
      skills_por_fase: {
        analisis: ['guru', 'security'],
        criterios: ['po', 'ux', 'architect'],
        sizing: ['planner'],
      },
    },
    desarrollo: {
      fases: ['validacion', 'dev', 'build'],
      skills_por_fase: {
        validacion: ['po', 'ux', 'guru'],
        dev: ['backend-dev', 'android-dev', 'web-dev', 'pipeline-dev'],
        build: ['build'],
      },
    },
  },
};

// -----------------------------------------------------------------------------
// issueFromFile / skillFromFile — invariancia legacy (CA-5)
// -----------------------------------------------------------------------------
test('issueFromFile preserva comportamiento legacy (split por punto)', () => {
  assert.equal(issueFromFile('1732.po'), '1732');
  assert.equal(issueFromFile('2505.pipeline-dev'), '2505');
  assert.equal(issueFromFile('3938'), '3938');
});

test('skillFromFile preserva comportamiento legacy (resto tras el primer punto)', () => {
  assert.equal(skillFromFile('1732.po'), 'po');
  assert.equal(skillFromFile('2505.pipeline-dev'), 'pipeline-dev');
  assert.equal(skillFromFile('3938.backend-dev'), 'backend-dev');
});

test('issueFromFile/skillFromFile no explotan con input nulo/undefined', () => {
  assert.equal(issueFromFile(null), '');
  assert.equal(issueFromFile(undefined), '');
  assert.equal(skillFromFile(null), '');
});

// -----------------------------------------------------------------------------
// buildSkillAllowlist
// -----------------------------------------------------------------------------
test('buildSkillAllowlist junta todos los skills de todas las fases', () => {
  const allow = buildSkillAllowlist(CONFIG_DUMMY);
  assert.ok(allow.has('po'));
  assert.ok(allow.has('pipeline-dev'));
  assert.ok(allow.has('architect'));
  assert.ok(allow.has('planner'));
  assert.ok(allow.has('build'));
  // No agrega skills inexistentes.
  assert.ok(!allow.has('desconocido'));
});

test('buildSkillAllowlist es defensivo ante config malformada', () => {
  assert.equal(buildSkillAllowlist(null).size, 0);
  assert.equal(buildSkillAllowlist({}).size, 0);
  assert.equal(buildSkillAllowlist({ pipelines: 'no-es-objeto' }).size, 0);
  assert.equal(buildSkillAllowlist({ pipelines: { x: { skills_por_fase: { f: 'no-array' } } } }).size, 0);
});

// -----------------------------------------------------------------------------
// parseWorkfileName — camino feliz
// -----------------------------------------------------------------------------
test('parseWorkfileName acepta nombre válido con skill en allowlist', () => {
  const allow = buildSkillAllowlist(CONFIG_DUMMY);
  assert.deepEqual(
    parseWorkfileName({ filename: '1732.po', skillAllowlist: allow }),
    { issue: '1732', skill: 'po' },
  );
  assert.deepEqual(
    parseWorkfileName({ filename: '3938.pipeline-dev', skillAllowlist: allow }),
    { issue: '3938', skill: 'pipeline-dev' },
  );
});

test('parseWorkfileName sin allowlist valida formato pero acepta cualquier skill bien formado', () => {
  assert.deepEqual(
    parseWorkfileName({ filename: '42.some-skill' }),
    { issue: '42', skill: 'some-skill' },
  );
});

// -----------------------------------------------------------------------------
// parseWorkfileName — tests negativos de seguridad (CA-7)
// -----------------------------------------------------------------------------
test('CA-7: issue no numérico es rechazado', () => {
  const allow = buildSkillAllowlist(CONFIG_DUMMY);
  assert.equal(parseWorkfileName({ filename: 'abc.po', skillAllowlist: allow }), null);
  assert.equal(parseWorkfileName({ filename: '12ab.po', skillAllowlist: allow }), null);
  assert.equal(parseWorkfileName({ filename: '-5.po', skillAllowlist: allow }), null);
});

test('CA-7: path traversal en issue es rechazado (nunca deriva path)', () => {
  const allow = buildSkillAllowlist(CONFIG_DUMMY);
  assert.equal(parseWorkfileName({ filename: '../../etc.po', skillAllowlist: allow }), null);
  assert.equal(parseWorkfileName({ filename: '..\\..\\etc.po', skillAllowlist: allow }), null);
  assert.equal(parseWorkfileName({ filename: '../../etc/passwd', skillAllowlist: allow }), null);
});

test('CA-7: skill desconocido (fuera de allowlist) es rechazado', () => {
  const allow = buildSkillAllowlist(CONFIG_DUMMY);
  assert.equal(parseWorkfileName({ filename: '1732.skill-pirata', skillAllowlist: allow }), null);
  assert.equal(parseWorkfileName({ filename: '1732.rm-rf', skillAllowlist: allow }), null);
});

test('CA-7: separadores de path / null byte / traversal en skill son rechazados', () => {
  assert.equal(parseWorkfileName({ filename: '1732.po/../../x' }), null);
  assert.equal(parseWorkfileName({ filename: '1732.po\\evil' }), null);
  assert.equal(parseWorkfileName({ filename: '1732.po\0' }), null);
  assert.equal(parseWorkfileName({ filename: '1732..' }), null);
});

test('CA-7: nombres degenerados son rechazados', () => {
  assert.equal(parseWorkfileName({ filename: '' }), null);
  assert.equal(parseWorkfileName({ filename: '.gitkeep' }), null);
  assert.equal(parseWorkfileName({ filename: '1732' }), null);   // sin skill
  assert.equal(parseWorkfileName({ filename: '1732.' }), null);  // skill vacío
  assert.equal(parseWorkfileName({ filename: '.1732.po' }), null); // dotfile
  assert.equal(parseWorkfileName({ filename: null }), null);
  assert.equal(parseWorkfileName({}), null);
});

test('CA-7: skill con mayúsculas/espacios/puntos es rechazado por formato', () => {
  assert.equal(parseWorkfileName({ filename: '1732.PO' }), null);
  assert.equal(parseWorkfileName({ filename: '1732.po dev' }), null);
  assert.equal(parseWorkfileName({ filename: '1732.a.b' }), null); // punto interno en skill
});

// -----------------------------------------------------------------------------
// isValidWorkfileName
// -----------------------------------------------------------------------------
test('isValidWorkfileName refleja parseWorkfileName', () => {
  const allow = buildSkillAllowlist(CONFIG_DUMMY);
  assert.equal(isValidWorkfileName('1732.po', allow), true);
  assert.equal(isValidWorkfileName('../../etc.po', allow), false);
  assert.equal(isValidWorkfileName('1732.desconocido', allow), false);
});
