'use strict';

// =============================================================================
// kernel-iam-verify.test.js — La matriz empírica, verificada con fakes (#5211)
//
// El módulo bajo test corre contra AWS real. Estos tests NO tocan AWS: prueban
// las dos cosas que deciden si el reporte se puede creer.
//
//   1. **La clasificación.** `ConditionalCheckFailedException` significa
//      AUTORIZADO — la operación pasó IAM y la frenó la condición. Confundirlo
//      con un deny haría que un `Deny` regresado se reporte como ✅.
//   2. **La inocuidad.** Todo probe mutante lleva una condición imposible. Si
//      alguien agrega un probe sin ella, el verificador se vuelve capaz de
//      borrar la evidencia que audita. Hay un test que recorre la matriz y lo
//      impide.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CANARY_PK,
  CANARY_TABLE,
  IMPOSSIBLE_CONDITION,
  OUTCOME,
  CONTROL_PLANE_PROBES,
  classifyProbe,
  matchesExpectation,
  buildProbeMatrix,
  verifyKernelIam,
  renderMarkdown,
} = require('../kernel-iam-verify');

const CFG = {
  tableName: 'tabla-no-repudio',
  coordinationTableName: 'tabla-coordinacion',
  region: 'region-test',
  // #5211 — Nombres de infra inyectados: el módulo NO puede completarlos con un
  // literal (ver el test de fail-closed más abajo).
  cmkAlias: 'alias-cmk-test',
  runtimePrincipal: 'principal-runtime-test',
};

// Mensajes reales del AWS CLI (capturados el 2026-08-06, ya redactados).
const STDERR_EXPLICIT_DENY = 'An error occurred (AccessDeniedException) when calling the '
  + 'UpdateItem operation: User: arn:aws:iam::<ACCT>:user/intrale-kernel-runtime is not '
  + 'authorized to perform: dynamodb:UpdateItem on resource: '
  + 'arn:aws:dynamodb:us-east-2:<ACCT>:table/intrale-kernel-state with an explicit deny in '
  + 'an identity-based policy: arn:aws:iam::<ACCT>:policy/IntraleKernelStore';

const STDERR_IMPLICIT_DENY = 'An error occurred (AccessDeniedException) when calling the '
  + 'DescribeKey operation: User: arn:aws:iam::<ACCT>:user/intrale-kernel-runtime is not '
  + 'authorized to perform: kms:DescribeKey on resource: arn:aws:kms:us-east-2:<ACCT>:key/abc '
  + 'because no identity-based policy allows the kms:DescribeKey action';

const STDERR_CONDITION_FAILED = 'An error occurred (ConditionalCheckFailedException) when '
  + 'calling the PutItem operation: The conditional request failed';

// ---------------------------------------------------------------------------
// Clasificación
// ---------------------------------------------------------------------------

test('#5211 · un exit 0 limpio se clasifica como allowed', () => {
  const r = classifyProbe({ code: 0, stdout: '{}', stderr: '' });
  assert.equal(r.outcome, OUTCOME.ALLOWED);
});

test('#5211 · ConditionalCheckFailed se clasifica como AUTORIZADO, no como deny', () => {
  // El corazón del diseño: la condición imposible frena la escritura DESPUÉS de
  // que IAM concedió. Tratarlo como deny reportaría ✅ sobre un Deny caído.
  const r = classifyProbe({ code: 254, stdout: '', stderr: STDERR_CONDITION_FAILED });
  assert.equal(r.outcome, OUTCOME.CONDITION_FAILED);
  assert.equal(matchesExpectation('allow', r.outcome), true,
    'satisface un probe que espera Allow');
  assert.equal(matchesExpectation('deny', r.outcome), false,
    'NO satisface un probe que espera Deny: la operación estaba autorizada');
});

test('#5211 · distingue explicitDeny de implicitDeny (cambia quién destraba y cómo)', () => {
  const explicito = classifyProbe({ code: 254, stdout: '', stderr: STDERR_EXPLICIT_DENY });
  assert.equal(explicito.outcome, OUTCOME.EXPLICIT_DENY);
  assert.equal(explicito.action, 'dynamodb:UpdateItem');
  assert.match(explicito.policy, /policy\/IntraleKernelStore/);

  const implicito = classifyProbe({ code: 254, stdout: '', stderr: STDERR_IMPLICIT_DENY });
  assert.equal(implicito.outcome, OUTCOME.IMPLICIT_DENY);
  assert.equal(implicito.action, 'kms:DescribeKey');

  // Los dos satisfacen "está denegado": la distinción es para el remedio.
  for (const o of [explicito.outcome, implicito.outcome]) {
    assert.equal(matchesExpectation('deny', o), true);
  }
});

test('#5211 · la evidencia clasificada sale redactada (sin account-id de 12 dígitos)', () => {
  const conAccount = STDERR_EXPLICIT_DENY.replace(/<ACCT>/g, '123456789012');
  const r = classifyProbe({ code: 254, stdout: '', stderr: conAccount });
  assert.equal(/\d{12}/.test(r.evidencia || r.message || ''), false,
    'el account-id no puede viajar a la evidencia persistida');
  assert.match(r.message, /policy\/IntraleKernelStore/,
    'y aun así se preserva el nombre de la policy: sin eso la evidencia no prueba nada');
});

// ---------------------------------------------------------------------------
// Inocuidad de la matriz — el invariante que evita que el auditor sea el vector
// ---------------------------------------------------------------------------

test('#5211 · TODO probe mutante viaja con la condición imposible', () => {
  const matrix = buildProbeMatrix(CFG);
  // Verbos que escriben. `batch-write-item` y `execute-statement` no admiten
  // `--condition-expression` como flag: se excluyen acá y los cubre el test
  // siguiente, que verifica que operen sólo sobre la clave canario.
  const MUTANTES_CON_CONDICION = ['put-item', 'update-item', 'delete-item'];

  const evaluados = [];
  for (const p of matrix) {
    const verbo = p.args[1];
    if (!MUTANTES_CON_CONDICION.includes(verbo)) continue;
    evaluados.push(p.id);
    assert.ok(p.args.includes('--condition-expression'),
      `el probe "${p.id}" muta (${verbo}) y no lleva --condition-expression`);
    const cond = p.args[p.args.indexOf('--condition-expression') + 1];
    assert.equal(cond, IMPOSSIBLE_CONDITION,
      `el probe "${p.id}" debe usar la condición imposible, no "${cond}"`);
  }
  assert.ok(evaluados.length >= 4, `se esperaban varios probes mutantes, hubo ${evaluados.length}`);
});

test('#5211 · ningún probe toca una clave que no sea el canario', () => {
  // Si un probe apuntara a una PK real y el Deny estuviera caído, el
  // verificador borraría evidencia de producción.
  const matrix = buildProbeMatrix(CFG);
  for (const p of matrix) {
    const payload = p.args.join(' ');
    if (!/PK/.test(payload)) continue;
    const claves = payload.match(/"PK"\s*:\s*\{\s*"S"\s*:\s*"([^"]+)"\}/g) || [];
    for (const c of claves) {
      assert.match(c, new RegExp(CANARY_PK),
        `el probe "${p.id}" referencia una PK que no es el canario: ${c}`);
    }
    // PartiQL usa comparación textual, no JSON.
    const partiql = payload.match(/PK='([^']+)'/g) || [];
    for (const c of partiql) {
      assert.match(c, new RegExp(CANARY_PK), `el probe "${p.id}" usa PK real en PartiQL: ${c}`);
    }
  }
});

test('#5211 · los nombres de tabla salen de config, no hardcodeados', () => {
  const matrix = buildProbeMatrix(CFG);
  const payload = JSON.stringify(matrix);
  assert.match(payload, /tabla-no-repudio/, 'usa el tableName inyectado');
  assert.match(payload, /tabla-coordinacion/, 'usa el coordinationTableName inyectado');
  assert.equal(/intrale-kernel-state|intrale-kernel-coordination/.test(payload), false,
    'no hay nombres de tabla reales hardcodeados (A05)');
});

test('#5211 · el alias de la CMK y el principal runtime TAMBIÉN salen de config', () => {
  // Regresión: `cfg.cmkAlias || 'intrale-kernel-store'` y
  // `cfg.runtimePrincipal || 'intrale-kernel-runtime'` caían siempre al literal,
  // porque `readKernelTablesConfig` sólo devuelve
  // {tableName, coordinationTableName, region, durable} — esas claves nunca
  // llegaban. Los dos probes de CA-3 apuntaban a un recurso hardcodeado.
  const matrix = buildProbeMatrix(CFG);
  const payload = JSON.stringify(matrix);

  const kms = matrix.find((p) => p.id === 'kms-describe-key');
  assert.deepEqual(kms.args, ['kms', 'describe-key', '--key-id', 'alias/alias-cmk-test']);

  const iam = matrix.find((p) => p.id === 'iam-list-attached-user-policies');
  assert.deepEqual(iam.args,
    ['iam', 'list-attached-user-policies', '--user-name', 'principal-runtime-test']);

  assert.equal(/intrale-kernel-store|intrale-kernel-runtime/.test(payload), false,
    'no queda ningún nombre de infra real hardcodeado en el módulo (A05)');
});

test('#5211 · sin los nombres de infra en config, la matriz NO se arma (fail-closed)', () => {
  // Un default silencioso apuntaría el probe a un recurso que puede no existir,
  // y ese AccessDenied se lee idéntico a un Deny aplicado: la matriz reportaría
  // ✅ sobre un control que jamás se probó. Preferimos que reviente.
  for (const clave of ['cmkAlias', 'runtimePrincipal', 'tableName', 'coordinationTableName']) {
    const incompleta = { ...CFG };
    delete incompleta[clave];
    assert.throws(() => buildProbeMatrix(incompleta), new RegExp(clave),
      `falta "${clave}" y buildProbeMatrix igual armó la matriz`);
  }
});

test('#5211 · readKernelIamConfig exige cmkAlias y runtimePrincipal', () => {
  const { readKernelIamConfig } = require('../kernel-iam-verify');
  // Config con las tablas pero sin los nombres de infra de la matriz IAM.
  assert.throws(
    () => readKernelIamConfig({
      kernelConfig: {
        tableName: 'tabla-no-repudio',
        coordinationTableName: 'tabla-coordinacion',
        region: 'region-test',
      },
    }),
    /kernel\.cmkAlias.*kernel\.runtimePrincipal|kernel\.cmkAlias/s,
    'debe fallar nombrando las claves faltantes, no completarlas',
  );

  // Y con todo presente, las devuelve junto a lo que ya daba el módulo hermano.
  const cfg = readKernelIamConfig({ kernelConfig: CFG });
  assert.equal(cfg.cmkAlias, 'alias-cmk-test');
  assert.equal(cfg.runtimePrincipal, 'principal-runtime-test');
  assert.equal(cfg.tableName, 'tabla-no-repudio');
});

test('#5211 CA-2 · la matriz cubre las dos tablas y ambos sentidos (Allow y Deny)', () => {
  const matrix = buildProbeMatrix(CFG);
  const allows = matrix.filter((p) => p.expect === 'allow');
  const denies = matrix.filter((p) => p.expect === 'deny');
  assert.ok(allows.length >= 3, 'hay probes que prueban el Allow de coordinación');
  assert.ok(denies.length >= 5, 'hay probes por cada camino de mutación denegado');

  // Los 5 caminos de escritura que el Deny debe cubrir sobre no-repudio.
  const ids = new Set(matrix.map((p) => p.id));
  for (const id of ['nonrepudio-update-item', 'nonrepudio-delete-item',
    'nonrepudio-batch-write-item', 'nonrepudio-transact-write-items',
    'nonrepudio-partiql-delete']) {
    assert.ok(ids.has(id), `falta el probe ${id}`);
  }
  // Y la coordinación tiene que probar que SÍ puede borrar (o el claim se traba).
  assert.ok(ids.has('coord-delete-item'), 'falta probar el release de claim');
});

// ---------------------------------------------------------------------------
// Reporte
// ---------------------------------------------------------------------------

test('#5211 · un probe que esperaba Deny y salió autorizado marca el reporte como NO ok', () => {
  // El escenario que justifica el módulo entero: la policy del repo está bien,
  // pero la aplicada en AWS regresó.
  const runner = {
    profile: 'fake',
    run(args) {
      const esUpdateNoRepudio = args[1] === 'update-item';
      return Promise.resolve(esUpdateNoRepudio
        // Autorizado: la condición imposible fue lo único que lo frenó.
        ? { code: 254, stdout: '', stderr: STDERR_CONDITION_FAILED }
        : { code: 0, stdout: '{}', stderr: '' });
    },
  };

  return verifyKernelIam({ kernelConfig: CFG, runner }).then((report) => {
    assert.equal(report.ok, false, 'el reporte NO puede dar ok');
    const fallido = report.probes.find((p) => p.id === 'nonrepudio-update-item');
    assert.equal(fallido.ok, false);
    assert.equal(fallido.outcome, OUTCOME.CONDITION_FAILED,
      'quedó registrado que la operación estaba autorizada');
  });
});

test('#5211 · con todos los probes en su expectativa, el reporte da ok', () => {
  const runner = {
    profile: 'fake',
    run(args) {
      const matrix = buildProbeMatrix(CFG);
      const probe = matrix.find((p) => p.args.join(' ') === args.join(' '));
      // `deny` y `denyExplicito` se satisfacen ambos con un explicitDeny; sólo
      // `allow` espera ejecución limpia.
      return Promise.resolve(probe.expect === 'allow'
        ? { code: 0, stdout: '{}', stderr: '' }
        : { code: 254, stdout: '', stderr: STDERR_EXPLICIT_DENY });
    },
  };

  return verifyKernelIam({ kernelConfig: CFG, runner }).then((report) => {
    assert.equal(report.ok, true);
    assert.equal(report.resumen.fallidos, 0);
    assert.equal(report.resumen.ok, report.resumen.ejecutados,
      'los probes ejecutados están todos en su expectativa');
    // Pero `ok` NO implica `cerrado`: sin poder leer la policy aplicada, el
    // drift queda sin verificar y los controles no ejecutables salen
    // `desconocido`. Distinguirlos es el punto de todo el rebote.
    assert.equal(report.cerrado, false,
      'sin comparar contra la policy aplicada no se puede declarar CA-3 cerrado');
    assert.equal(report.drift.disponible, false);
  });
});

test('#5211 · un error de spawn se registra como fallo, no tumba la corrida', () => {
  // Fail-closed: si un probe no se pudo ejecutar, NO se puede reportar ✅.
  const runner = {
    profile: 'fake',
    run() { return Promise.reject(new Error('aws no está en el PATH')); },
  };
  return verifyKernelIam({ kernelConfig: CFG, runner }).then((report) => {
    assert.equal(report.ok, false);
    for (const p of report.probes) {
      assert.equal(p.ok, false, `${p.id} no puede darse por bueno sin ejecutarse`);
    }
  });
});

test('#5211 CA-3 · los controles no ejecutables se declaran, nunca se ejecutan', () => {
  // No pueden desaparecer del reporte: omitirlos se leería como "cubierto".
  assert.ok(CONTROL_PLANE_PROBES.length >= 5);
  for (const p of CONTROL_PLANE_PROBES) {
    assert.equal(p.runnable, false, `${p.id} no puede ser ejecutable`);
    assert.ok(p.motivoNoEjecutable,
      `${p.id} debe explicar por qué no se ejecuta: "no ejecutable" sin motivo se vuelve un cajón de sastre`);
  }
  // Y no pueden estar en la matriz ejecutable.
  const ejecutables = new Set(buildProbeMatrix(CFG).map((p) => p.id));
  for (const p of CONTROL_PLANE_PROBES) {
    assert.equal(ejecutables.has(p.id), false, `${p.id} está en la matriz ejecutable`);
  }
});

test('#5211 CA-3 · los probes ejecutables de control plane apuntan a objetivos inocuos', () => {
  // La contracara: si un probe de control plane pasó a ser ejecutable, su
  // objetivo tiene que ser uno donde el éxito NO haga daño. Un `delete-table`
  // ejecutable apuntado a la tabla real convertiría al verificador en el
  // incidente que busca detectar.
  const DESTRUCTIVAS = ['delete-table', 'schedule-key-deletion', 'disable-key', 'put-key-policy'];
  for (const p of buildProbeMatrix(CFG)) {
    const verbo = p.args[1];
    if (!DESTRUCTIVAS.includes(verbo)) continue;
    assert.equal(p.alcance, 'out-scope',
      `"${p.id}" ejecuta "${verbo}" con alcance "${p.alcance}": sólo se admite contra un objetivo inexistente`);
    assert.ok(p.args.includes(CANARY_TABLE),
      `"${p.id}" ejecuta "${verbo}" sin apuntar al objetivo canario`);
  }
});

test('#5211 CA-3 · hay un probe in-scope por cada control que protege la evidencia', () => {
  // El agujero que destapó el rebote: la policy aplicada deniega por
  // `NotResource`, así que un probe contra una tabla ajena da `explicitDeny`
  // mientras el MISMO control sobre la tabla de evidencia sigue en
  // `implicitDeny`. Una matriz que sólo corra probes out-scope reporta
  // verificado un control que sobre el recurso real no existe.
  const matriz = buildProbeMatrix(CFG);
  const porAlcance = (a) => matriz.filter((p) => p.alcance === a).map((p) => p.id);

  assert.ok(porAlcance('in-scope').length >= 3,
    'sin probes in-scope la matriz no dice nada sobre la tabla de evidencia');

  // Y específicamente el control más importante de CA-3: apagar PITR sobre la
  // tabla de no-repudio deja la evidencia destruible por otra vía.
  const pitr = matriz.filter((p) => p.args.includes('update-continuous-backups'));
  assert.ok(pitr.some((p) => p.alcance === 'in-scope' && p.args.includes(CFG.tableName)),
    'falta el probe de PITR sobre la tabla de evidencia');
  assert.ok(pitr.some((p) => p.alcance === 'out-scope'),
    'falta el contraste out-scope: sin él no se ve que el Deny aplicado discrimina por recurso');
  // El probe in-scope NUNCA puede apagar PITR: viaja con Enabled=true.
  for (const p of pitr) {
    assert.ok(p.args.some((a) => /PointInTimeRecoveryEnabled=true/.test(String(a))),
      `"${p.id}" podría APAGAR PITR: el probe sería el incidente`);
  }
});

test('#5211 · todo control de CA-3 exige explicitDeny, salvo la excepción documentada', () => {
  // `deny` a secas se satisface con `implicitDeny`, que es "hoy no le alcanza el
  // permiso" y no "no puede". Para CA-3 eso no alcanza. La única excepción es
  // `kms-describe-key`, que no es una acción de administración y cuya garantía
  // vive en la key policy (`ViaService`), no en la identity policy.
  const EXCEPCIONES = new Set(['kms-describe-key']);
  for (const p of buildProbeMatrix(CFG)) {
    if (p.ca !== 'CA-3' || EXCEPCIONES.has(p.id)) continue;
    assert.equal(p.expect, 'denyExplicito',
      `"${p.id}" espera "${p.expect}": un implicitDeny se desharía con un Allow de más y saldría ✅`);
  }
});

test('#5211 · el render markdown expone el drift y separa pendientes de fallos', () => {
  const runner = { profile: 'fake', run: () => Promise.resolve({ code: 0, stdout: '{}', stderr: '' }) };
  return verifyKernelIam({ kernelConfig: CFG, runner }).then((report) => {
    const md = renderMarkdown(report);
    assert.match(md, /Controles probados contra AWS/);
    assert.match(md, /Artefacto versionado vs\. policy aplicada/,
      'el drift tiene que estar en el documento que el operador firma');
    assert.match(md, /NO VERIFICADO/,
      'sin policy legible, el drift se declara no verificado en vez de omitirse');
    for (const p of CONTROL_PLANE_PROBES) {
      assert.ok(md.includes(p.id), `el render omite el control no ejecutable ${p.id}`);
    }
  });
});
