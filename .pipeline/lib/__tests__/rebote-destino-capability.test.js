// =============================================================================
// rebote-destino-capability.test.js — #6745 CA-3 + CA-5
//
// Cubre la REGLA DE CAPACIDAD DE FASE: un rebote clasificado `infra` que
// reencolaría en la MISMA fase se degrada a `codigo` y se rutea a `fase_rechazo`
// cuando la acción pedida no la puede ejecutar ningún skill de esa fase.
//
// Y el INVARIANTE de CA-5: si el rebote CAMBIA de fase para ir a `faseRechazo`,
// su `rebote_tipo` es `codigo` — o sea, consume budget del circuit breaker
// genérico. Sin eso, un rebote que en los hechos volvió a `dev` seguía contado
// como `infra` (sin cota) y el dashboard le mostraba "infra" al operador: el
// agujero exacto de #6179 / #3741.
//
// El módulo bajo test es PURO: cero I/O, cero mocks.
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { resolveReboteDestino } = require('../rebote-destino');

// Config real del pipeline `desarrollo` (config.yaml → `fase_rechazo: dev`;
// `skills_por_fase` del lado producto).
const FASE_RECHAZO = 'dev';
const SKILLS_POR_FASE = {
  validacion: ['po', 'ux', 'guru'],
  dev: ['backend-dev', 'android-dev', 'web-dev', 'pipeline-dev', 'dev'],
  build: ['build'],
  verificacion: ['tester', 'security', 'qa'],
  linteo: ['linter'],
  aprobacion: ['review', 'po', 'ux', 'architect'],
  entrega: ['delivery'],
};
const FASES = Object.keys(SKILLS_POR_FASE);

function base(over = {}) {
  return {
    fase: 'verificacion',
    faseRechazo: FASE_RECHAZO,
    skillsPorFase: SKILLS_POR_FASE,
    determinarDevSkill: () => 'pipeline-dev',
    rechazados: [{ file: { name: '6745.tester' } }],
    issue: 6745,
    config: {},
    skillFromFile: (n) => String(n).split('.')[1] || null,
    ...over,
  };
}

// =============================================================================
// CA-3 — degradado por capacidad de fase
// =============================================================================

test('CA-3 — infra en `verificacion` con acción sólo-`dev` ⇒ faseDestino `dev` + degradadoACodigo', () => {
  const r = resolveReboteDestino(base({ esReboteDeInfra: true, accionRequerida: 'codigo' }));
  assert.equal(r.faseDestino, 'dev');
  assert.equal(r.degradadoACodigo, true);
  assert.deepEqual(r.skillsDestino, ['pipeline-dev']);
});

test('CA-3 — infra GENUINO (sin acción de código) ⇒ misma fase, degradadoACodigo false', () => {
  const r = resolveReboteDestino(base({ esReboteDeInfra: true, accionRequerida: null }));
  assert.equal(r.faseDestino, 'verificacion');
  assert.equal(r.degradadoACodigo, false);
  assert.deepEqual(r.skillsDestino, ['tester', 'security', 'qa'],
    'fase paralela: se reencolan TODOS los skills (comportamiento de #2374 intacto)');
});

test('CA-3 — el degradado aplica en todas las fases que NO son la de rechazo', () => {
  for (const fase of FASES.filter(f => f !== FASE_RECHAZO)) {
    const r = resolveReboteDestino(base({ fase, esReboteDeInfra: true, accionRequerida: 'codigo' }));
    assert.equal(r.faseDestino, FASE_RECHAZO, `fase ${fase} debería degradar a ${FASE_RECHAZO}`);
    assert.equal(r.degradadoACodigo, true, `fase ${fase}`);
  }
});

test('CA-3 — infra EN la fase de rechazo con acción de código NO se degrada (no hay a dónde ir)', () => {
  // Reencolar `dev` en `dev` es exactamente lo que ya hace #2374 para un fallo
  // transitorio: el skill que vuelve a correr SÍ puede escribir código.
  const r = resolveReboteDestino(base({ fase: 'dev', esReboteDeInfra: true, accionRequerida: 'codigo' }));
  assert.equal(r.faseDestino, 'dev');
  assert.equal(r.degradadoACodigo, false);
});

test('CA-3 — sin `faseRechazo` configurada no se degrada (no se inventa destino)', () => {
  const r = resolveReboteDestino(base({ faseRechazo: null, esReboteDeInfra: true, accionRequerida: 'codigo' }));
  assert.equal(r.faseDestino, 'verificacion');
  assert.equal(r.degradadoACodigo, false);
});

test('CA-3 — rebote de código sigue yendo a `faseRechazo`, con degradadoACodigo false', () => {
  const r = resolveReboteDestino(base({ esReboteDeInfra: false, accionRequerida: 'codigo' }));
  assert.equal(r.faseDestino, 'dev');
  assert.equal(r.degradadoACodigo, false, 'no es un DEGRADADO: nunca fue infra');
});

test('CA-3 — `degradadoACodigo` está SIEMPRE presente y es booleano', () => {
  for (const esReboteDeInfra of [true, false]) {
    for (const accionRequerida of ['codigo', null, undefined]) {
      for (const fase of FASES) {
        const r = resolveReboteDestino(base({ fase, esReboteDeInfra, accionRequerida }));
        assert.equal(typeof r.degradadoACodigo, 'boolean',
          `fase=${fase} infra=${esReboteDeInfra} accion=${accionRequerida}`);
      }
    }
  }
});

// =============================================================================
// SEC-F — la señal derivada del motivo NUNCA puede nombrar una fase
// =============================================================================

test('SEC-F — `accionRequerida` hostil no puede elegir un destino fuera de {fase, faseRechazo}', () => {
  // `faseDestino` termina formando un path (`path.join(fasePath(...), 'pendiente')`
  // en pulpo.js). Cualquier valor que entre por el motivo tiene que quedar
  // acotado a los dos valores que ya venían en los parámetros.
  const hostiles = [
    '../../etc', '..\\..\\windows', 'entrega', 'aprobacion', 'fase-inexistente',
    '/absolute/path', 'codigo ', '', 0, 1, true, false, {}, [], null, undefined,
  ];
  for (const accionRequerida of hostiles) {
    for (const fase of FASES) {
      const r = resolveReboteDestino(base({ fase, esReboteDeInfra: true, accionRequerida }));
      assert.ok(
        r.faseDestino === fase || r.faseDestino === FASE_RECHAZO,
        `faseDestino=${JSON.stringify(r.faseDestino)} escapó del par {${fase}, ${FASE_RECHAZO}} `
        + `con accionRequerida=${JSON.stringify(accionRequerida)}`,
      );
    }
  }
});

test('SEC-F — el módulo sigue siendo puro: sin `fs`, sin `path`, sin `child_process`', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'rebote-destino.js'), 'utf8');
  for (const mod of ['fs', 'path', 'child_process', 'js-yaml']) {
    assert.ok(
      !new RegExp(`require\\(['"]${mod}['"]\\)`).test(src),
      `rebote-destino.js no puede requerir '${mod}': rompe la pureza de CA-3`,
    );
  }
  assert.ok(!/require\(/.test(src), 'el módulo no debe requerir NADA');
});

// =============================================================================
// CA-5 — INVARIANTE del tipo derivado del destino
// =============================================================================

test('CA-5 — si el rebote CAMBIA de fase hacia `faseRechazo`, el tipo es `codigo`', () => {
  // Réplica exacta del cálculo de `pulpo.js` tras el reordenamiento:
  //   const esInfraFinal = esReboteDeInfra && !degradadoACodigo;
  //   const reboteTipo   = esInfraFinal ? 'infra' : 'codigo';
  const matriz = [];
  for (const esReboteDeInfra of [true, false]) {
    for (const accionRequerida of ['codigo', null]) {
      for (const fase of FASES) {
        const { faseDestino, degradadoACodigo } = resolveReboteDestino(
          base({ fase, esReboteDeInfra, accionRequerida }),
        );
        const esInfraFinal = esReboteDeInfra && !degradadoACodigo;
        const reboteTipo = esInfraFinal ? 'infra' : 'codigo';
        matriz.push({ fase, faseDestino, esReboteDeInfra, accionRequerida, reboteTipo });

        if (faseDestino === FASE_RECHAZO && faseDestino !== fase) {
          assert.equal(reboteTipo, 'codigo',
            `INVARIANTE ROTA: fase=${fase} → ${faseDestino} con rebote_tipo=${reboteTipo}. `
            + 'Un rebote que vuelve a la fase de rechazo TIENE que consumir budget del breaker.');
        }
      }
    }
  }
  assert.ok(matriz.some(m => m.fase !== m.faseDestino && m.faseDestino === FASE_RECHAZO),
    'la matriz tiene que ejercitar de verdad el caso de cambio de fase');
});

test('CA-5 — el caso #6179: infra + acción de código en fase upstream ya NO reencola sin cota', () => {
  const { faseDestino, degradadoACodigo } = resolveReboteDestino(
    base({ fase: 'verificacion', esReboteDeInfra: true, accionRequerida: 'codigo' }),
  );
  const esInfraFinal = true && !degradadoACodigo;

  assert.equal(faseDestino, 'dev', 'va a donde alguien puede arreglarlo');
  assert.equal(esInfraFinal, false, 'y por lo tanto SÍ cuenta contra el circuit breaker');

  // Contadores, tal como los deriva pulpo.js.
  const reboteCount = 2;
  const reboteInfraCount = 7;
  assert.equal(esInfraFinal ? reboteCount : reboteCount + 1, 3,
    'rebote_numero tiene que incrementar');
  assert.equal(esInfraFinal ? reboteInfraCount + 1 : reboteInfraCount, 7,
    'rebote_numero_infra NO tiene que incrementar');
});

test('CA-3 — degradado sin `determinarDevSkill`: el destino cambia igual, skills vacío', () => {
  // El caller es responsable de loggear el caso; lo que NO puede pasar es que
  // el rebote se quede reencolando en una fase que no puede resolverlo.
  const r = resolveReboteDestino(base({
    esReboteDeInfra: true,
    accionRequerida: 'codigo',
    determinarDevSkill: undefined,
  }));
  assert.equal(r.faseDestino, 'dev');
  assert.equal(r.degradadoACodigo, true);
  assert.deepEqual(r.skillsDestino, []);
});

test('CA-3 — degradado con `determinarDevSkill` que no resuelve skill ⇒ lista vacía, destino igual', () => {
  const r = resolveReboteDestino(base({
    esReboteDeInfra: true,
    accionRequerida: 'codigo',
    determinarDevSkill: () => null,
  }));
  assert.equal(r.faseDestino, 'dev');
  assert.equal(r.degradadoACodigo, true);
  assert.deepEqual(r.skillsDestino, []);
});
