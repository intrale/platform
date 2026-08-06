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
      return Promise.resolve(probe.expect === 'deny'
        ? { code: 254, stdout: '', stderr: STDERR_EXPLICIT_DENY }
        : { code: 0, stdout: '{}', stderr: '' });
    },
  };

  return verifyKernelIam({ kernelConfig: CFG, runner }).then((report) => {
    assert.equal(report.ok, true);
    assert.equal(report.resumen.fallidos, 0);
    assert.equal(report.resumen.ok, report.resumen.total);
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

test('#5211 CA-3 · los probes de control plane se declaran, nunca se ejecutan', () => {
  // No pueden desaparecer del reporte: omitirlos se leería como "cubierto".
  assert.ok(CONTROL_PLANE_PROBES.length >= 5);
  for (const p of CONTROL_PLANE_PROBES) {
    assert.equal(p.runnable, false, `${p.id} no puede ser ejecutable`);
    assert.ok(p.evidenciaManual, `${p.id} debe traer evidencia manual observada`);
    assert.ok(p.fecha, `${p.id} debe traer fecha: una evidencia sin fecha no se puede auditar`);
  }
  // Y no pueden estar en la matriz ejecutable.
  const ejecutables = new Set(buildProbeMatrix(CFG).map((p) => p.id));
  for (const p of CONTROL_PLANE_PROBES) {
    assert.equal(ejecutables.has(p.id), false, `${p.id} está en la matriz ejecutable`);
  }
});

test('#5211 CA-3 · ningún probe manual afirma explicitDeny de un statement que NO está aplicado', () => {
  // El defecto que trajo el rebote: la evidencia declaraba
  // `explicitDeny · policy/IntraleKernelStore` para CreateTable y AttachUserPolicy,
  // pero los statements que producirían ese resultado son adiciones de #5211 que
  // todavía no se aplicaron en AWS. Una evidencia no puede afirmar el efecto de
  // una policy que no está puesta: es el mismo patrón (decir más de lo que el
  // estado respalda) que el issue vino a matar.
  //
  // El invariante: si la fila declara `explicitoTrasAplicar`, ese statement está
  // PENDIENTE ⇒ la evidencia observada tiene que ser implicitDeny.
  for (const p of CONTROL_PLANE_PROBES) {
    if (!p.explicitoTrasAplicar) continue;
    assert.match(p.evidenciaManual, /^implicitDeny/,
      `"${p.id}" declara que ${p.explicitoTrasAplicar} está pendiente de aplicar, `
      + `pero su evidencia dice "${p.evidenciaManual}"`);
    assert.equal(/explicitDeny|IntraleKernelStore/.test(p.evidenciaManual), false,
      `"${p.id}" no puede atribuirle el deny a una policy que todavía no está aplicada`);
  }
});

test('#5211 CA-3 · la evidencia manual es coherente con el artefacto versionado', () => {
  // Cada Sid citado en `explicitoTrasAplicar` tiene que existir de verdad en el
  // JSON: si alguien renombra un statement, la evidencia queda apuntando a la
  // nada y nadie se entera.
  const fs = require('node:fs');
  const path = require('node:path');
  const policy = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'docs', 'pipeline', 'kernel-iam-policy.json'), 'utf8',
  ));
  const sids = new Set(policy.Statement.map((s) => s.Sid));
  for (const p of CONTROL_PLANE_PROBES) {
    if (!p.explicitoTrasAplicar) continue;
    assert.ok(sids.has(p.explicitoTrasAplicar),
      `"${p.id}" cita el Sid "${p.explicitoTrasAplicar}", que no existe en kernel-iam-policy.json`);
  }
});

test('#5211 · el render markdown incluye los probes manuales junto a los ejecutados', () => {
  const runner = { profile: 'fake', run: () => Promise.resolve({ code: 0, stdout: '{}', stderr: '' }) };
  return verifyKernelIam({ kernelConfig: CFG, runner }).then((report) => {
    const md = renderMarkdown(report);
    assert.match(md, /Probes ejecutados/);
    assert.match(md, /control plane/i);
    for (const p of CONTROL_PLANE_PROBES) {
      assert.ok(md.includes(p.id), `el render omite el probe manual ${p.id}`);
    }
  });
});
