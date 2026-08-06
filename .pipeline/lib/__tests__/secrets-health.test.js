// =============================================================================
// #5243 — Tests del health-check de secretos (TRAMO 2).
//
// Es un control de SEGURIDAD: el modo de falla que la historia entera intenta
// prevenir es el fail-open (reportar verde sobre un estado roto). Por eso los
// tests afirman tanto la clasificación como las fronteras: que ningún valor
// salga, que el módulo no pueda matar el proceso, y que la pausa deliberada del
// operador nunca se pise ni se levante sola.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const sh = require('../secrets-health');
const pp = require('../partial-pause');

const MODULE_PATH = path.join(__dirname, '..', 'secrets-health.js');
const MODULE_SRC = fs.readFileSync(MODULE_PATH, 'utf8');

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sh-5243-${label}-`));
}

/** Manifiesto mínimo con las formas que importan. */
function manifiestoFake(entries) {
  return { entries };
}

function entrada(over = {}) {
  return {
    name: 'telegram.bot_token',
    service: 'telegram',
    source: 'store',
    env_var: 'TELEGRAM_BOT_TOKEN',
    required_when: 'always',
    hydration: 'eager',
    consumer_status: 'resolved',
    restore: 'docs/runbooks/credential-rotation.md#telegram',
    ...over,
  };
}

/** `loadIntoEnv` fake: sólo nombres, como el real. */
function cargaFake(over = {}) {
  return {
    source: 'canonical', hydrated: [], skipped_existing: [], skipped_empty: [], missing: [], ...over,
  };
}

function porNombre(evaluation, name) {
  return evaluation.entries.find((e) => e.name === name);
}

/** `partialPause` fake que escribe el marker igual que el real (#5399). */
function fakePartialPause(pauseFile) {
  return {
    calls: [],
    setFullPause(opts) {
      this.calls.push(['set', opts.source]);
      fs.writeFileSync(pauseFile, JSON.stringify({
        source: opts.source, ts: '2026-08-06T00:00:00.000Z', detail: opts.justification,
      }));
      return { ok: true };
    },
    clearFullPause(opts) {
      this.calls.push(['clear', opts.source]);
      try { fs.unlinkSync(pauseFile); } catch { /* noop */ }
      return { ok: true, existed: true };
    },
    readFullPauseOrigin() {
      // Réplica fiel del contrato fail-closed del módulo real.
      let raw;
      try { raw = fs.readFileSync(pauseFile, 'utf8'); } catch { return { source: 'manual' }; }
      if (!raw.trim()) return { source: 'manual' };
      let parsed;
      try { parsed = JSON.parse(raw); } catch { return { source: 'manual' }; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { source: 'manual' };
      return pp.isAutoLiftableSource(parsed.source)
        ? { source: parsed.source } : { source: 'manual' };
    },
  };
}

// -----------------------------------------------------------------------------
// CA-4 — tres estados, distinguibles
// -----------------------------------------------------------------------------

test('CA-4: evaluate clasifica ok, missing y chain_broken, y los distingue', () => {
  const manifest = manifiestoFake([
    entrada({ name: 'telegram.bot_token', env_var: 'TELEGRAM_BOT_TOKEN' }),
    entrada({ name: 'telegram.chat_id', env_var: 'TELEGRAM_CHAT_ID' }),
    entrada({ name: 'telegram.extra', env_var: 'TELEGRAM_EXTRA' }),
  ]);
  const presence = { present: ['telegram.bot_token', 'telegram.extra'], placeholder: [], absent: ['telegram.chat_id'] };
  const load = cargaFake({ hydrated: ['TELEGRAM_BOT_TOKEN'] });

  const ev = sh.evaluate(load, manifest, presence);

  assert.equal(porNombre(ev, 'telegram.bot_token').state, 'ok');
  // Ausente del store → REPONER.
  assert.equal(porNombre(ev, 'telegram.chat_id').state, 'missing');
  assert.equal(porNombre(ev, 'telegram.chat_id').remediation, 'REPONER');
  // En el store pero no llegó al ambiente → CABLEAR. La acción del operador es
  // distinta: por eso los dos negativos no pueden colapsar en un solo estado.
  assert.equal(porNombre(ev, 'telegram.extra').state, 'chain_broken');
  assert.equal(porNombre(ev, 'telegram.extra').remediation, 'CABLEAR');

  assert.equal(ev.ok, false, 'ambos negativos cuentan como ok:false');
  assert.deepEqual(ev.counts, { ok: 1, missing: 1, chain_broken: 1 });
});

test('CA-4: en el store sin env_var declarado → chain_broken (no missing)', () => {
  const manifest = manifiestoFake([entrada({ name: 'aws.region', env_var: undefined })]);
  const ev = sh.evaluate(cargaFake(), manifest, { present: ['aws.region'], placeholder: [], absent: [] });
  assert.equal(porNombre(ev, 'aws.region').state, 'chain_broken');
  assert.equal(porNombre(ev, 'aws.region').remediation, 'CABLEAR');
});

test('CA-4: consumer_status broken → chain_broken aunque el secreto esté presente e hidratado', () => {
  // #5242 §R5 — "presente en el store" no es "resoluble por su consumidor".
  const manifest = manifiestoFake([entrada({
    name: 'aws.access_key_id', service: 'aws', env_var: 'AWS_ACCESS_KEY_ID', consumer_status: 'broken',
  })]);
  const ev = sh.evaluate(cargaFake({ hydrated: ['AWS_ACCESS_KEY_ID'] }), manifest,
    { present: ['aws.access_key_id'], placeholder: [], absent: [] });
  assert.equal(porNombre(ev, 'aws.access_key_id').state, 'chain_broken');
});

test('CA-4: hydration deferred presente no se reporta chain_broken por no estar hidratada', () => {
  const manifest = manifiestoFake([entrada({
    name: 'aws.table_name', service: 'aws', env_var: 'AWS_TABLE_NAME', hydration: 'deferred',
  })]);
  const ev = sh.evaluate(cargaFake(), manifest, { present: ['aws.table_name'], placeholder: [], absent: [] });
  assert.equal(porNombre(ev, 'aws.table_name').state, 'ok');
});

// -----------------------------------------------------------------------------
// CA-4c — los dos caminos que dan verde con el secreto ausente
// -----------------------------------------------------------------------------

test('CA-4c: required_when never ausente → ok', () => {
  const manifest = manifiestoFake([entrada({
    name: 'providers.anthropic.api_key', service: 'providers',
    env_var: 'ANTHROPIC_API_KEY', required_when: 'never',
  })]);
  const ev = sh.evaluate(cargaFake(), manifest, { present: [], placeholder: [], absent: ['providers.anthropic.api_key'] });
  assert.equal(porNombre(ev, 'providers.anthropic.api_key').state, 'ok');
  assert.equal(ev.ok, true);
  assert.equal(ev.halt, false);
});

test('CA-4c: service_active con el servicio inactivo (ningun secreto del grupo) → ok', () => {
  const manifest = manifiestoFake([
    entrada({ name: 'r2.account_id', service: 'r2', source: 'env', env_var: 'R2_ACCOUNT_ID', required_when: 'service_active' }),
    entrada({ name: 'r2.bucket', service: 'r2', source: 'env', env_var: 'R2_BUCKET', required_when: 'service_active' }),
  ]);
  const ev = sh.evaluate(cargaFake(), manifest, { present: [], placeholder: [], absent: ['r2.account_id', 'r2.bucket'] });
  assert.equal(ev.ok, true, 'un servicio que el operador no usa no es un faltante');
  assert.equal(ev.halt, false);
});

test('CA-4c: service_active con el servicio ACTIVO y una pieza ausente → missing (no se tapa)', () => {
  const manifest = manifiestoFake([
    entrada({ name: 'r2.account_id', service: 'r2', source: 'env', env_var: 'R2_ACCOUNT_ID', required_when: 'service_active' }),
    entrada({ name: 'r2.bucket', service: 'r2', source: 'env', env_var: 'R2_BUCKET', required_when: 'service_active' }),
  ]);
  const ev = sh.evaluate(cargaFake(), manifest, { present: ['r2.account_id'], placeholder: [], absent: ['r2.bucket'] });
  assert.equal(porNombre(ev, 'r2.bucket').state, 'missing');
  assert.equal(ev.ok, false);
});

test('CA-4c: la actividad se mide por GRUPO, no por servicio (openai activo no activa moonshot)', () => {
  // R-6 — `providers` agrupa proveedores independientes. Medir actividad por
  // `service` clasificaría a Moonshot como faltante sólo porque OpenAI existe.
  const manifest = manifiestoFake([
    entrada({ name: 'providers.openai.api_key', service: 'providers', env_var: 'OPENAI_API_KEY', required_when: 'service_active' }),
    entrada({ name: 'providers.moonshot.api_key', service: 'providers', env_var: 'ANTHROPIC_AUTH_TOKEN', required_when: 'service_active' }),
  ]);
  const ev = sh.evaluate(cargaFake({ hydrated: ['OPENAI_API_KEY'] }), manifest,
    { present: ['providers.openai.api_key'], placeholder: [], absent: ['providers.moonshot.api_key'] });
  assert.equal(porNombre(ev, 'providers.moonshot.api_key').state, 'ok');
  assert.equal(ev.halt, false);
});

// -----------------------------------------------------------------------------
// CA-4b — sin regex duplicada
// -----------------------------------------------------------------------------

test('CA-4b: el modulo no declara su propia regex de placeholder', () => {
  // Duplicar el criterio (que el dueño del store no exporta) es el modo de
  // falla exacto de #4907/#4912: las dos copias derivan y el health-check
  // reporta verde sobre un valor de relleno.
  assert.equal(/PLACEHOLDER_RE/.test(MODULE_SRC), false,
    'secrets-health.js no puede declarar su propia regex de placeholder');
  assert.match(MODULE_SRC, /isPlaceholderOrEmpty/,
    'debe reusar el criterio exportado por credentials.js');
});

test('CA-4b: un valor de relleno se clasifica missing, no ok (funcional)', () => {
  const dir = tmpDir('placeholder');
  const storePath = path.join(dir, 'credentials.json');
  fs.writeFileSync(storePath, JSON.stringify({ telegram: { bot_token: 'REVOKED_2026' } }));

  const manifest = manifiestoFake([entrada({ name: 'telegram.bot_token' })]);
  const presence = sh.collectPresence({ manifest, storePath, env: {} });
  assert.deepEqual(presence.placeholder, ['telegram.bot_token']);

  const ev = sh.evaluate(cargaFake(), manifest, presence);
  assert.equal(porNombre(ev, 'telegram.bot_token').state, 'missing');
  assert.match(porNombre(ev, 'telegram.bot_token').motivo, /relleno/);
});

// -----------------------------------------------------------------------------
// SEC-1 — ningún valor cruza la frontera
// -----------------------------------------------------------------------------

test('SEC-1: el valor del secreto no aparece en evaluate, formatAlert ni el JSON escrito', () => {
  const VALOR = 'sk-live-VALORREALISTA0123456789abcdef';
  const dir = tmpDir('sec1');
  const storePath = path.join(dir, 'credentials.json');
  const jsonPath = path.join(dir, 'secrets-health.json');
  fs.writeFileSync(storePath, JSON.stringify({ telegram: { bot_token: VALOR }, providers: { openai: { api_key: VALOR } } }));

  const manifest = manifiestoFake([
    entrada({ name: 'telegram.bot_token' }),
    entrada({ name: 'providers.openai.api_key', service: 'providers', env_var: 'OPENAI_API_KEY' }),
  ]);
  const presence = sh.collectPresence({ manifest, storePath, env: {} });
  const ev = sh.evaluate(cargaFake(), manifest, presence);

  assert.equal(JSON.stringify(ev).includes(VALOR), false, 'evaluate no puede filtrar el valor');
  assert.equal(sh.formatAlert(ev).includes(VALOR), false, 'formatAlert no puede filtrar el valor');

  sh.writeHealthJson(ev, jsonPath);
  assert.equal(fs.readFileSync(jsonPath, 'utf8').includes(VALOR), false, 'el artefacto no puede filtrar el valor');

  // `evaluate` es puro: ni siquiera recibe el store.
  assert.equal(sh.evaluate.length <= 4, true);
});

test('CA-7d/SEC-6: la salida no lleva prefijo, longitud ni hash del valor', () => {
  const VALOR = 'GOCSPX-abcdef0123456789';
  const dir = tmpDir('ca7d');
  const storePath = path.join(dir, 'credentials.json');
  fs.writeFileSync(storePath, JSON.stringify({ google_drive: { oauth_client_secret: VALOR } }));

  const manifest = manifiestoFake([entrada({
    name: 'google_drive.oauth_client_secret', service: 'google_drive', env_var: 'GOOGLE_OAUTH_CLIENT_SECRET',
  })]);
  const ev = sh.evaluate(cargaFake(), manifest, sh.collectPresence({ manifest, storePath, env: {} }));
  // Camino completo de salida, incluido el que viaja por `motivo:` → YAML →
  // GitHub → Telegram (el repo es PUBLICO).
  const salidas = [JSON.stringify(ev), sh.formatAlert(ev), sh.formatSummary(ev)];

  for (const out of salidas) {
    assert.equal(out.includes(VALOR), false, 'valor completo');
    assert.equal(out.includes('GOCSPX-'), false, 'prefijo del valor');
    assert.equal(out.includes(String(VALOR.length)), false, 'longitud exacta del valor');
    assert.equal(/[a-f0-9]{32,}/i.test(out), false, 'cualquier hash del valor');
  }
});

// -----------------------------------------------------------------------------
// CA-5b — el módulo no puede matar el proceso
// -----------------------------------------------------------------------------

test('CA-5b: el unico process.exit vive bajo require.main === module', () => {
  // `watchdog.ps1` respawnea cada 2 min sin leer exit code ni backoff: un exit
  // en el boot reproduce las 12 h de Commander caído de #5073.
  // Se mide sobre CÓDIGO, no sobre prosa: el encabezado del módulo explica por
  // qué no hay un exit, y contar esa mención sería un falso positivo.
  const codigo = MODULE_SRC
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\w])\/\/[^\n]*/g, '$1');
  const idxMain = codigo.indexOf('require.main === module');
  assert.ok(idxMain > 0, 'debe existir la rama CLI');
  const antesDelCli = codigo.slice(0, idxMain);
  assert.equal(/process\.exit/.test(antesDelCli), false,
    'ningun process.exit puede vivir en el camino de libreria');
  // Y los que hay viven todos después del guard.
  assert.ok((codigo.match(/process\.exit/g) || []).length >= 1, 'la rama CLI si puede terminar el proceso');
});

test('CA-5b: applyHalt no llama process.exit ni siquiera con un halt activo', () => {
  const dir = tmpDir('noexit');
  const pauseFile = path.join(dir, '.paused');
  const manifest = manifiestoFake([entrada({ name: 'telegram.bot_token' })]);
  const ev = sh.evaluate(cargaFake(), manifest, { present: [], placeholder: [], absent: ['telegram.bot_token'] });
  assert.equal(ev.halt, true, 'un always ausente si frena');

  const original = process.exit;
  let llamado = false;
  process.exit = () => { llamado = true; };
  try {
    sh.applyHalt(ev, { pauseFile, partialPause: fakePartialPause(pauseFile), pipelineDir: dir, logger: () => {} });
  } finally {
    process.exit = original;
  }
  assert.equal(llamado, false, 'applyHalt jamas puede terminar el proceso');
});

test('G-1: applyHalt con deps invalidos no lanza hacia afuera', () => {
  const manifest = manifiestoFake([entrada({ name: 'telegram.bot_token' })]);
  const ev = sh.evaluate(cargaFake(), manifest, { present: [], placeholder: [], absent: ['telegram.bot_token'] });
  assert.doesNotThrow(() => sh.applyHalt(ev, {}));
  assert.doesNotThrow(() => sh.applyHalt(ev, { pauseFile: undefined, partialPause: null, logger: 'no-soy-funcion' }));
  assert.doesNotThrow(() => sh.applyHalt(null, {}));
});

// -----------------------------------------------------------------------------
// CA-5 — halt idempotente y auto-recovery simétrico
// -----------------------------------------------------------------------------

test('CA-5: applyHalt escribe el marker con source secrets-health-halt', () => {
  const dir = tmpDir('halt');
  const pauseFile = path.join(dir, '.paused');
  const manifest = manifiestoFake([entrada({ name: 'telegram.bot_token' })]);
  const ev = sh.evaluate(cargaFake(), manifest, { present: [], placeholder: [], absent: ['telegram.bot_token'] });

  const res = sh.applyHalt(ev, { pauseFile, partialPause: fakePartialPause(pauseFile), pipelineDir: dir, logger: () => {} });

  assert.equal(res.halted, true);
  const marker = JSON.parse(fs.readFileSync(pauseFile, 'utf8'));
  assert.equal(marker.source, 'secrets-health-halt');
  assert.equal(pp.isAutoLiftableSource(marker.source), true, 'debe poder auto-levantarse (R-1)');
  // El artefacto del dashboard se escribió en el mismo paso.
  assert.equal(fs.existsSync(path.join(dir, 'secrets-health.json')), true);
});

test('CA-5: un .paused preexistente (pausa manual) NO se pisa — la manual gana', () => {
  const dir = tmpDir('idem');
  const pauseFile = path.join(dir, '.paused');
  fs.writeFileSync(pauseFile, JSON.stringify({ source: 'telegram', ts: '2026-08-01T00:00:00.000Z', detail: 'el operador pauso' }));

  const manifest = manifiestoFake([entrada({ name: 'telegram.bot_token' })]);
  const ev = sh.evaluate(cargaFake(), manifest, { present: [], placeholder: [], absent: ['telegram.bot_token'] });
  const res = sh.applyHalt(ev, { pauseFile, partialPause: fakePartialPause(pauseFile), pipelineDir: dir, logger: () => {} });

  assert.equal(res.halted, false);
  assert.equal(JSON.parse(fs.readFileSync(pauseFile, 'utf8')).source, 'telegram',
    'la autoria del operador queda intacta');
});

test('CA-5: applyHalt NO escribe marker cuando nada frena, pero si reporta', () => {
  const dir = tmpDir('warn');
  const pauseFile = path.join(dir, '.paused');
  // `service_active` faltante con el grupo activo: degrada, no frena (R-6).
  const manifest = manifiestoFake([
    entrada({ name: 'telegram.bot_token' }),
    entrada({ name: 'telegram.leo_operator_chat_id', env_var: 'TELEGRAM_LEO_OPERATOR_CHAT_ID', required_when: 'service_active' }),
  ]);
  const ev = sh.evaluate(cargaFake({ hydrated: ['TELEGRAM_BOT_TOKEN'] }), manifest,
    { present: ['telegram.bot_token'], placeholder: [], absent: ['telegram.leo_operator_chat_id'] });

  assert.equal(ev.ok, false, 'se reporta');
  assert.equal(ev.halt, false, 'pero no frena el pipeline');

  const res = sh.applyHalt(ev, { pauseFile, partialPause: fakePartialPause(pauseFile), pipelineDir: dir, logger: () => {} });
  assert.equal(fs.existsSync(pauseFile), false, 'no se pausa por una degradacion');
  assert.equal(res.channels.json, true, 'pero el artefacto igual se escribe');
});

test('CA-5: autoRecover levanta la pausa propia solo cuando el faltante ya no esta', () => {
  const dir = tmpDir('recover');
  const pauseFile = path.join(dir, '.paused');
  const fake = fakePartialPause(pauseFile);
  fs.writeFileSync(pauseFile, JSON.stringify({ source: 'secrets-health-halt', ts: '2026-08-06T00:00:00.000Z' }));

  // El módulo re-evalúa contra el estado REAL del disco (R-3). En este entorno
  // el estado vivo no frena, así que la pausa propia se levanta.
  const res = sh.autoRecover({ pauseFile, partialPause: fake, pipelineDir: dir, logger: () => {} });
  assert.equal(res.recovered, true);
  assert.equal(fs.existsSync(pauseFile), false);
  assert.deepEqual(fake.calls, [['clear', 'secrets-auto-recovery']]);
});

test('CA-5/SEC-5: autoRecover NO toca una pausa que no genero el health-check', () => {
  const dir = tmpDir('recover-manual');
  const pauseFile = path.join(dir, '.paused');
  const fake = fakePartialPause(pauseFile);

  const casosQueNoSeLevantan = [
    ['pausa manual del operador', JSON.stringify({ source: 'telegram', ts: '2026-08-06T00:00:00.000Z' })],
    ['marker legacy ISO plano', '2026-08-06T00:00:00.000Z'],
    ['marker vacio', ''],
    ['JSON invalido', '{no-soy-json'],
    ['JSON sin source', JSON.stringify({ ts: '2026-08-06T00:00:00.000Z' })],
    ['JSON que no es objeto', JSON.stringify(['secrets-health-halt'])],
    // SEC-5 — la pertenencia es EXACTA: prefijar no matchea.
    ['source con prefijo', JSON.stringify({ source: 'manual-secrets-health-halt' })],
    ['source con sufijo', JSON.stringify({ source: 'secrets-health-halt-manual' })],
    // #5135 — automática pero su no-recuperación es deliberada.
    ['kernel-cutover-degraded-halt', JSON.stringify({ source: 'kernel-cutover-degraded-halt' })],
  ];

  for (const [caso, contenido] of casosQueNoSeLevantan) {
    fs.writeFileSync(pauseFile, contenido);
    const res = sh.autoRecover({ pauseFile, partialPause: fake, pipelineDir: dir, logger: () => {} });
    assert.equal(res.recovered, false, `${caso}: no se auto-levanta`);
    assert.equal(fs.existsSync(pauseFile), true, `${caso}: el marker sigue ahi`);
  }
  assert.deepEqual(fake.calls, [], 'nunca se llamo a clearFullPause');
});

test('CA-5: autoRecover sin pausa activa es un no-op', () => {
  const dir = tmpDir('recover-sinpausa');
  const pauseFile = path.join(dir, '.paused');
  const res = sh.autoRecover({ pauseFile, partialPause: fakePartialPause(pauseFile), logger: () => {} });
  assert.equal(res.recovered, false);
  assert.equal(res.reason, 'sin-pausa');
});

// -----------------------------------------------------------------------------
// R-1 — no-regresión de #4832 / #5399 sobre el allowlist ampliado
// -----------------------------------------------------------------------------

test('R-1: ampliar el allowlist no cambia el veredicto de los sources preexistentes', () => {
  assert.equal(pp.isAutoLiftableSource('config-corruption-halt'), true, '#4832 sigue auto-levantable');
  assert.equal(pp.isAutoLiftableSource('secrets-health-halt'), true, '#5243 se suma');
  assert.equal(pp.isAutoLiftableSource('kernel-cutover-degraded-halt'), false, '#5135 sigue exigiendo rollback manual');
  assert.equal(pp.isAutoLiftableSource('telegram'), false, 'la pausa del operador nunca');
  assert.equal(pp.isAutoLiftableSource('manual'), false);
  assert.equal(pp.isAutoLiftableSource('unknown'), false);
});

test('R-1: el auto-recovery de config en pulpo.js levanta SOLO su propio halt', () => {
  // Al entrar un segundo source auto-levantable, `isAutoLiftableSource` dejó de
  // ser equivalente a "¿esta pausa la puse yo?". Si el bloque de `loadConfig`
  // siguiera preguntando por el allowlist genérico, un config sano levantaría
  // una pausa por secreto faltante cuya causa sigue vigente.
  const pulpoSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
  const idx = pulpoSrc.indexOf("source: 'config-auto-recovery'");
  assert.ok(idx > 0, 'el bloque de auto-recovery de config debe existir');
  const guarda = pulpoSrc.slice(Math.max(0, idx - 900), idx);
  assert.match(guarda, /readFullPauseOrigin\(\)\.source === 'config-corruption-halt'/,
    'la guarda debe comparar contra su propia autoria, no contra el allowlist');
});

// -----------------------------------------------------------------------------
// CA-7 / CA-7b / CA-7c / U1 / U2 / U3 — el aviso
// -----------------------------------------------------------------------------

test('CA-7: el aviso dice que falta, que frena y como reponerlo', () => {
  const manifest = manifiestoFake([entrada({ name: 'telegram.bot_token' })]);
  const ev = sh.evaluate(cargaFake(), manifest, { present: [], placeholder: [], absent: ['telegram.bot_token'] });
  const texto = sh.formatAlert(ev);

  assert.match(texto, /telegram\.bot_token/, 'que falta');
  assert.match(texto, /pipeline queda ciego/, 'que frena');
  assert.match(texto, /REPONER/, 'como reponerlo');
  assert.match(texto, /credential-rotation\.md#telegram/, 'ancla del runbook');
  assert.match(texto, /Como sigue/, 'como sigue');
});

test('U1: una entrada chain_broken dice CABLEAR y no manda a reponer el secreto', () => {
  const manifest = manifiestoFake([entrada({ name: 'telegram.extra', env_var: 'TELEGRAM_EXTRA' })]);
  const ev = sh.evaluate(cargaFake(), manifest, { present: ['telegram.extra'], placeholder: [], absent: [] });
  const texto = sh.formatAlert(ev);

  assert.match(texto, /CABLEAR/);
  assert.equal(/REPONER/.test(texto), false,
    'mandar a reponer un secreto que ya esta guardado es trabajo que no resuelve nada');
});

test('CA-7b: el copy NO le pide al operador que borre el archivo de pausa', () => {
  // Borrar `.paused` a mano destruye el marker que distingue una pausa
  // automática de una deliberada — y con él, el auto-levantado. El defecto del
  // copy original (`haltOnConfigCorruption`) es #5232 y no se arregla acá.
  const manifest = manifiestoFake([entrada({ name: 'telegram.bot_token' })]);
  const ev = sh.evaluate(cargaFake(), manifest, { present: [], placeholder: [], absent: ['telegram.bot_token'] });
  const texto = sh.formatAlert(ev);

  assert.equal(/borr[áa]/i.test(texto), false, 'no puede pedir borrar nada');
  assert.equal(texto.includes('.pipeline/.paused'), false);
  assert.match(texto, /se reanuda solo/, 'debe prometer el auto-levantado');
});

test('CA-7c/U2: 20 faltantes producen UN solo aviso, con el corte contado y explicito', () => {
  const entries = [];
  const absent = [];
  for (let i = 0; i < 20; i += 1) {
    entries.push(entrada({
      name: `providers.p${i}.api_key`, service: 'providers', env_var: `P${i}_KEY`,
      restore: `docs/runbooks/credential-rotation.md#proveedor-numero-${i}-con-ancla-larga`,
    }));
    absent.push(`providers.p${i}.api_key`);
  }
  const ev = sh.evaluate(cargaFake(), manifiestoFake(entries), { present: [], placeholder: [], absent });
  assert.equal(ev.counts.missing, 20);

  const texto = sh.formatAlert(ev);
  // Un solo aviso: 20 notificaciones seguidas se archivan sin abrir.
  assert.equal(texto.split('[secrets-health] Revision').length - 1, 1);
  // El corte es explícito y contado, nunca un slice mudo.
  assert.match(texto, /\.\.\. y \d+ secreto\(s\) mas — detalle completo en \.pipeline\/secrets-health\.json/);
  assert.ok(texto.length <= sh.TG_BUDGET, `el aviso (${texto.length}) entra en el presupuesto ${sh.TG_BUDGET}`);
  assert.ok(texto.length < 4000, 'y por debajo del corte duro del transporte');

  const restantes = Number(texto.match(/\.\.\. y (\d+) secreto\(s\) mas/)[1]);
  const mostradas = texto.split('\n').filter((l) => l.startsWith('• ')).length;
  assert.equal(mostradas + restantes, 20, 'el conteo del corte cierra con el total');
});

test('U2: si todo entra en el presupuesto, no aparece marcador de corte', () => {
  const manifest = manifiestoFake([entrada({ name: 'telegram.bot_token' })]);
  const ev = sh.evaluate(cargaFake(), manifest, { present: [], placeholder: [], absent: ['telegram.bot_token'] });
  assert.equal(/secreto\(s\) mas/.test(sh.formatAlert(ev)), false);
});

test('U3: un nombre logico hostil cae al fallback y el JSON sigue siendo parseable', () => {
  const hostiles = [
    `telegram.bot${String.fromCharCode(10)}token`,   // salto de linea: rompe el parseo del canal
    `telegram${String.fromCharCode(0)}.token`,       // NUL
    'telegram.token"; DROP',                          // comillas
    'x'.repeat(200),                                  // desbordado
    '',                                               // vacio
  ];
  for (const name of hostiles) {
    assert.equal(sh.safeLabel(name), '[secreto_invalido]', `${JSON.stringify(name)} debe caer al fallback`);
  }
  // Un nombre sano pasa tal cual.
  assert.equal(sh.safeLabel('telegram.bot_token'), 'telegram.bot_token');

  const dir = tmpDir('u3');
  const jsonPath = path.join(dir, 'secrets-health.json');
  const manifest = manifiestoFake([entrada({ name: `telegram.bot${String.fromCharCode(10)}token` })]);
  const ev = sh.evaluate(cargaFake(), manifest, { present: [], placeholder: [], absent: [] });
  sh.writeHealthJson(ev, jsonPath);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(jsonPath, 'utf8')), 'el JSON no se rompe');
  assert.equal(JSON.parse(fs.readFileSync(jsonPath, 'utf8')).entries[0].name, '[secreto_invalido]');
});

// -----------------------------------------------------------------------------
// CA-6b — contrato de datos que consume #5230
// -----------------------------------------------------------------------------

test('CA-6b: cada entrada del artefacto lleva level, label de texto, service, next_step y ts', () => {
  const dir = tmpDir('contrato');
  const jsonPath = path.join(dir, 'secrets-health.json');
  const manifest = manifiestoFake([
    entrada({ name: 'telegram.bot_token' }),
    entrada({ name: 'telegram.extra', env_var: 'TELEGRAM_EXTRA' }),
  ]);
  const ev = sh.evaluate(cargaFake(), manifest, { present: ['telegram.extra'], placeholder: [], absent: ['telegram.bot_token'] });
  sh.writeHealthJson(ev, jsonPath);

  const payload = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.deepEqual(Object.keys(payload.counts).sort(), ['chain_broken', 'missing', 'ok']);
  for (const e of payload.entries) {
    assert.ok(['ok', 'warn', 'alert'].includes(e.level), 'level del contrato');
    // La información NUNCA sólo por color — por eso `label` es texto.
    assert.equal(typeof e.label, 'string');
    assert.ok(e.label.length > 0);
    assert.equal(typeof e.service, 'string');
    assert.equal(typeof e.next_step, 'string');
    assert.equal(typeof e.ts, 'string');
    assert.ok(['ok', 'missing', 'chain_broken'].includes(e.state));
  }
});

test('CA-6: writeHealthJson con un destino invalido no lanza', () => {
  const manifest = manifiestoFake([entrada({ name: 'telegram.bot_token' })]);
  const ev = sh.evaluate(cargaFake(), manifest, { present: [], placeholder: [], absent: [] });
  let r;
  assert.doesNotThrow(() => { r = sh.writeHealthJson(ev, path.join(tmpDir('bad'), 'no', 'existe', 'x.json')); });
  assert.equal(r.ok, false);
});

test('CA-6: el orden de canales no depende de Telegram — si falla, el marker ya se escribio', () => {
  const dir = tmpDir('orden');
  const pauseFile = path.join(dir, '.paused');
  const manifest = manifiestoFake([entrada({ name: 'telegram.bot_token' })]);
  const ev = sh.evaluate(cargaFake(), manifest, { present: [], placeholder: [], absent: ['telegram.bot_token'] });

  const res = sh.applyHalt(ev, {
    pauseFile,
    partialPause: fakePartialPause(pauseFile),
    pipelineDir: dir,
    logger: () => {},
    sendTelegram: () => { throw new Error('sin token'); },
  });

  assert.equal(res.channels.marker, true, 'el marker se escribio antes que Telegram');
  assert.equal(res.channels.json, true, 'el artefacto tambien');
  assert.equal(res.channels.telegram, false, 'Telegram fallo sin arrastrar al resto');
});

// -----------------------------------------------------------------------------
// Integración con el módulo REAL de pausa
// -----------------------------------------------------------------------------

test('integracion: el marker que chequea applyHalt y el que escribe setFullPause son el mismo archivo', () => {
  // Invariante frágil y silenciosa: `applyHalt` decide la idempotencia mirando
  // `deps.pauseFile` (el `PAUSE_FILE` de pulpo.js) pero delega la escritura en
  // `setFullPause`, que resuelve su propia ruta. Si divergieran, veríamos
  // "no hay pausa" y escribiríamos igual — pisando la pausa deliberada del
  // operador, que es exactamente lo que CA-5 prohíbe.
  const dir = tmpDir('rutas');
  const previo = process.env.PIPELINE_DIR_OVERRIDE;
  process.env.PIPELINE_DIR_OVERRIDE = dir;
  try {
    delete require.cache[require.resolve('../partial-pause')];
    const ppReal = require('../partial-pause');
    const esperado = path.join(dir, '.paused');
    assert.equal(ppReal._paths().PAUSE_FILE, esperado,
      'partial-pause y pulpo.js deben resolver el MISMO .paused');
  } finally {
    if (previo === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
    else process.env.PIPELINE_DIR_OVERRIDE = previo;
    delete require.cache[require.resolve('../partial-pause')];
  }
});

test('integracion: applyHalt + autoRecover con el partial-pause REAL, en un pipelineDir aislado', () => {
  const dir = tmpDir('integracion');
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  const previo = process.env.PIPELINE_DIR_OVERRIDE;
  process.env.PIPELINE_DIR_OVERRIDE = dir;
  try {
    delete require.cache[require.resolve('../partial-pause')];
    const ppReal = require('../partial-pause');
    const pauseFile = ppReal._paths().PAUSE_FILE;

    const manifest = manifiestoFake([entrada({ name: 'telegram.bot_token' })]);
    const ev = sh.evaluate(cargaFake(), manifest, { present: [], placeholder: [], absent: ['telegram.bot_token'] });

    const res = sh.applyHalt(ev, {
      pauseFile, partialPause: ppReal, pipelineDir: dir, logger: () => {},
    });
    assert.equal(res.halted, true, 'el halt se aplico con el modulo real');

    // El marker real tiene que ser legible por el lector real, con nuestra autoría.
    const origen = ppReal.readFullPauseOrigin();
    assert.equal(origen.source, 'secrets-health-halt',
      'readFullPauseOrigin debe reconocer el marker (si no, el auto-recovery es codigo muerto)');

    // Y el paso inverso lo levanta (el estado vivo de este entorno no frena).
    const rec = sh.autoRecover({ pauseFile, partialPause: ppReal, pipelineDir: dir, logger: () => {} });
    assert.equal(rec.recovered, true);
    assert.equal(fs.existsSync(pauseFile), false, 'la pausa quedo levantada');
  } finally {
    if (previo === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
    else process.env.PIPELINE_DIR_OVERRIDE = previo;
    delete require.cache[require.resolve('../partial-pause')];
  }
});

// -----------------------------------------------------------------------------
// SEC-2 / R-4 — el modo --ci no publica el inventario
// -----------------------------------------------------------------------------

test('SEC-2/R-4: el stdout de --ci lleva counts y ningun nombre de secreto', () => {
  // El repo es PUBLICO y en un runner sin secretos TODO reporta faltante:
  // publicar el inventario nominal es entregar un mapa de ataque.
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [MODULE_PATH, '--ci'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    // exit 1 cuando algo frena: la salida sigue siendo la que hay que auditar.
    stdout = e.stdout;
  }
  const payload = JSON.parse(stdout.trim());
  assert.deepEqual(Object.keys(payload).sort(), ['counts', 'halt', 'ok']);
  assert.deepEqual(Object.keys(payload.counts).sort(), ['chain_broken', 'missing', 'ok']);
  assert.equal('entries' in payload, false, 'entries jamas sale en --ci');

  for (const prohibido of ['telegram', 'github', 'providers', 'aws', 'google_drive', 'r2', 'multimedia',
    'bot_token', 'api_key', 'access_key', 'REPONER', 'CABLEAR']) {
    assert.equal(stdout.includes(prohibido), false, `--ci no puede nombrar "${prohibido}"`);
  }
});

// -----------------------------------------------------------------------------
// Robustez del boot — un health-check nunca puede matar al Pulpo
// -----------------------------------------------------------------------------

test('el modulo degrada en vez de lanzar cuando el manifiesto no existe', () => {
  const m = sh.loadManifest({ path: path.join(tmpDir('nomanifest'), 'no-existe.json') });
  assert.deepEqual(m.entries, []);
  const ev = sh.evaluate(cargaFake(), m, { present: [], placeholder: [], absent: [] });
  assert.equal(ev.ok, true);
  assert.equal(ev.halt, false, 'sin manifiesto no se frena el pipeline');
});

test('collectPresence tolera un store ausente o corrupto sin lanzar', () => {
  const dir = tmpDir('storeroto');
  const manifest = manifiestoFake([entrada({ name: 'telegram.bot_token' })]);

  const ausente = sh.collectPresence({ manifest, storePath: path.join(dir, 'no-existe.json'), env: {} });
  assert.deepEqual(ausente.absent, ['telegram.bot_token']);

  const corrupto = path.join(dir, 'roto.json');
  fs.writeFileSync(corrupto, '{no-soy-json');
  assert.doesNotThrow(() => sh.collectPresence({ manifest, storePath: corrupto, env: {} }));
});

test('evaluate tolera entradas basura del manifiesto sin lanzar', () => {
  const manifest = { entries: [null, undefined, {}, { name: '' }, entrada()] };
  let ev;
  assert.doesNotThrow(() => { ev = sh.evaluate(cargaFake(), manifest, { present: [], placeholder: [], absent: [] }); });
  assert.equal(ev.entries.length, 1, 'solo la entrada valida se evalua');
});

test('evaluate es puro: no muta sus entradas', () => {
  const manifest = manifiestoFake([entrada({ name: 'telegram.bot_token' })]);
  const presence = { present: [], placeholder: [], absent: ['telegram.bot_token'] };
  const load = cargaFake();
  const snapshot = JSON.stringify({ manifest, presence, load });
  sh.evaluate(load, manifest, presence);
  assert.equal(JSON.stringify({ manifest, presence, load }), snapshot);
});

// -----------------------------------------------------------------------------
// CA-14 / R-6 — el estado vivo no puede haltear el primer boot post-merge
// -----------------------------------------------------------------------------

test('CA-14/R-6: los tres skipped_empty sanos por diseno no frenan el pipeline', () => {
  // Estado vivo verificado en este ciclo: TELEGRAM_LEO_OPERATOR_CHAT_ID
  // (service_active con telegram activo → degrada, no frena),
  // ANTHROPIC_API_KEY (required_when never → ok) y ANTHROPIC_AUTH_TOKEN
  // (service_active con el grupo providers.moonshot inactivo → ok).
  const manifest = manifiestoFake([
    entrada({ name: 'telegram.bot_token' }),
    entrada({ name: 'telegram.chat_id', env_var: 'TELEGRAM_CHAT_ID' }),
    entrada({ name: 'telegram.leo_operator_chat_id', env_var: 'TELEGRAM_LEO_OPERATOR_CHAT_ID', required_when: 'service_active' }),
    entrada({ name: 'providers.anthropic.api_key', service: 'providers', env_var: 'ANTHROPIC_API_KEY', required_when: 'never' }),
    entrada({ name: 'providers.moonshot.api_key', service: 'providers', env_var: 'ANTHROPIC_AUTH_TOKEN', required_when: 'service_active' }),
    entrada({ name: 'providers.openai.api_key', service: 'providers', env_var: 'OPENAI_API_KEY', required_when: 'service_active' }),
  ]);
  const ev = sh.evaluate(
    cargaFake({
      hydrated: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'OPENAI_API_KEY'],
      skipped_empty: ['TELEGRAM_LEO_OPERATOR_CHAT_ID', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    }),
    manifest,
    {
      present: ['telegram.bot_token', 'telegram.chat_id', 'providers.openai.api_key'],
      placeholder: [],
      absent: ['telegram.leo_operator_chat_id', 'providers.anthropic.api_key', 'providers.moonshot.api_key'],
    },
  );

  assert.equal(porNombre(ev, 'providers.anthropic.api_key').state, 'ok');
  assert.equal(porNombre(ev, 'providers.moonshot.api_key').state, 'ok');
  assert.equal(porNombre(ev, 'telegram.leo_operator_chat_id').level, 'warn');
  assert.equal(ev.halt, false, 'el primer boot post-merge NO puede quedar pausado sobre esto');
});

test('CA-5: un always genuinamente ausente SI frena', () => {
  const manifest = manifiestoFake([entrada({ name: 'telegram.bot_token', required_when: 'always' })]);
  const ev = sh.evaluate(cargaFake(), manifest, { present: [], placeholder: [], absent: ['telegram.bot_token'] });
  assert.equal(ev.halt, true);
  assert.equal(porNombre(ev, 'telegram.bot_token').level, 'alert');
  assert.match(sh.formatAlert(ev), /PAUSADO/);
});
