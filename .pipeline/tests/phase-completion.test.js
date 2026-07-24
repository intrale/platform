// Tests de .pipeline/lib/phase-completion.js (issue #3481)
//
// Cubre los criterios de aceptación CA-1..CA-9 del fix del brazo de promoción:
// detecta artefactos varados en procesado/, filtra falsos positivos
// (rechazados, cancelados, sin resultado), respeta concurrencia con
// pendiente/trabajando, no rompe ante YAML malformado.
//
// La función bajo test es PURA — los YAMLs se inyectan ya parseados.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateParallelPhaseCompletion,
  isApprovedArtifact,
  formatOrigenLog,
} = require('../lib/phase-completion');

// ----- isApprovedArtifact ----------------------------------------------------

test('isApprovedArtifact: resultado=aprobado sin cancelado_por → true', () => {
  assert.equal(isApprovedArtifact({ resultado: 'aprobado' }), true);
  assert.equal(isApprovedArtifact({ resultado: 'aprobado', notas: 'todo ok' }), true);
});

test('isApprovedArtifact: resultado=rechazado → false', () => {
  assert.equal(isApprovedArtifact({ resultado: 'rechazado', motivo: 'x' }), false);
});

test('isApprovedArtifact: sin campo resultado → false', () => {
  assert.equal(isApprovedArtifact({ notas: 'algo' }), false);
});

test('isApprovedArtifact: cancelado_por con cualquier valor → false', () => {
  assert.equal(
    isApprovedArtifact({ resultado: 'aprobado', cancelado_por: 'fast-fail-rebote' }),
    false,
  );
  assert.equal(
    isApprovedArtifact({ resultado: 'aprobado', cancelado_por: 'cross-phase-rebote' }),
    false,
  );
  assert.equal(
    isApprovedArtifact({ resultado: 'aprobado', cancelado_por: 'algun-otro-valor' }),
    false,
  );
});

test('isApprovedArtifact: cancelado_por=null / "" / undefined → SÍ aprueba (whitelist tolera campo vacío)', () => {
  assert.equal(isApprovedArtifact({ resultado: 'aprobado', cancelado_por: null }), true);
  assert.equal(isApprovedArtifact({ resultado: 'aprobado', cancelado_por: '' }), true);
  assert.equal(isApprovedArtifact({ resultado: 'aprobado', cancelado_por: undefined }), true);
});

test('isApprovedArtifact: input no-objeto → false (defensa contra YAML corrupto)', () => {
  assert.equal(isApprovedArtifact(null), false);
  assert.equal(isApprovedArtifact(undefined), false);
  assert.equal(isApprovedArtifact('string'), false);
  assert.equal(isApprovedArtifact(42), false);
  assert.equal(isApprovedArtifact([]), false); // array es typeof 'object' — se aceptaría pero falta `resultado`
});

// ----- CA-1: happy path mezcla listo/ + procesado/ ---------------------------

test('CA-1: 2 skills aprobados en listo/ + 1 skill aprobado en procesado/ → promueve', () => {
  const r = evaluateParallelPhaseCompletion({
    skillsRequeridos: ['guru', 'po', 'ux'],
    listo: [
      { skill: 'guru', yaml: { resultado: 'aprobado' } },
      { skill: 'po', yaml: { resultado: 'aprobado' } },
    ],
    procesado: [
      { skill: 'ux', yaml: { resultado: 'aprobado' } },
    ],
  });
  assert.equal(r.todosCompletos, true);
  assert.equal(r.origenPorSkill.guru, 'listo');
  assert.equal(r.origenPorSkill.po, 'listo');
  assert.equal(r.origenPorSkill.ux, 'procesado');
  assert.deepEqual(r.skillsFaltantes, []);
});

// ----- CA-2: anti-falso-positivo rechazado -----------------------------------

test('CA-2: artefacto en procesado/ con resultado=rechazado → NO promueve', () => {
  const r = evaluateParallelPhaseCompletion({
    skillsRequeridos: ['guru', 'po', 'ux'],
    listo: [
      { skill: 'guru', yaml: { resultado: 'aprobado' } },
      { skill: 'po', yaml: { resultado: 'aprobado' } },
    ],
    procesado: [
      { skill: 'ux', yaml: { resultado: 'rechazado', motivo: 'fallo previo' } },
    ],
  });
  assert.equal(r.todosCompletos, false);
  assert.deepEqual(r.skillsFaltantes, ['ux']);
});

test('CA-2 bis: artefacto en procesado/ SIN campo resultado → NO promueve', () => {
  const r = evaluateParallelPhaseCompletion({
    skillsRequeridos: ['guru', 'po', 'ux'],
    listo: [
      { skill: 'guru', yaml: { resultado: 'aprobado' } },
      { skill: 'po', yaml: { resultado: 'aprobado' } },
    ],
    procesado: [
      { skill: 'ux', yaml: { notas: 'sin resultado' } },
    ],
  });
  assert.equal(r.todosCompletos, false);
  assert.deepEqual(r.skillsFaltantes, ['ux']);
});

// ----- CA-3: anti-falso-positivo cancelado_por:* -----------------------------

test('CA-3: procesado/ con cancelado_por=fast-fail-rebote → NO promueve', () => {
  const r = evaluateParallelPhaseCompletion({
    skillsRequeridos: ['guru', 'po', 'ux'],
    listo: [
      { skill: 'guru', yaml: { resultado: 'aprobado' } },
      { skill: 'po', yaml: { resultado: 'aprobado' } },
    ],
    procesado: [
      { skill: 'ux', yaml: { resultado: 'aprobado', cancelado_por: 'fast-fail-rebote' } },
    ],
  });
  assert.equal(r.todosCompletos, false);
  assert.deepEqual(r.skillsFaltantes, ['ux']);
});

test('CA-3 bis: procesado/ con cancelado_por=cross-phase-rebote → NO promueve', () => {
  const r = evaluateParallelPhaseCompletion({
    skillsRequeridos: ['guru', 'po', 'ux'],
    listo: [
      { skill: 'guru', yaml: { resultado: 'aprobado' } },
      { skill: 'po', yaml: { resultado: 'aprobado' } },
    ],
    procesado: [
      { skill: 'ux', yaml: { resultado: 'aprobado', cancelado_por: 'cross-phase-rebote' } },
    ],
  });
  assert.equal(r.todosCompletos, false);
});

test('CA-3 ter: procesado/ con cancelado_por=cualquier-otro-valor → NO promueve (whitelist estricta)', () => {
  const r = evaluateParallelPhaseCompletion({
    skillsRequeridos: ['guru', 'po', 'ux'],
    listo: [
      { skill: 'guru', yaml: { resultado: 'aprobado' } },
      { skill: 'po', yaml: { resultado: 'aprobado' } },
    ],
    procesado: [
      { skill: 'ux', yaml: { resultado: 'aprobado', cancelado_por: 'inventado-futuro' } },
    ],
  });
  assert.equal(r.todosCompletos, false);
});

// ----- CA-4: anti-race con pendiente/ y trabajando/ --------------------------

test('CA-4: procesado/aprobado pero mismo skill VIVO en pendiente/ → NO promueve', () => {
  const r = evaluateParallelPhaseCompletion({
    skillsRequeridos: ['guru', 'po', 'ux'],
    listo: [
      { skill: 'guru', yaml: { resultado: 'aprobado' } },
      { skill: 'po', yaml: { resultado: 'aprobado' } },
    ],
    procesado: [
      { skill: 'ux', yaml: { resultado: 'aprobado' } }, // versión histórica
    ],
    pendienteSkills: ['ux'], // siendo reprocesado
  });
  assert.equal(r.todosCompletos, false);
  assert.deepEqual(r.skillsFaltantes, ['ux']);
});

test('CA-4 bis: procesado/aprobado pero mismo skill VIVO en trabajando/ → NO promueve', () => {
  const r = evaluateParallelPhaseCompletion({
    skillsRequeridos: ['guru', 'po', 'ux'],
    listo: [
      { skill: 'guru', yaml: { resultado: 'aprobado' } },
      { skill: 'po', yaml: { resultado: 'aprobado' } },
    ],
    procesado: [
      { skill: 'ux', yaml: { resultado: 'aprobado' } },
    ],
    trabajandoSkills: ['ux'],
  });
  assert.equal(r.todosCompletos, false);
  assert.deepEqual(r.skillsFaltantes, ['ux']);
});

// ----- CA-5: regresión clásica: 3 en listo/ → promueve -----------------------

test('CA-5: 3 skills aprobados en listo/ (caso previo al fix) → promueve', () => {
  const r = evaluateParallelPhaseCompletion({
    skillsRequeridos: ['guru', 'po', 'ux'],
    listo: [
      { skill: 'guru', yaml: { resultado: 'aprobado' } },
      { skill: 'po', yaml: { resultado: 'aprobado' } },
      { skill: 'ux', yaml: { resultado: 'aprobado' } },
    ],
    procesado: [],
  });
  assert.equal(r.todosCompletos, true);
  assert.equal(r.origenPorSkill.guru, 'listo');
  assert.equal(r.origenPorSkill.po, 'listo');
  assert.equal(r.origenPorSkill.ux, 'listo');
});

// ----- CA-6: scope — fases single-skill quedan fuera (probado vía caller) ----
// NOTA: este caso lo controla pulpo.js (rama if fase===dev|build|entrega). El
// módulo solo se llama para fases paralelas, por lo que no hay assertion
// específica aquí. Documentado para trazabilidad de cobertura.

// ----- CA-9: tests adicionales obligados por PO -----------------------------

test('regresión negativa: 0 archivos en listo/ + 3 aprobados en procesado/ → la función reporta completo PERO el caller debe saltar por archivosListo.length===0', () => {
  // El módulo SÍ devuelve todosCompletos=true porque la verdad lógica es que
  // todos los skills tienen aprobado. El guard de "no re-promover" vive en
  // pulpo.js (línea ~2613: `if (archivosListo.length === 0) continue;`) y
  // ese guard se preserva intacto. Este test documenta el contrato: el
  // módulo es puro y no decide sobre "actividad fresca".
  const r = evaluateParallelPhaseCompletion({
    skillsRequeridos: ['guru', 'po', 'ux'],
    listo: [],
    procesado: [
      { skill: 'guru', yaml: { resultado: 'aprobado' } },
      { skill: 'po', yaml: { resultado: 'aprobado' } },
      { skill: 'ux', yaml: { resultado: 'aprobado' } },
    ],
  });
  assert.equal(r.todosCompletos, true);
  // Todos los orígenes vienen de procesado/ — caller debería verlo y NO
  // gatillar promoción (responsabilidad de pulpo.js, no del módulo).
  assert.equal(r.origenPorSkill.guru, 'procesado');
  assert.equal(r.origenPorSkill.po, 'procesado');
  assert.equal(r.origenPorSkill.ux, 'procesado');
});

test('skill repetido en listo/ y procesado/: listo/ pisa procesado/', () => {
  const r = evaluateParallelPhaseCompletion({
    skillsRequeridos: ['ux'],
    listo: [
      { skill: 'ux', yaml: { resultado: 'aprobado', notas: 'nueva' } },
    ],
    procesado: [
      { skill: 'ux', yaml: { resultado: 'rechazado', motivo: 'historico' } },
    ],
  });
  assert.equal(r.todosCompletos, true);
  assert.equal(r.origenPorSkill.ux, 'listo');
});

test('CA-7: YAML corrupto en procesado/ (representado como objeto vacío por readYaml defensivo) → skill faltante, NO rompe', () => {
  // readYaml() ya devuelve {} en error de parse. Verificamos que el módulo
  // trata {} como "no aprobado" en vez de tirar.
  const r = evaluateParallelPhaseCompletion({
    skillsRequeridos: ['guru', 'po', 'ux'],
    listo: [
      { skill: 'guru', yaml: { resultado: 'aprobado' } },
      { skill: 'po', yaml: { resultado: 'aprobado' } },
    ],
    procesado: [
      { skill: 'ux', yaml: {} }, // resultado de readYaml() ante YAML inválido
    ],
  });
  assert.equal(r.todosCompletos, false);
  assert.deepEqual(r.skillsFaltantes, ['ux']);
});

// ----- formatOrigenLog (CA-8: logging estructurado) -------------------------

test('formatOrigenLog: todo listo/ → string vacío (no aporta info)', () => {
  assert.equal(formatOrigenLog({ guru: 'listo', po: 'listo', ux: 'listo' }), '');
});

test('formatOrigenLog: mezcla listo/+procesado/ → indica origen por skill', () => {
  const s = formatOrigenLog({ guru: 'listo', po: 'listo', ux: 'procesado' });
  // El orden de claves es estable para Object.entries en V8 (orden de inserción).
  assert.match(s, /guru←listo\//);
  assert.match(s, /po←listo\//);
  assert.match(s, /ux←procesado\//);
});

test('formatOrigenLog: input vacío → string vacío', () => {
  assert.equal(formatOrigenLog({}), '');
  assert.equal(formatOrigenLog(null), '');
  assert.equal(formatOrigenLog(undefined), '');
});

// ----- Edge: skill desconocido en procesado/ no contamina ------------------

test('procesado/ con skill no requerido → se ignora, no aporta ni rompe', () => {
  const r = evaluateParallelPhaseCompletion({
    skillsRequeridos: ['guru', 'po'],
    listo: [
      { skill: 'guru', yaml: { resultado: 'aprobado' } },
      { skill: 'po', yaml: { resultado: 'aprobado' } },
    ],
    procesado: [
      { skill: 'skill-extranjero', yaml: { resultado: 'aprobado' } }, // ignorado
    ],
  });
  assert.equal(r.todosCompletos, true);
  assert.equal(r.origenPorSkill.guru, 'listo');
  assert.equal(r.origenPorSkill.po, 'listo');
  assert.equal(r.origenPorSkill['skill-extranjero'], undefined);
});

// ----- Edge: skillsRequeridos vacío → siempre completo (escenario impossible
// en producción pero asegura que el módulo no se cuelga en input degenerado).

test('skillsRequeridos vacío → todosCompletos=true trivialmente', () => {
  const r = evaluateParallelPhaseCompletion({
    skillsRequeridos: [],
    listo: [],
    procesado: [],
  });
  assert.equal(r.todosCompletos, true);
  assert.deepEqual(r.skillsCompletados, []);
  assert.deepEqual(r.skillsFaltantes, []);
});
