'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  load, validate, listByService, isMetadataKey,
  findEnvVarReaders, loadProductionSources,
} = require('../secrets-manifest');
const { ENV_MAPPING, loadIntoEnv } = require('../credentials');
const {
  SYSTEM_ALLOWLIST, CREDENTIAL_SCOPES, SCOPES_ALWAYS_ON,
} = require('../build-child-env');
const {
  SECRET_VALUE_PATTERNS, shannonEntropy, HIGH_ENTROPY_THRESHOLD,
} = require('../redact');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MANIFEST_PATH = path.join(ROOT, '.pipeline', 'secrets-manifest.json');
const RUNBOOK_PATH = path.join(ROOT, 'docs', 'runbooks', 'credential-rotation.md');
const MODULE_PATH = path.join(ROOT, '.pipeline', 'lib', 'secrets-manifest.js');
const manifest = load({ path: MANIFEST_PATH });
const runbook = fs.readFileSync(RUNBOOK_PATH, 'utf8');

const fakeCredentialStore = {
  _version: 1,
  telegram: {
    bot_token: 'fake-bot-token',
    chat_id: '100000',
    leo_operator_chat_id: '200000',
  },
  providers: {
    openai: { api_key: 'fake-openai' },
    anthropic: { api_key: 'fake-anthropic' },
    google: { api_key: 'fake-google' },
    cerebras: { api_key: 'fake-cerebras' },
    nvidia: { api_key: 'fake-nvidia' },
    moonshot: { api_key: 'fake-moonshot' },
  },
  google_drive: {
    _note: 'metadata',
    drive_folder_id: 'fake-folder',
    oauth_client_id: 'fake-client',
    oauth_client_secret: 'fake-secret',
    oauth_refresh_token: 'fake-refresh',
  },
  aws: {
    _principal: 'metadata',
    access_key_id: 'fake-aws',
    secret_access_key: 'fake-aws-secret',
    region: 'fake-region',
    profile: 'fake-profile',
    table_name: 'fake-table',
    coordination_table_name: 'fake-coordination-table',
  },
  multimedia: {
    elevenlabs_api_key: 'fake-elevenlabs',
    elevenlabs_voice_id: 'fake-voice',
  },
};

function leafDotPaths(value, prefix = '') {
  return Object.entries(value).flatMap(([key, child]) => {
    const dotPath = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === 'object' && !Array.isArray(child)
      ? leafDotPaths(child, dotPath)
      : [dotPath];
  });
}

function githubSlug(heading) {
  return heading.toLowerCase().trim()
    .replace(/[^\w\- ]+/g, '')
    .replace(/\s/g, '-');
}

function headingsBySlug(markdown) {
  return new Map(markdown.split(/\r?\n/)
    .map((line) => /^(#{1,6})\s+(.+)$/.exec(line))
    .filter(Boolean)
    .map((match) => [githubSlug(match[2]), match[2]]));
}

test('el manifiesto cubre los 7 servicios y cada restore resuelve a un ancla existente del runbook', () => {
  const grouped = listByService(manifest);
  assert.deepEqual(Object.keys(grouped).sort(), [
    'aws', 'github', 'google_drive', 'multimedia', 'providers', 'r2', 'telegram',
  ]);
  const headings = headingsBySlug(runbook);
  for (const entry of manifest.entries.filter((item) => item.restore.startsWith('docs/'))) {
    const [file, slug] = entry.restore.split('#');
    assert.equal(file, 'docs/runbooks/credential-rotation.md');
    assert.ok(headings.has(slug), `${entry.name}: no existe #${slug}`);
  }
});

test('ningun heading nuevo del runbook genera un slug con doble guion', () => {
  const expected = [
    'Telegram (reposicion)', 'AWS (reposicion)', 'Google Drive (reposicion)',
    'Cloudflare R2 (reposicion)', 'Multimedia ElevenLabs (reposicion)',
  ];
  for (const heading of expected) {
    assert.match(runbook, new RegExp(`^## ${heading.replace(/[()]/g, '\\$&')}$`, 'm'));
    assert.doesNotMatch(heading, /[/:,áéíóú]/i);
    assert.doesNotMatch(githubSlug(heading), /--/);
  }
});

test('las 5 secciones de reposicion existen y declaran deslinde con rotacion', () => {
  const sections = runbook.split(/^## /m).filter((section) => /\(reposicion\)/.test(section));
  assert.equal(sections.length, 5);
  for (const section of sections) {
    assert.match(section, /rotar/i);
    assert.match(section, /ausente/i);
  }
});

test('ninguna entrada expone referencias archivo:linea', () => {
  assert.doesNotMatch(JSON.stringify(manifest.entries), /\.(?:js|kt|ps1|sh):\d+/i);
});

test('toda entrada required_when=never tiene justificacion en prosa', () => {
  const never = manifest.entries.filter((entry) => entry.required_when === 'never');
  assert.ok(never.length >= 3);
  for (const entry of never) {
    assert.ok(entry.restore.length >= 40, entry.name);
    assert.doesNotMatch(entry.restore, /^docs\//);
  }
  assert.match(manifest.entries.find((entry) => entry.name === 'providers.anthropic.api_key').restore, /NO REPONER/);
});

test('la precedencia declara intrale-api-keys como fuente conocida no canonica', () => {
  const known = manifest._precedence.known_non_canonical;
  assert.ok(known.some((item) => item.path === '~/.intrale-api-keys.json'
    && /NO canonica/i.test(item.estado)));
});

test('las 12 huerfanas estan declaradas y ninguna es eager', () => {
  // Ancla actualizada por #5217 (CA-6). #5242 habia pasado las cuatro
  // `google_drive.*` a `eager` con esta premisa: «el nivel 2 (store) del
  // consumidor resuelve via `loadIntoEnv`, o sea via ENV_MAPPING, asi que
  // dejarlas `deferred` rompe la subida de evidencia de QA en los DOS niveles».
  // La premisa era cierta ENTONCES y dejo de serlo: #5217 reescribio ese nivel
  // sobre `resolveScopedRefs`, que lee el namespace `google_drive` directo del
  // JSON del store sin pasar por `process.env`. Con el consumo desacoplado de
  // la hidratacion, el pilar (ii) ya no las sostiene como `eager` y mantenerlas
  // solo publicaria un refresh token de Google en el entorno de todo agente
  // hijo. No es una relajacion de CA-3: es la misma regla sobre un dato que
  // volvio a cambiar. La cobertura de que Drive SIGUE resolviendo esta en
  // `qa/scripts/__tests__/qa-video-share-credentials.test.js`, no aca.
  const orphanNames = [
    'google_drive.drive_folder_id', 'google_drive.oauth_client_id',
    'google_drive.oauth_client_secret', 'google_drive.oauth_refresh_token',
    'aws.access_key_id', 'aws.secret_access_key', 'aws.region', 'aws.profile',
    'aws.table_name', 'aws.coordination_table_name',
    'multimedia.elevenlabs_api_key', 'multimedia.elevenlabs_voice_id',
  ];
  const entries = orphanNames.map((name) => manifest.entries.find((entry) => entry.name === name));
  assert.ok(entries.every(Boolean));
  assert.deepEqual(entries.filter((entry) => entry.hydration === 'eager').map((entry) => entry.name), []);
  assert.equal(entries.filter((entry) => entry.hydration === 'deferred').length, 12);
  // El ancla del lado de ENV_MAPPING: ninguna de las 12 se cuela en el mapa
  // derivado. Cubre a las cuatro `google_drive.*` (desacopladas por #5217) y a
  // las `aws.*` / `multimedia.*`, donde el pilar (ii) sigue sin cumplirse.
  for (const entry of entries.filter((item) => item.hydration === 'deferred')) {
    assert.equal(ENV_MAPPING[entry.name], undefined, entry.name);
  }
  // Anti-vacuidad: el bucle de arriba seria trivialmente verde si `ENV_MAPPING`
  // estuviera vacio o mal importado. Las que SI se hidratan siguen cableadas
  // con el nombre exacto que espera cada consumidor.
  assert.equal(ENV_MAPPING['telegram.bot_token'], 'TELEGRAM_BOT_TOKEN');
  assert.equal(ENV_MAPPING['providers.openai.api_key'], 'OPENAI_API_KEY');
  // Y el env var canonico de Drive sigue declarado en el manifiesto aunque no
  // se hidrate: es el override operativo que el consumidor consulta primero.
  const folder = entries.find((entry) => entry.name === 'google_drive.drive_folder_id');
  assert.equal(folder.env_var, 'GOOGLE_DRIVE_FOLDER_ID');
});

test('toda entrada deferred tiene defer_reason de al menos 40 caracteres', () => {
  for (const entry of manifest.entries.filter((item) => item.hydration === 'deferred')) {
    assert.ok(entry.defer_reason.length >= 40, entry.name);
  }
});

test('la invariante bidireccional relaciona store eager con ENV_MAPPING y excluye metadata por patron', () => {
  const storeNames = leafDotPaths(fakeCredentialStore)
    .filter((name) => !isMetadataKey(name)).sort();
  const manifestStoreNames = manifest.entries
    .filter((entry) => entry.source === 'store')
    .map((entry) => entry.name).sort();
  const mappedNames = Object.keys(ENV_MAPPING).sort();
  const eagerNames = manifest.entries
    .filter((entry) => entry.source === 'store' && entry.hydration === 'eager')
    .map((entry) => entry.name).sort();
  assert.deepEqual(storeNames, manifestStoreNames);
  assert.deepEqual(eagerNames, mappedNames);
  for (const entry of manifest.entries.filter((item) => item.hydration === 'deferred')) {
    assert.equal(ENV_MAPPING[entry.name], undefined, entry.name);
  }
  assert.equal(isMetadataKey('aws._note'), true);
  assert.equal(isMetadataKey('aws.access_key_id'), false);
  assert.doesNotMatch(isMetadataKey.toString(), /_note|_version|_principal/);
});

test('el childEnv real no expone ninguna credencial deferred', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-child-env-'));
  const canonical = path.join(tmp, 'credentials.json');
  const legacy = path.join(tmp, 'legacy.json');
  const deferred = manifest.entries.filter((item) => item.hydration === 'deferred');
  assert.equal(deferred.length, 12);
  assert.ok(deferred.every((entry) => leafDotPaths(fakeCredentialStore).includes(entry.name)));
  fs.writeFileSync(canonical, JSON.stringify(fakeCredentialStore));
  try {
    const parentEnv = {};
    loadIntoEnv({ canonicalPath: canonical, legacyPath: legacy, env: parentEnv, logger: () => {} });
    const pipelineExtras = { PIPELINE_ISSUE: '5242' };
    const childEnv = { ...parentEnv, ...pipelineExtras };
    // Control positivo (obligatorio por CA-3d): sin esto el test pasa por
    // vacuidad si `loadIntoEnv` no hidrata nada. #5242 lo habia ampliado a las
    // cuatro `google_drive.*` porque entonces SI debian llegar al hijo; #5217
    // las saca del env global (CA-6), asi que ahora las cubre el bucle de
    // `deferred` de abajo y el control positivo vuelve a apoyarse en las que
    // siguen hidratandose. Se usan DOS servicios distintos para que el ancla no
    // dependa de una sola rama de `ENV_MAPPING`.
    assert.equal(childEnv.TELEGRAM_BOT_TOKEN, 'fake-bot-token');
    assert.equal(childEnv.OPENAI_API_KEY, 'fake-openai');
    for (const entry of manifest.entries.filter((item) => item.hydration === 'deferred')) {
      assert.equal(childEnv[entry.env_var], undefined, entry.env_var);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('toda entrada source=store declara consumer_status del enum y broken exige blocked_by', () => {
  const enumerado = ['resolved', 'broken', 'no_consumer'];
  for (const entry of manifest.entries) {
    if (entry.source === 'store') {
      assert.ok(enumerado.includes(entry.consumer_status), `${entry.name}: ${entry.consumer_status}`);
    } else {
      assert.equal('consumer_status' in entry, false, entry.name);
    }
    if (entry.consumer_status === 'broken') assert.match(entry.blocked_by, /^#\d+$/, entry.name);
    else assert.equal('blocked_by' in entry, false, entry.name);
  }
  // El ancla es deepEqual (no `length >= 0`) para que declarar algo `broken`
  // siga siendo un cambio visible y deliberado. Las dos claves AWS entran acá
  // en esta pasada: tienen dos consumidores fail-closed reales
  // (secret-vault.js:514, provisioner-infra.js:447) que no pueden resolverlas
  // porque su hydration es `deferred`. Antes se publicaban `no_consumer`, que
  // era falso. Ambas cierran con #5040 (activar `env_isolation_enabled`), que
  // es lo que permite hidratarlas sin exponerlas a todos los agentes hijos.
  const rotas = manifest.entries
    .filter((entry) => entry.consumer_status === 'broken')
    .map((entry) => [entry.name, entry.blocked_by]);
  assert.deepEqual(rotas, [
    ['aws.access_key_id', '#5040'],
    ['aws.secret_access_key', '#5040'],
  ]);
  const sinStatus = structuredClone(manifest);
  delete sinStatus.entries.find((entry) => entry.name === 'telegram.bot_token').consumer_status;
  assert.equal(validate(sinStatus).ok, false);
  // El candado de `broken => blocked_by` NO puede quedar sin ejercitar solo
  // porque hoy no hay ninguna entrada rota: se ejerce contra una entrada
  // sintetica. Sin esto, la regla se apagaria en silencio y la proxima entrada
  // `broken` entraria sin issue que la cierre.
  const conRota = structuredClone(manifest);
  const rota = conRota.entries.find((entry) => entry.name === 'google_drive.oauth_client_id');
  rota.consumer_status = 'broken';
  rota.blocked_by = '#4890';
  delete rota.consumers;
  assert.equal(validate(conRota).ok, true);
  const sinBlockedBy = structuredClone(conRota);
  delete sinBlockedBy.entries.find((entry) => entry.name === 'google_drive.oauth_client_id').blocked_by;
  assert.equal(validate(sinBlockedBy).ok, false);
  // Y `blocked_by` mal formado tampoco pasa (la forma `#\d+` es parte del CA).
  const blockedByInvalido = structuredClone(conRota);
  blockedByInvalido.entries.find((entry) => entry.name === 'google_drive.oauth_client_id').blocked_by = '4890';
  assert.equal(validate(blockedByInvalido).ok, false);
});

test('ningun defer_reason afirma que el consumo funciona si su consumer_status es broken', () => {
  // El candado no puede quedarse en el largo minimo: el texto falso de rev-3 tenia
  // 100+ chars. Se combina una lista negra de afirmaciones de consumo sano con la
  // exigencia positiva de declarar el estado roto y el issue que lo cierra.
  const afirmaQueFunciona = /ya funciona|funciona hoy|fallback legacy|fallback vigente|resuelve por fallback|no desbloquea ning[uú]n consumo/i;
  // Regla unica, aplicada tanto a las entradas reales como a las sinteticas.
  const cumpleCandado = (entry) => !afirmaQueFunciona.test(entry.defer_reason)
    && /vac[ií]a?o?|roto/i.test(entry.defer_reason)
    && entry.defer_reason.includes(entry.blocked_by);

  const rotas = manifest.entries.filter((entry) => entry.consumer_status === 'broken');
  for (const entry of rotas) assert.ok(cumpleCandado(entry), entry.name);

  // El bucle de arriba ahora SI recorre entradas reales (las dos AWS). Los
  // fixtures sinteticos de abajo se mantienen igual: cubren los casos que el
  // manifiesto real no tiene (afirmacion de consumo sano, defer_reason que no
  // nombra su blocked_by) y mantienen el candado vivo aunque manana vuelva a
  // quedar en cero.
  assert.equal(rotas.length, 2);
  assert.equal(cumpleCandado({
    defer_reason: 'El consumo esta roto: la cadena de resolucion no llega al consumidor. Se difiere por postura de seguridad, no porque el consumo este resuelto. Cierra #4890.',
    blocked_by: '#4890',
  }), true);
  assert.equal(cumpleCandado({
    defer_reason: 'Credencial OAuth con fallback legacy vigente; el consumo ya funciona sin cablearla. Ver #4890 para el detalle completo del caso.',
    blocked_by: '#4890',
  }), false, 'una afirmacion de consumo sano debe ser rechazada');
  assert.equal(cumpleCandado({
    defer_reason: 'El consumo esta roto y el consumidor no puede leer la clave; se difiere por postura de seguridad hasta nuevo aviso.',
    blocked_by: '#4890',
  }), false, 'un defer_reason que no nombra su blocked_by debe ser rechazado');
  // Control positivo: el candado atrapa el texto que rev-3 llego a publicar en
  // esta misma rama. Sin esto, una lista negra desalineada pasa por vacuidad.
  const publicadoEnRev3 = [
    'Credencial OAuth con fallback legacy vigente; se difiere hasta habilitar el aislamiento de entorno #5040.',
    'Secreto OAuth con fallback legacy vigente; hidratarlo hoy lo expondria a todos los hijos del Pulpo.',
    'Token OAuth no expirante con fallback legacy; se difiere hasta que #5040 aisle el entorno de cada hijo.',
  ];
  for (const texto of publicadoEnRev3) assert.match(texto, afirmaQueFunciona);
});

test('el conjunto nominal de consumer_status=resolved esta anclado', () => {
  // Espejo del ancla que ya tiene `broken`. Sin este deepEqual, marcar una clave
  // como `resolved` no cuesta nada: asi paso `providers.google.api_key`
  // (rev-4) por 18 tests verdes declarando un consumidor que no existe.
  const resueltas = manifest.entries
    .filter((entry) => entry.consumer_status === 'resolved')
    .map((entry) => entry.name);
  assert.deepEqual(resueltas, [
    'telegram.bot_token',
    'telegram.chat_id',
    'telegram.leo_operator_chat_id',
    'providers.openai.api_key',
    'providers.anthropic.api_key',
    'providers.cerebras.api_key',
    'providers.nvidia.api_key',
    'providers.moonshot.api_key',
    'google_drive.drive_folder_id',
    'google_drive.oauth_client_id',
    'google_drive.oauth_client_secret',
    'google_drive.oauth_refresh_token',
  ]);
});

test('consumer_status es ortogonal a required_when: el par resolved+never es expresable', () => {
  // Este test REEMPLAZA al assert que exigia `resolved => required_when !=
  // never`. Aquel candado hacia INEXPRESABLE el estado "tiene consumidor real
  // pero por politica no se aprovisiona" y empujaba a declarar `no_consumer`
  // una clave con lectores — que es exactamente como
  // `providers.anthropic.api_key` termino publicada con una afirmacion falsa.
  // SR5 declara los tres ejes ortogonales; el schema debe poder expresarlo.
  const anthropic = manifest.entries.find((e) => e.name === 'providers.anthropic.api_key');
  assert.equal(anthropic.consumer_status, 'resolved');
  assert.equal(anthropic.required_when, 'never');
  // Y el par sigue siendo valido para el loader, no solo para este archivo.
  assert.equal(validate(manifest).ok, true);

  // Control negativo: el loader NO debe aceptar `resolved` sin nombrar lectores.
  // Sin esto, "resolved" vuelve a ser una opinion que nadie puede auditar.
  const sinConsumers = structuredClone(manifest);
  delete sinConsumers.entries.find((e) => e.name === 'providers.anthropic.api_key').consumers;
  const roto = validate(sinConsumers);
  assert.equal(roto.ok, false);
  assert.match(roto.errors.join(' '), /consumers es obligatorio/);
});

test('todo consumer_status=resolved nombra consumidores que existen en el repo', () => {
  const resueltas = manifest.entries.filter((entry) => entry.consumer_status === 'resolved');
  assert.ok(resueltas.length >= 9);
  for (const entry of resueltas) {
    assert.ok(Array.isArray(entry.consumers) && entry.consumers.length > 0, entry.name);
    for (const ref of entry.consumers) {
      assert.ok(fs.existsSync(path.join(ROOT, ref)), `${entry.name}: no existe ${ref}`);
    }
  }
});

test('toda clave providers.* resolved esta declarada en credentials_env de agent-models', () => {
  // El candado con dientes: `resolved` no es una opinion, es verificable contra
  // el artefacto que cablea los providers. gemini-google autentica por OAuth via
  // `agy` y NO declara credentials_env, por eso su api_key no puede ser resolved.
  const models = JSON.parse(fs.readFileSync(path.join(ROOT, '.pipeline', 'agent-models.json'), 'utf8'));
  const declaradas = new Set(Object.values(models.providers || {})
    .flatMap((provider) => provider.credentials_env || []));
  assert.ok(declaradas.size >= 4, `credentials_env vacio o no parseado: ${declaradas.size}`);

  const resueltasDeProviders = manifest.entries
    .filter((entry) => entry.service === 'providers' && entry.consumer_status === 'resolved');
  // 5 = openai, anthropic, cerebras, nvidia, moonshot. `anthropic` entro al
  // conjunto al corregir su `no_consumer` falso: su `ANTHROPIC_API_KEY` si
  // figura en `credentials_env`, asi que el candado la acepta sin aflojarse.
  assert.deepEqual(resueltasDeProviders.map((entry) => entry.name), [
    'providers.openai.api_key',
    'providers.anthropic.api_key',
    'providers.cerebras.api_key',
    'providers.nvidia.api_key',
    'providers.moonshot.api_key',
  ]);
  for (const entry of resueltasDeProviders) {
    assert.ok(declaradas.has(entry.env_var),
      `${entry.name}: ${entry.env_var} no figura en ningun credentials_env`);
  }
  // Control negativo: revertir google a resolved tiene que romper este candado.
  const revertida = structuredClone(manifest);
  const google = revertida.entries.find((entry) => entry.name === 'providers.google.api_key');
  assert.equal(google.consumer_status, 'no_consumer');
  assert.equal(google.required_when, 'never');
  google.consumer_status = 'resolved';
  const rotas = revertida.entries
    .filter((entry) => entry.service === 'providers' && entry.consumer_status === 'resolved')
    .filter((entry) => !declaradas.has(entry.env_var))
    .map((entry) => entry.name);
  assert.deepEqual(rotas, ['providers.google.api_key']);
});

test('ningun provider fail-fast puede declararse no_consumer/never en el manifiesto', () => {
  // Candado INVERSO del anterior. El directo (resolved subconjunto de
  // credentials_env) es unidireccional: impide INVENTAR un consumidor, pero no
  // impide OCULTAR uno real. Por ese hueco paso `providers.moonshot.api_key`
  // declarada never/no_consumer con 20 tests verdes, siendo el ultimo eslabon
  // vivo de las cadenas de fallback de `review` y `po`. `build-child-env` trata
  // a todo provider con auth_mode != 'oauth' por el camino api_key: EXIGE su
  // credentials_env y hace throw si falta, o sea que el consumidor existe y es
  // fail-fast. Declararlo "no reponer" deja al health-check del TRAMO 2 (#5243)
  // reportando verde sobre una cadena que no puede lanzar.
  const models = JSON.parse(fs.readFileSync(path.join(ROOT, '.pipeline', 'agent-models.json'), 'utf8'));

  // Espejo exacto de la condicion de build-child-env: la AUSENCIA de auth_mode
  // cae al camino api_key (default-safe), no al de oauth.
  const exigenKey = Object.entries(models.providers || {})
    .filter(([, provider]) => provider.auth_mode !== 'oauth')
    .flatMap(([nombre, provider]) => {
      const declarada = provider.credentials_env;
      const vars = Array.isArray(declarada) ? declarada : (declarada ? [declarada] : []);
      return vars.map((envVar) => [nombre, envVar]);
    });
  // Ancla del universo cubierto: sin esto el filtro puede quedar vacio y el
  // candado pasar por vacuidad.
  assert.deepEqual(exigenKey, [
    ['cerebras', 'CEREBRAS_API_KEY'],
    ['nvidia-nim', 'NVIDIA_NIM_API_KEY'],
    ['kimi-moonshot', 'ANTHROPIC_AUTH_TOKEN'],
  ]);

  const ocultaConsumidor = (entries) => {
    const porEnvVar = new Map(entries.map((entry) => [entry.env_var, entry]));
    return exigenKey.filter(([, envVar]) => {
      const entry = porEnvVar.get(envVar);
      return !entry
        || entry.consumer_status === 'no_consumer'
        || entry.required_when === 'never';
    }).map(([nombre]) => nombre);
  };

  assert.deepEqual(ocultaConsumidor(manifest.entries), [],
    'provider fail-fast declarado sin consumidor / no reponible en el manifiesto');

  // Control negativo: volver moonshot a lo que publico la pasada rechazada
  // tiene que romper este candado. Sin esto, el candado no prueba nada.
  const revertida = structuredClone(manifest);
  const moonshot = revertida.entries.find((entry) => entry.name === 'providers.moonshot.api_key');
  assert.equal(moonshot.consumer_status, 'resolved');
  assert.equal(moonshot.required_when, 'service_active');
  moonshot.consumer_status = 'no_consumer';
  moonshot.required_when = 'never';
  assert.deepEqual(ocultaConsumidor(revertida.entries), ['kimi-moonshot']);
});

test('ninguna entrada con lector real en el repo puede declararse no_consumer', () => {
  // Candado GENERALIZADO. Los dos anteriores estan acotados a `service ===
  // providers` y `auth_mode !== oauth`: por construccion no pueden ver
  // `telegram.*` ni los providers OAuth, y por ese hueco se publicaron como
  // `no_consumer` `telegram.leo_operator_chat_id` (el allowlist de firma
  // fail-closed de GATE 2) y `providers.anthropic.api_key`, con 21 tests en
  // verde. Este candado no pregunta por servicio ni por auth_mode: barre el
  // codigo de produccion del repo y, si alguien LEE la env var, prohibe
  // declararla sin consumidor.
  //
  // SIN acotar por `hydration`. La pasada anterior lo acoto a `eager` con esta
  // premisa: «una entrada deferred nunca llega al process.env del Pulpo, asi
  // que un lector suyo no se alcanza hoy; es el caso de las AWS, cuyo scope
  // esta inerte porque ningun skill declara requires_credentials». La premisa
  // es FALSA y se retira: `DEFAULT_REQUIRES_BY_SKILL` declara el scope `aws`
  // para `backend-dev` y `qa` (build-child-env.js:218,228) y agent-models.json
  // no lo sobreescribe, asi que el scope NO esta inerte. Con ese acotamiento,
  // `aws.access_key_id` y `aws.secret_access_key` se publicaron `no_consumer`
  // teniendo dos lectores fail-closed (secret-vault.js:514,
  // provisioner-infra.js:447) — la misma clase de afirmacion falsa, una capa
  // mas abajo. `deferred` explica por que el consumo esta ROTO (`broken` +
  // `blocked_by`), no autoriza a negar que el consumidor exista.
  const sources = loadProductionSources(ROOT);
  assert.ok(sources.length > 100, `barrido vacio o mal enraizado: ${sources.length}`);

  const conLectorReal = (entries) => entries
    .map((entry) => ({ entry, lectores: findEnvVarReaders(entry.env_var, { files: sources }) }))
    .filter(({ entry, lectores }) => lectores.length > 0 && entry.consumer_status === 'no_consumer')
    .map(({ entry }) => entry.name);

  assert.deepEqual(conLectorReal(manifest.entries), [],
    'entrada declarada no_consumer teniendo lectores en codigo de produccion');

  // Ancla anti-vacuidad: el barrido tiene que estar encontrando lectores de
  // verdad. Sin esto, una regex rota deja el candado verde para siempre.
  //
  // La lista se amplio de 4 a 6 en #5211. NO es un relajamiento del candado: el
  // ancla enumera lo que el barrido ENCUENTRA en el repo, no un maximo
  // permitido, y #5628 sumo dos lectores reales de la env var
  // (notify-telegram.js:83, que ancla el ruteo privado fail-closed, y
  // vault-shadow-metrics.js:293,302, que la usa como destino de los avisos
  // privados de la ventana vault) sin declararlos en el manifiesto. Mientras el
  // ancla siguio clavada en los 4 viejos, este assert fallaba describiendo mal
  // el repo. El candado real -que ningun lector quede sin declarar- no se toca:
  // se arregla en el manifiesto sumando ambos a `consumers`, no aca.
  assert.deepEqual(
    findEnvVarReaders('TELEGRAM_LEO_OPERATOR_CHAT_ID', { files: sources }),
    [
      '.pipeline/delivery.js',
      '.pipeline/lib/notify-telegram.js',
      '.pipeline/lib/operator-gate.js',
      '.pipeline/lib/telegram-notifier.js',
      '.pipeline/lib/vault-shadow-metrics.js',
      '.pipeline/pulpo.js',
    ],
  );
  // Y una env var que de verdad no tiene lector sigue pudiendo ser no_consumer:
  // el candado prohibe ocultar consumidores, no obliga a inventarlos.
  assert.deepEqual(findEnvVarReaders('GEMINI_API_KEY', { files: sources }), []);

  // Control negativo 1: revertir leo_operator_chat_id a lo que publico la
  // pasada rechazada tiene que romper el candado.
  const revertidaTelegram = structuredClone(manifest);
  const leo = revertidaTelegram.entries.find((e) => e.name === 'telegram.leo_operator_chat_id');
  assert.equal(leo.consumer_status, 'resolved');
  assert.notEqual(leo.required_when, 'never');
  leo.consumer_status = 'no_consumer';
  assert.deepEqual(conLectorReal(revertidaTelegram.entries), ['telegram.leo_operator_chat_id']);

  // Control negativo 2: idem para anthropic, el provider OAuth que el candado
  // acotado a `auth_mode !== oauth` no podia ver.
  const revertidaAnthropic = structuredClone(manifest);
  const anthropic = revertidaAnthropic.entries.find((e) => e.name === 'providers.anthropic.api_key');
  assert.equal(anthropic.consumer_status, 'resolved');
  anthropic.consumer_status = 'no_consumer';
  assert.deepEqual(conLectorReal(revertidaAnthropic.entries), ['providers.anthropic.api_key']);

  // Control negativo 3: la entrada `deferred` que el acotamiento a `eager`
  // dejaba fuera. Sin quitar ese filtro este assert no puede fallar nunca, asi
  // que es el que prueba que el candado de verdad se amplio.
  const revertidaAws = structuredClone(manifest);
  const accessKey = revertidaAws.entries.find((e) => e.name === 'aws.access_key_id');
  const secretKey = revertidaAws.entries.find((e) => e.name === 'aws.secret_access_key');
  assert.equal(accessKey.hydration, 'deferred');
  assert.equal(accessKey.consumer_status, 'broken');
  assert.equal(secretKey.consumer_status, 'broken');
  accessKey.consumer_status = 'no_consumer';
  delete accessKey.blocked_by;
  assert.deepEqual(conLectorReal(revertidaAws.entries), ['aws.access_key_id']);
});

test('los consumers declarados no omiten ningun lector que el barrido encuentra', () => {
  // El defecto de la pasada anterior no fue solo el `consumer_status`: la prosa
  // describia UN consumidor (el handler opcional) y omitia los cuatro
  // restantes, incluido el gate de firma. Declarar de menos es la misma clase
  // de afirmacion falsa que declarar de mas.
  const sources = loadProductionSources(ROOT);
  const omisiones = [];
  for (const entry of manifest.entries.filter((item) => Array.isArray(item.consumers))) {
    const declarados = new Set(entry.consumers);
    for (const lector of findEnvVarReaders(entry.env_var, { files: sources })) {
      if (!declarados.has(lector)) omisiones.push(`${entry.name} omite ${lector}`);
    }
  }
  assert.deepEqual(omisiones, []);
});

test('regresion nominal de las cuatro claves google_drive', () => {
  const actual = Object.fromEntries(manifest.entries
    .filter((entry) => entry.name.startsWith('google_drive.'))
    .map((entry) => [entry.name, entry.env_var]));
  assert.deepEqual(actual, {
    'google_drive.drive_folder_id': 'GOOGLE_DRIVE_FOLDER_ID',
    'google_drive.oauth_client_id': 'GOOGLE_OAUTH_CLIENT_ID',
    'google_drive.oauth_client_secret': 'GOOGLE_OAUTH_CLIENT_SECRET',
    'google_drive.oauth_refresh_token': 'GOOGLE_OAUTH_REFRESH_TOKEN',
  });
});

test('ningun shape publica literales largos fuera de prefijos conocidos', () => {
  const allowed = ['AKIA', 'GOCSPX-', 'sk-ant-', 'sk-proj-', 'AIza', 'ghp_', 'gho_', 'ya29'];
  for (const entry of manifest.entries.filter((item) => item.shape)) {
    let shape = entry.shape;
    for (const prefix of allowed) shape = shape.replaceAll(prefix, '');
    shape = shape.replace(/\[[^\]]+\]/g, '').replace(/\\[dws]/g, '');
    const literals = shape.match(/[A-Za-z0-9_/-]{9,}/g) || [];
    assert.deepEqual(literals, [], `${entry.name}: ${literals.join(', ')}`);
  }
});

test('el manifiesto y las secciones nuevas del runbook no contienen valores de secreto', () => {
  const newSections = runbook.slice(runbook.indexOf('## Telegram (reposicion)'),
    runbook.indexOf('## Si algo sale mal'));
  const publicText = `${fs.readFileSync(MANIFEST_PATH, 'utf8')}\n${newSections}`;
  for (const { name, re } of SECRET_VALUE_PATTERNS.filter((pattern) => !pattern.topology)) {
    re.lastIndex = 0;
    assert.equal(re.test(publicText), false, `patron de secreto detectado: ${name}`);
  }
  const opaque = publicText.match(/[A-Za-z0-9_./+=-]{41,}/g) || [];
  const suspicious = opaque.filter((token) => !/[{[\]\\^$*]/.test(token)
    && shannonEntropy(token) >= HIGH_ENTROPY_THRESHOLD);
  assert.deepEqual(suspicious, []);
  for (const placeholder of ['AKIAIOSFODNN7EXAMPLE', 'sk-ant-PLACEHOL', 'AIzaSyTest_123']) {
    assert.ok(shannonEntropy(placeholder) < HIGH_ENTROPY_THRESHOLD || placeholder.length < 41);
  }
});

test('las listas de aislamiento quedan congeladas como defensa secundaria', () => {
  // Con env_isolation_enabled=false estas listas no controlan el spawn vigente.
  // CA-3d, que asserta el childEnv efectivo, es la capa de verdad.
  assert.deepEqual(SYSTEM_ALLOWLIST, [
    'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'USERNAME', 'APPDATA',
    'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA',
    'SystemRoot', 'ComSpec', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ',
    'NODE_PATH', 'NODE_OPTIONS',
  ]);
  assert.deepEqual(CREDENTIAL_SCOPES, {
    github: ['GH_TOKEN', 'GITHUB_TOKEN'],
    aws: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_PROFILE'],
    'gradle-android': ['JAVA_HOME', 'GRADLE_USER_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_AVD_HOME'],
    'telegram-hooks': ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
  });
  assert.deepEqual(SCOPES_ALWAYS_ON, ['telegram-hooks']);
});

test('secrets-manifest no duplica el detector de placeholders', () => {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  assert.equal((source.match(/REVOKED|PLACEHOLDER|MOVED/g) || []).length, 0);
  assert.match(source, /isPlaceholderOrEmpty/);
});

test('el loader valida sin emitir valores y lista solo nombres de clave', () => {
  const invalid = structuredClone(manifest);
  invalid.entries[0].service = 'desconocido';
  assert.equal(validate(invalid).ok, false);
  const cli = require('node:child_process').spawnSync(process.execPath, [path.join(ROOT, '.pipeline', 'lib', 'secrets-manifest.js')], {
    encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.doesNotMatch(cli.stdout, /shape|defer_reason|restore/);
  assert.match(cli.stdout, /telegram\.bot_token/);
});
