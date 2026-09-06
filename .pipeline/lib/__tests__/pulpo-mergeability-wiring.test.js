'use strict';

// =============================================================================
// pulpo-mergeability-wiring.test.js — Cableado real del brazo (#4968)
// =============================================================================
//
// Los otros dos tests del split ejercitan el core y la cadena. Este verifica lo
// único que ninguno de los dos puede ver: que el brazo esté REALMENTE cableado
// en `pulpo.js` y que su wrapper se porte como promete.
//
//   - flag apagado  => `brazoPrMergeability(config)` resuelve sin tocar `gh`;
//   - core que rechaza => la promesa no queda unhandled y el guard queda libre;
//   - el core está en el objeto exportado bajo `PULPO_NO_AUTOSTART`;
//   - la llamada está dentro del bloque de dispatch del tick, con su `.catch`.
//
// `PULPO_NO_AUTOSTART=1` ANTES del require corta el arranque del singleton y
// del `mainLoop` (precedente literal: `pulpo-intake-routing.test.js:13`).
// =============================================================================

process.env.PULPO_NO_AUTOSTART = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pulpo = require('../../pulpo.js');
const core = require('../brazo-pr-mergeability-core');

const PULPO_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');

// -----------------------------------------------------------------------------
// El brazo existe y está expuesto
// -----------------------------------------------------------------------------

test('#4968: el brazo y su core quedan expuestos bajo PULPO_NO_AUTOSTART', () => {
  assert.equal(typeof pulpo.brazoPrMergeability, 'function');
  assert.equal(pulpo.brazoPrMergeabilityCore, core, 'el core cableado es el módulo real, no una copia');
  assert.equal(typeof pulpo._getMergeabilityGuard().isRunning, 'function');
  assert.equal(typeof pulpo._getMergeabilityScheduler().state, 'function');
});

test('#4968 H-A1: la decisión NO vive en pulpo.js — el wrapper delega en el core', () => {
  // El wrapper puede leer la config y loguear, pero los clamps, el vocabulario
  // de motivos y la orquestación tienen que estar del otro lado.
  for (const propioDelCore of ['normalizeWatcherConfig', 'runTick', 'createReentryGuard', 'createScheduler']) {
    assert.ok(
      PULPO_SRC.includes(`brazoPrMergeabilityCore.${propioDelCore}`),
      `${propioDelCore} debe invocarse del core, no reimplementarse`,
    );
  }
  // Y ninguna constante de política del watcher puede estar hardcodeada acá.
  const wrapper = PULPO_SRC.slice(
    PULPO_SRC.indexOf('async function brazoPrMergeability(config)'),
    PULPO_SRC.indexOf('async function brazoPrMergeability(config)') + 3_000,
  );
  assert.ok(wrapper.length > 0, 'el wrapper existe');
  assert.ok(!/poll_interval|max_concurrency|backoff_|expected_repo/.test(wrapper),
    'el wrapper no puede leer claves de config por su cuenta: eso es del core');
});

// -----------------------------------------------------------------------------
// CA-1 — flag apagado ⇒ CERO llamadas a GitHub
// -----------------------------------------------------------------------------

test('#4968 CA-1: con el flag apagado el brazo resuelve sin tocar gh ni el guard', async () => {
  const guard = pulpo._getMergeabilityGuard();
  const configs = [
    {},                                                     // sin la sección
    { pr_mergeability_watcher: null },
    { pr_mergeability_watcher: { enabled: false } },
    { pr_mergeability_watcher: { enabled: 'true' } },        // string, no enciende
    { pr_mergeability_watcher: { enabled: true, kill_switch: true } },
    undefined,
    null,
  ];
  for (const config of configs) {
    await assert.doesNotReject(() => pulpo.brazoPrMergeability(config), JSON.stringify(config));
    assert.equal(guard.isRunning(), false, `${JSON.stringify(config)}: el guard quedó libre`);
  }
});

test('#4968 CA-1: la config REAL del repo deja el brazo apagado (DoD: enabled:false en main)', async () => {
  const yaml = require('js-yaml');
  const real = yaml.load(fs.readFileSync(path.join(__dirname, '..', '..', 'config.yaml'), 'utf8'));
  assert.equal(real.pr_mergeability_watcher.enabled, false);
  await assert.doesNotReject(() => pulpo.brazoPrMergeability(real));
  assert.equal(pulpo._getMergeabilityGuard().isRunning(), false);
});

test('#4968 CA-1: una config ROTA deja el brazo apagado y NO tumba al Pulpo', async () => {
  for (const seccion of [
    { enabled: true, max_concurrency: 0 },
    { enabled: true, expected_repo: '../../etc/passwd' },
    { enabled: true, expected_repo: 'atacante/platform' },
    { enabled: true, poll_interval_minutes: -1 },
    { enabled: true, backoff_base_ms: 'mucho' },
  ]) {
    await assert.doesNotReject(
      () => pulpo.brazoPrMergeability({ pr_mergeability_watcher: seccion }),
      JSON.stringify(seccion),
    );
    assert.equal(pulpo._getMergeabilityGuard().isRunning(), false);
  }
});

// -----------------------------------------------------------------------------
// CA-2 / CA-3 — el brazo que explota no se lleva nada por delante
// -----------------------------------------------------------------------------

test('#4968 CA-2/CA-3: un core que rechaza no deja promesa unhandled y libera el guard', async () => {
  const guard = pulpo._getMergeabilityGuard();
  const original = core.runTick;
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    core.runTick = async () => { throw new Error('el core explotó'); };
    // Config válida y encendida: fuerza a entrar al guard y llegar al runTick.
    await assert.doesNotReject(() => pulpo.brazoPrMergeability({
      pr_mergeability_watcher: { enabled: true },
    }));
    assert.equal(guard.isRunning(), false, 'release() corrió en el finally');
    // Un tick nuevo puede entrar: el brazo no quedó muerto.
    assert.equal(guard.tryEnter(), true);
    guard.release();
  } finally {
    core.runTick = original;
    process.off('unhandledRejection', onUnhandled);
  }
  await new Promise(res => setImmediate(res));
  assert.deepEqual(unhandled, [], 'ninguna promesa quedó sin manejar');
});

test('#4968 CA-3: mientras un tick está en vuelo, el siguiente no entra', async () => {
  const guard = pulpo._getMergeabilityGuard();
  const original = core.runTick;
  let enVuelo = 0;
  let pico = 0;
  let soltar;
  const bloqueo = new Promise(res => { soltar = res; });
  try {
    core.runTick = async () => {
      enVuelo += 1; pico = Math.max(pico, enVuelo);
      await bloqueo;
      enVuelo -= 1;
      return { ok: true, rewound: [], blocked: [] };
    };
    pulpo._getMergeabilityScheduler().reset();
    const config = { pr_mergeability_watcher: { enabled: true } };

    const primero = pulpo.brazoPrMergeability(config);
    await new Promise(res => setImmediate(res));
    assert.equal(guard.isRunning(), true, 'el primer tick tomó el guard');

    // El segundo tick llega mientras el primero sigue en vuelo.
    await pulpo.brazoPrMergeability(config);
    assert.equal(pico, 1, 'el segundo tick NO entró');

    soltar();
    await primero;
    assert.equal(guard.isRunning(), false);
  } finally {
    core.runTick = original;
    if (soltar) soltar();
  }
});

// -----------------------------------------------------------------------------
// H-A3 — el brazo usa el runner endurecido del Pulpo, no un `gh` propio
// -----------------------------------------------------------------------------

test('#4968 H-A3: el ghCall inyectado es el runner con timeout + breaker del Pulpo', async () => {
  const original = core.runTick;
  let deps = null;
  try {
    core.runTick = async (cfg, d) => { deps = d; return { ok: true, rewound: [], blocked: [] }; };
    pulpo._getMergeabilityScheduler().reset();
    await pulpo.brazoPrMergeability({ pr_mergeability_watcher: { enabled: true } });
  } finally {
    core.runTick = original;
  }
  assert.ok(deps, 'el wrapper llamó al core');
  assert.equal(typeof deps.ghCall, 'function');
  assert.equal(typeof deps.onChildSpawn, 'function', 'el pid se registra en el guard');
  assert.equal(typeof deps.getActiveWave, 'function');
  assert.equal(typeof deps.pipelineRoot, 'string');
  assert.ok(deps.config, 'el config resuelto viaja al rewind (skills_por_fase)');
  assert.ok(deps.yaml, 'el yaml del Pulpo viaja al rewind');
});

test('#4968 H-A3: el wrapper NO spawnea gh por su cuenta', () => {
  const inicio = PULPO_SRC.indexOf('async function brazoPrMergeability(config)');
  const wrapper = PULPO_SRC.slice(inicio, inicio + 3_000);
  for (const prohibido of ['execFile(', 'spawnSync(', 'spawn(', 'GH_BIN,']) {
    if (prohibido === 'GH_BIN,') continue; // GH_BIN sí: es el binario del runner endurecido
    assert.ok(!wrapper.includes(prohibido), `el wrapper no puede usar ${prohibido}`);
  }
  assert.ok(wrapper.includes('_ghCallWithTimeout(GH_BIN'), 'usa el runner endurecido del Pulpo');
});

test('#4968 H-A3: onSpawn de _ghCallWithTimeout es aditivo — ningún caller previo lo pasa', () => {
  // La firma creció en un parámetro opcional. Si alguna llamada existente
  // pasara un 4º argumento sin querer, esto lo detecta.
  const llamadas = PULPO_SRC.match(/_ghCallWithTimeout\([^)]*\)/g) || [];
  assert.ok(llamadas.length >= 2, 'hay llamadas al runner');
  for (const l of llamadas) {
    if (l.includes('function')) continue;
    const args = l.slice(l.indexOf('(') + 1, -1).split(',').length;
    assert.ok(args <= 4, `llamada con demasiados argumentos: ${l}`);
  }
});

// -----------------------------------------------------------------------------
// CA-2 — el brazo está en el tick, aislado, y no bloquea el dispatch
// -----------------------------------------------------------------------------

test('#4968 CA-2: la llamada del tick es fire-and-forget con su propio .catch', () => {
  const linea = PULPO_SRC.split('\n').find(l => l.includes('brazoPrMergeability(config)') && l.includes('.catch'));
  assert.ok(linea, 'el brazo se invoca en el tick con .catch');
  // `brazoPrMergeabilityCore.runTick` SÍ se awaitea adentro del wrapper: lo que
  // no puede awaitearse es el BRAZO desde el tick. De ahí el `(` del patrón.
  assert.ok(!/await\s+brazoPrMergeability\(/.test(PULPO_SRC), 'nunca se awaitea: no puede frenar el tick');
});

test('#4968 CA-2: el brazo corre DESPUÉS del dispatch, dentro del bloque no-pausado', () => {
  const iBrazo = PULPO_SRC.indexOf('brazoPrMergeability(config).catch');
  const iLanzamiento = PULPO_SRC.indexOf('brazoLanzamiento(config);');
  const iPausa = PULPO_SRC.indexOf("log('pulpo', 'PAUSADO — esperando reanudación");
  assert.ok(iBrazo > 0 && iLanzamiento > 0 && iPausa > 0);
  assert.ok(iLanzamiento < iBrazo, 'el lanzamiento de agentes va primero: el watcher nunca lo retrasa');
  assert.ok(iBrazo < iPausa, 'la llamada está dentro del bloque de dispatch (no corre en pausa)');
});

// -----------------------------------------------------------------------------
// Scope negativo — este split no toca los entregables de #4966/#4967
// -----------------------------------------------------------------------------

test('#4968: el split no modifica los módulos de #4966/#4967 (scope negativo)', () => {
  // Verificación estructural: los módulos ajenos no mencionan a este brazo.
  for (const rel of ['pr-mergeability-watcher.js', 'pr-info-fetcher.js', 'pipeline-rewind.js', 'rewind-event-adapter.js', 'waves.js', 'config-schema.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.ok(!src.includes('brazo-pr-mergeability-core'), `${rel} no debe conocer al brazo`);
    assert.ok(!src.includes('brazoPrMergeability'), `${rel} no debe conocer al brazo`);
  }
});

// -----------------------------------------------------------------------------
// H-A2 — un valor fuera de rango NO puede tumbar al Pulpo
// -----------------------------------------------------------------------------
//
// La receta pedía "no tocar `config-schema.js`". #4966 igual declaró ahí la
// sección, pero LENIENT (`additionalProperties: true`), tipando sólo las claves
// que existían. Lo que H-A2 protege de verdad no es la ausencia de la sección
// del schema: es que un valor fuera de rango degrade a `brazo apagado` en vez
// de a `ConfigSchemaViolation` (= halt). Eso es lo que se verifica acá, contra
// el validador REAL — que es la afirmación que importa.

test('#4968 H-A2: las claves de wiring de este split NO disparan ConfigSchemaViolation', () => {
  const { validateConfig } = require('../config-schema');
  const yaml = require('js-yaml');
  const real = yaml.load(fs.readFileSync(path.join(__dirname, '..', '..', 'config.yaml'), 'utf8'));

  // La config del repo, tal cual, valida.
  assert.doesNotThrow(() => validateConfig(real), 'la config real del repo debe validar');

  // Y también valida con CUALQUIER valor absurdo en las claves nuevas: ninguno
  // puede ser un halt. Quien decide qué hacer con ellos es el core, y lo hace
  // de dos maneras distintas a propósito:
  //   - fuera de rango pero coherente  => CLAMP hacia el lado conservador;
  //   - roto (0, negativo, no numérico) => FAIL-CLOSED con motivo tipado.
  const clampean = [
    [{ max_concurrency: 9_999 }, (cfg) => assert.equal(cfg.maxConcurrency, 5)],
    [{ wedge_timeout_ms: 1_000 }, (cfg) => assert.ok(cfg.wedgeTimeoutMs >= 60_000)],
    [{ poll_interval_minutes: 1 }, (cfg) => assert.equal(cfg.pollIntervalMs, core.MIN_POLL_INTERVAL_MS)],
    // Un booleano mal escrito NO enciende el kill switch, pero tampoco rompe.
    [{ kill_switch: 'quizás' }, (cfg) => assert.ok(cfg.repo)],
  ];
  const failClosed = [
    { max_concurrency: 0 },
    { max_concurrency: 'dos' },
    { backoff_base_ms: -1 },
    { backoff_max_ms: 'mucho' },
    { allowed_repos: '../../etc' },
    { expected_repo: 'atacante/platform' },
  ];

  for (const over of [...clampean.map(c => c[0]), ...failClosed]) {
    const roto = { ...real, pr_mergeability_watcher: { ...real.pr_mergeability_watcher, ...over } };
    assert.doesNotThrow(() => validateConfig(roto),
      `${JSON.stringify(over)} no puede ser halt del Pulpo (contradiría CA-1)`);
  }
  for (const [over, comprobar] of clampean) {
    const norm = core.normalizeWatcherConfig({ ...real.pr_mergeability_watcher, ...over, enabled: true });
    assert.equal(norm.ok, true, `${JSON.stringify(over)}: debía clampear, no rechazar`);
    comprobar(norm.cfg);
  }
  for (const over of failClosed) {
    const norm = core.normalizeWatcherConfig({ ...real.pr_mergeability_watcher, ...over, enabled: true });
    assert.equal(norm.ok, false, `${JSON.stringify(over)}: el core debe rechazarlo`);
    assert.ok(typeof norm.reason === 'string' && norm.reason.length > 0, 'con motivo tipado');
  }
});

test('#4968 H-A2: la sección sigue siendo lenient en el schema (los límites viven en código)', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'config-schema.js'), 'utf8');
  const i = schema.indexOf('pr_mergeability_watcher: {');
  assert.ok(i > 0, 'la sección la declaró #4966');
  const bloque = schema.slice(i, i + 900);
  assert.ok(bloque.includes('additionalProperties: true'),
    'cerrarla convertiría una clave nueva en halt del Pulpo');
  // Este split NO agregó tipados propios ahí: sus claves se validan en el core.
  for (const mia of ['kill_switch', 'max_concurrency', 'backoff_base_ms', 'backoff_max_ms', 'wedge_timeout_ms', 'allowed_repos']) {
    assert.ok(!bloque.includes(`${mia}:`), `${mia} no debe tiparse en el schema (H-A2)`);
  }
});
