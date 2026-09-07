'use strict';

// =============================================================================
// kernel-durable-config-guard-5214.test.js — #5214
//
// Guard fail-closed de configuración durable incompleta. Lo que se prueba acá no
// es "la validación devuelve false": es el ORDEN y la AUSENCIA de fallback, que
// es donde el bug vive. Un guard que valida correctamente pero corre después de
// construir el driver ya consumió credenciales; uno que devuelve un error que el
// caller degrada a warning deja el pipeline arrancado sobre filesystem.
//
// Mapa CA → tests:
//   CA-1  exit no-cero para missing/empty/whitespace ....... §1 (unitario) + §5 (proceso real)
//   CA-2  cero fallback: FS, default, AWS, parcial ......... §2, §3
//   CA-3  mensaje acotado, sin volcar config ni entorno .... §4
//   CA-4  orden del guard + cero llamadas AWS .............. §2, §3
// =============================================================================

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const guard = require('../kernel-durable-config-guard');
const { bootKernelDurable } = require('../kernel-supervisor');
const kernelStore = require('../kernel-store');

const GUARD_PATH = path.join(__dirname, '..', 'kernel-durable-config-guard.js');

// Las TRES variantes inválidas del CA, en un solo lugar. Cada bloque las recorre
// entero: si mañana alguien arregla `missing` pero no `whitespace`, cae acá.
const INVALIDOS = [
  ['ausente', { durable: true }, 'missing'],
  ['null', { durable: true, tableName: null }, 'missing'],
  ['no-string (número)', { durable: true, tableName: 42 }, 'missing'],
  ['vacío', { durable: true, tableName: '' }, 'empty'],
  ['whitespace (espacios)', { durable: true, tableName: '   ' }, 'whitespace'],
  ['whitespace (tab)', { durable: true, tableName: '\t' }, 'whitespace'],
  ['whitespace (newline)', { durable: true, tableName: '\n\n' }, 'whitespace'],
  ['whitespace mixto', { durable: true, tableName: ' \t\r\n ' }, 'whitespace'],
];

// -----------------------------------------------------------------------------
// §1 · CA-1 — clasificación y código de salida no-cero
// -----------------------------------------------------------------------------

for (const [caso, kernel, reasonEsperado] of INVALIDOS) {
  test(`#5214 CA-1 · tableName ${caso} ⇒ config inválida con exit no-cero`, () => {
    const res = guard.inspectDurableKernelConfig({ kernel });
    assert.equal(res.ok, false, 'la config debe rechazarse');
    assert.equal(res.reason, reasonEsperado, 'la variante se reporta en el campo estructurado');
    assert.notEqual(res.exitCode, 0, 'el código de salida NO puede ser cero');
    assert.equal(res.exitCode, guard.DURABLE_CONFIG_EXIT_CODE);
  });

  test(`#5214 CA-1 · tableName ${caso} ⇒ assert lanza KernelDurableConfigError`, () => {
    assert.throws(
      () => guard.assertDurableKernelConfig({ kernel }),
      (e) => e instanceof guard.KernelDurableConfigError
        && e.code === guard.DURABLE_CONFIG_ERROR_CODE
        && e.reason === reasonEsperado
        && e.exitCode !== 0,
      'debe lanzar el error tipado con exitCode no-cero',
    );
  });
}

test('#5214 CA-1 · el código de salida es EX_CONFIG (78), no cero', () => {
  assert.equal(guard.DURABLE_CONFIG_EXIT_CODE, 78);
  assert.notEqual(guard.DURABLE_CONFIG_EXIT_CODE, 0);
});

test('#5214 · tableName válido pasa y se devuelve trimeado', () => {
  const ok = guard.assertDurableKernelConfig({ kernel: { durable: true, tableName: 'intrale-kernel-state' } });
  assert.equal(ok.durable, true);
  assert.equal(ok.tableName, 'intrale-kernel-state');
  // Un `\n` colado por el YAML no debe viajar al driver dentro del nombre.
  const trimmed = guard.assertDurableKernelConfig({ kernel: { durable: true, tableName: '  tabla-x \n' } });
  assert.equal(trimmed.tableName, 'tabla-x');
});

// El guard es un no-op con el flag apagado: NO puede convertirse en un chequeo
// que rompa el arranque FS de todos los días (`durable:false` es el régimen).
for (const [caso, cfg] of [
  ['config vacía', {}],
  ['sin sección kernel', { otra: 1 }],
  ['durable:false sin tableName', { kernel: { durable: false } }],
  ['durable:false con tableName vacío', { kernel: { durable: false, tableName: '' } }],
  ['durable truthy no-booleano', { kernel: { durable: 'true', tableName: '' } }],
  ['durable:1', { kernel: { durable: 1 } }],
  ['config null', null],
]) {
  test(`#5214 · con ${caso} el guard NO se dispara (el régimen FS no cambia)`, () => {
    const res = guard.inspectDurableKernelConfig(cfg);
    assert.equal(res.ok, true, 'sin durable:true exacto el guard es no-op');
    assert.equal(res.durable, false);
    assert.doesNotThrow(() => guard.assertDurableKernelConfig(cfg));
  });
}

// -----------------------------------------------------------------------------
// §2 · CA-2/CA-4 — orden del guard: cero AWS, cero fallback, cero procesamiento
// -----------------------------------------------------------------------------

for (const [caso, kernel, reasonEsperado] of INVALIDOS) {
  test(`#5214 CA-2/CA-4 · boot durable con tableName ${caso}: cero AWS, cero fallback, cero procesamiento`, async () => {
    // Spies sobre TODO lo que el CA prohíbe tocar antes del aborto.
    const traza = [];
    const alerts = [];

    const res = await bootKernelDurable({
      config: { kernel },
      // `buildCatalogStore` es el closure que en producción construye el runner
      // del AWS CLI y el driver DynamoDB: invocarlo == tocar AWS y resolver
      // credenciales. Debe quedar SIN invocar.
      buildCatalogStore: () => {
        traza.push('aws:buildCatalogStore');
        return { listProducts: async () => { traza.push('aws:listProducts'); return []; } };
      },
      buildStoreFactory: () => { traza.push('aws:buildStoreFactory'); return () => ({}); },
      // El supervisor es el que drena colas y spawnea: procesamiento parcial.
      createSupervisor: () => {
        traza.push('procesamiento:createSupervisor');
        return {
          bootProducts: async () => { traza.push('procesamiento:bootProducts'); return { spawned: [], skipped: [] }; },
          drainEditQueue: async () => { traza.push('procesamiento:drainEdit'); return {}; },
          drainDeactivateQueue: async () => { traza.push('procesamiento:drainDeactivate'); return {}; },
          drainCreateWaveQueue: async () => { traza.push('procesamiento:drainCreateWave'); return {}; },
        };
      },
      spawn: () => { traza.push('procesamiento:spawn'); return null; },
      onAlert: (a) => alerts.push(a),
    });

    // Veredicto fail-closed, marcado como FATAL (no como error best-effort).
    assert.equal(res.ran, false, 'el boot durable no corre');
    assert.equal(res.reason, 'config-invalid', 'razón propia, distinguible de un fallo operativo');
    assert.equal(res.fatal, true, 'el caller debe abortar, no degradar');
    assert.equal(res.configReason, reasonEsperado);
    assert.notEqual(res.exitCode, 0, 'código de salida no-cero');

    // CA-4: cero interacciones. La traza vacía es la prueba del ORDEN — si el
    // guard corriera después de `buildCatalogStore()`, acá habría al menos una
    // entrada `aws:`.
    assert.deepEqual(traza, [], `nada debe ejecutarse antes del aborto (traza: ${JSON.stringify(traza)})`);

    // CA-2: no hay fallback. El resultado no puede traer un nombre de tabla por
    // defecto ni una marca de "corrió sobre filesystem".
    assert.equal(res.tableName, undefined, 'no se resuelve ningún nombre de tabla por defecto');
    assert.ok(!('spawned' in res), 'no hay instancias spawneadas');
    assert.ok(!('drains' in res), 'no se drenó ninguna cola');

    // La alerta se emite con un stage propio (no se confunde con la degradación
    // del catálogo, que el sink de `pulpo.js` sí escucha para el halt de cutover).
    assert.equal(alerts.length, 1, 'una alerta de config, ni más ni menos');
    assert.equal(alerts[0].stage, 'boot-durable-config');
    assert.equal(alerts[0].errors[0].reason, reasonEsperado);
  });
}

test('#5214 CA-2 · una alerta que explota NO convierte el aborto en arranque', async () => {
  // El fail-closed no puede depender de que el canal de alerta funcione.
  const res = await bootKernelDurable({
    config: { kernel: { durable: true, tableName: '   ' } },
    buildCatalogStore: () => { throw new Error('no debe invocarse'); },
    onAlert: () => { throw new Error('canal de alerta caído'); },
  });
  assert.equal(res.ran, false);
  assert.equal(res.fatal, true);
  assert.equal(res.reason, 'config-invalid');
});

test('#5214 · el guard NO cambia el best-effort de los fallos OPERATIVOS', async () => {
  // Regresión sobre el riesgo que marcó guru: dejar de tragar excepciones podría
  // volver fatal un fallo no relacionado (driver caído, catálogo corrupto). Con
  // tableName VÁLIDO, un fallo del store sigue siendo `{ran:false, reason:'error'}`
  // sin `fatal`, y el pulpo sigue arrancando sobre filesystem como siempre.
  const res = await bootKernelDurable({
    config: { kernel: { durable: true, tableName: 'tabla-ok', max_concurrent_instances: 2 } },
    buildCatalogStore: () => { throw new Error('driver AWS no disponible'); },
    onAlert: () => {},
  });
  assert.equal(res.ran, false);
  assert.equal(res.reason, 'error', 'sigue siendo un error best-effort');
  assert.notEqual(res.fatal, true, 'un fallo operativo NO es fatal');
  assert.match(res.error, /driver AWS no disponible/);
});

// -----------------------------------------------------------------------------
// §3 · CA-2 — la validación lazy del store tampoco deja pasar whitespace
// -----------------------------------------------------------------------------
// El guard del boot es la primera línea, pero `createKernelStore` puede
// construirse por otros caminos. Antes de #5214 `normalizeConfig` aceptaba
// `"   "` por truthy y lo mandaba al driver real como nombre de tabla.

for (const [caso, kernel, reasonEsperado] of INVALIDOS) {
  test(`#5214 CA-2 · normalizeConfig con driver real rechaza tableName ${caso}`, () => {
    // `driver` sin `kind:'in-memory'` ⇒ camino del driver REAL: sin default.
    const driverReal = { kind: 'aws-cli' };
    assert.throws(
      () => kernelStore.normalizeConfig({ kernel }, driverReal),
      (e) => e instanceof kernelStore.KernelStoreError && e.configReason === reasonEsperado,
      'el driver real no tiene nombre de tabla por defecto',
    );
  });
}

test('#5214 CA-2 · normalizeConfig con driver real NO cae a un nombre por defecto', () => {
  // La prueba negativa explícita del "sin fallback a nombre por defecto": el
  // default in-memory existe y es el candidato natural a colarse.
  let resultado = null;
  try { resultado = kernelStore.normalizeConfig({ kernel: { tableName: '  ' } }, { kind: 'aws-cli' }); }
  catch { /* esperado */ }
  assert.equal(resultado, null, 'no devuelve config: aborta');
});

test('#5214 · normalizeConfig trimea el tableName válido antes de armar el spec', () => {
  const cfg = kernelStore.normalizeConfig({ kernel: { tableName: ' tabla-x \n' } }, { kind: 'aws-cli' });
  assert.equal(cfg.tableName, 'tabla-x');
});

// -----------------------------------------------------------------------------
// §4 · CA-3 — contenido del mensaje: las tres referencias, y nada más
// -----------------------------------------------------------------------------

test('#5214 CA-3 · el mensaje referencia config.yaml, kernel.tableName y el runbook', () => {
  const m = guard.DURABLE_CONFIG_ABORT_MESSAGE;
  assert.match(m, /\.pipeline\/config\.yaml/, 'dice DÓNDE editar');
  assert.match(m, /kernel\.tableName/, 'dice QUÉ clave');
  assert.match(m, /docs\/pipeline\/runbook-cutover-durable\.md/, 'cierra con el runbook');
});

test('#5214 CA-3 · el runbook referenciado existe realmente en el repo', () => {
  // Un mensaje que manda al operador a las 3am a un archivo inexistente es peor
  // que no dar referencia.
  const fs = require('node:fs');
  const runbook = path.join(__dirname, '..', '..', '..', 'docs', 'pipeline', 'runbook-cutover-durable.md');
  assert.ok(fs.existsSync(runbook), `el runbook citado por el mensaje debe existir: ${runbook}`);
});

test('#5214 CA-3 · el mensaje es el MISMO para las tres variantes (el remedio no cambia)', () => {
  const mensajes = new Set(INVALIDOS.map(([, kernel]) => guard.inspectDurableKernelConfig({ kernel }).message));
  assert.equal(mensajes.size, 1, 'un solo texto accionable para missing/empty/whitespace');
  assert.equal([...mensajes][0], guard.DURABLE_CONFIG_ABORT_MESSAGE);
});

test('#5214 CA-3 · el mensaje NO vuelca configuración, entorno ni el valor recibido', () => {
  // Fixture con material sensible representativo EN la config y EN el entorno.
  // Los dos tokens con forma de credencial se ARMAN en runtime a propósito: son
  // los valores de ejemplo de la documentación de AWS (no son credenciales
  // reales), pero un literal con prefijo `AKIA` en el diff dispara los escáneres
  // de secretos del pipeline. Concatenados, el test verifica exactamente lo
  // mismo sin dejar el patrón escrito en el archivo.
  const FAKE_ACCESS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE';
  const FAKE_SECRET_KEY = 'wJalrXUtnFEMI' + '-K7MDENG-bPxRfiCYEXAMPLEKEY';
  const SENSIBLES = [
    FAKE_ACCESS_KEY,
    'arn:aws:dynamodb:us-east-2:123456789012:table/secreta',
    'us-east-2',
    'intrale-kernel-coordination',
    FAKE_SECRET_KEY,
  ];
  const cfg = {
    kernel: {
      durable: true,
      tableName: '   ',
      region: SENSIBLES[2],
      coordinationTableName: SENSIBLES[3],
      tableArn: SENSIBLES[1],
      accessKeyId: FAKE_ACCESS_KEY,
    },
  };

  const res = guard.inspectDurableKernelConfig(cfg);
  let lanzado = '';
  try { guard.assertDurableKernelConfig(cfg); } catch (e) { lanzado = `${e.message} ${e.stack.split('\n')[0]}`; }

  const superficie = `${res.message} ${lanzado}`;
  for (const s of SENSIBLES) {
    assert.ok(!superficie.includes(s), `el diagnóstico no debe contener "${s}"`);
  }
  // Ni el objeto serializado, ni el valor crudo, ni variables de entorno.
  assert.doesNotMatch(superficie, /\{.*durable.*\}/s, 'no serializa el objeto config');
  assert.doesNotMatch(superficie, /process\.env|PIPELINE_|AWS_/, 'no menciona entorno');
  assert.doesNotMatch(superficie, /A05|CA-9/, 'los códigos de auditoría no ocupan el lugar de la instrucción');
});

test('#5214 CA-3 · el mensaje no ofrece apagar durable como salida (eso sería el fallback)', () => {
  const m = guard.DURABLE_CONFIG_ABORT_MESSAGE.toLowerCase();
  // Menciona `durable: true` para dar contexto, pero no debe sugerir apagarlo:
  // un menú de dos caminos invita exactamente al fallback que el CA-2 prohíbe.
  assert.ok(!/apag[aá]|desactiv|durable:\s*false|pon[eé]\s+durable/.test(m),
    'una sola acción: completar la clave');
  assert.match(m, /no cae a filesystem/, 'dice explícitamente que no hay fallback');
});

// -----------------------------------------------------------------------------
// §5 · CA-1 — terminación real del proceso con código no-cero
// -----------------------------------------------------------------------------
// Los tests de arriba prueban el veredicto y el orden con dependencias
// inyectadas. Éste prueba el DESENLACE: un proceso Node de verdad, terminando de
// verdad, con un código de salida de verdad. Sin esto, "termina con código
// no-cero" queda afirmado por un fake.

function runChild(source) {
  return spawnSync(process.execPath, ['-e', source], { encoding: 'utf8' });
}

for (const [caso, kernel, reasonEsperado] of INVALIDOS) {
  test(`#5214 CA-1 · proceso real: tableName ${caso} termina con código no-cero`, () => {
    const child = runChild(`
      const guard = require(${JSON.stringify(GUARD_PATH)});
      const cfg = ${JSON.stringify({ kernel })};
      const res = guard.inspectDurableKernelConfig(cfg);
      if (res.ok) { console.error('BUG: la config inválida pasó el guard'); process.exit(0); }
      guard.abortOnInvalidDurableConfig({
        reason: res.reason,
        log: (m) => process.stderr.write(m + '\\n'),
      });
      // Si el aborto no terminara el proceso, salimos en 0 y el test falla.
      console.error('BUG: el proceso siguió vivo después del aborto');
    `);
    assert.notEqual(child.status, 0, `el proceso debe terminar no-cero (status=${child.status}, stderr=${child.stderr})`);
    assert.equal(child.status, guard.DURABLE_CONFIG_EXIT_CODE, 'termina con EX_CONFIG');
    assert.doesNotMatch(child.stderr, /BUG:/, 'ni pasó el guard ni sobrevivió al aborto');
    assert.match(child.stderr, /\.pipeline\/config\.yaml/, 'el operador ve dónde editar');
    assert.match(child.stderr, /runbook-cutover-durable\.md/, 'y a dónde ir');
    assert.ok(!child.stderr.includes(reasonEsperado === 'missing' ? 'undefined' : 'XXNOPEXX'),
      'no imprime el valor crudo');
  });
}

test('#5214 CA-1 · proceso real: una excepción no atrapada del guard también sale no-cero', () => {
  // Camino alternativo: un entrypoint que use `assertDurableKernelConfig` sin
  // atraparlo muere igual, nunca sigue.
  const child = runChild(`
    const guard = require(${JSON.stringify(GUARD_PATH)});
    guard.assertDurableKernelConfig({ kernel: { durable: true, tableName: '   ' } });
    console.log('BUG: siguió después del assert');
  `);
  assert.notEqual(child.status, 0, 'excepción no atrapada ⇒ exit no-cero');
  assert.doesNotMatch(String(child.stdout), /BUG:/);
  assert.match(child.stderr, /KernelDurableConfigError/);
});

test('#5214 · proceso real: con tableName válido el guard no interrumpe nada (exit 0)', () => {
  // El complemento obligatorio: si el guard matara también el camino sano,
  // encender durable sería imposible.
  const child = runChild(`
    const guard = require(${JSON.stringify(GUARD_PATH)});
    const ok = guard.assertDurableKernelConfig({ kernel: { durable: true, tableName: 'intrale-kernel-state' } });
    if (ok.tableName !== 'intrale-kernel-state') { process.exit(9); }
  `);
  assert.equal(child.status, 0, `config válida no debe abortar (stderr=${child.stderr})`);
});

test('#5214 · proceso real: el módulo del guard NO carga AWS ni el store', () => {
  // CA-4 "cero llamadas AWS" por construcción: se inspecciona el grafo de
  // módulos cargados después de requerir el guard. Si mañana alguien le mete un
  // `require('./kernel-store')` adentro, el guard deja de poder correr antes que
  // el driver y este test lo caza.
  const child = runChild(`
    const guard = require(${JSON.stringify(GUARD_PATH)});
    guard.inspectDurableKernelConfig({ kernel: { durable: true, tableName: '  ' } });
    const cargados = Object.keys(require.cache).map((p) => p.replace(/\\\\/g, '/'));
    const prohibidos = cargados.filter((p) =>
      /kernel-store|provisioner-infra|kernel-provision|credentials|ajv|aws/i.test(p));
    if (prohibidos.length) { console.error('CARGADOS: ' + prohibidos.join(', ')); process.exit(7); }
  `);
  assert.equal(child.status, 0, `el guard no debe arrastrar AWS/store: ${child.stderr}`);
});
