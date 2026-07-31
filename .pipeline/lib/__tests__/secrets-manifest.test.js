'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  load, validate, listByService, isMetadataKey,
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

test('las 12 huerfanas estan declaradas y solo drive_folder_id es eager', () => {
  const orphanNames = [
    'google_drive.drive_folder_id', 'google_drive.oauth_client_id',
    'google_drive.oauth_client_secret', 'google_drive.oauth_refresh_token',
    'aws.access_key_id', 'aws.secret_access_key', 'aws.region', 'aws.profile',
    'aws.table_name', 'aws.coordination_table_name',
    'multimedia.elevenlabs_api_key', 'multimedia.elevenlabs_voice_id',
  ];
  const entries = orphanNames.map((name) => manifest.entries.find((entry) => entry.name === name));
  assert.ok(entries.every(Boolean));
  assert.deepEqual(entries.filter((entry) => entry.hydration === 'eager').map((entry) => entry.name),
    ['google_drive.drive_folder_id']);
  assert.equal(entries.filter((entry) => entry.hydration === 'deferred').length, 11);
  assert.equal(ENV_MAPPING['google_drive.drive_folder_id'], 'GOOGLE_DRIVE_FOLDER_ID');
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
  assert.equal(deferred.length, 11);
  assert.ok(deferred.every((entry) => leafDotPaths(fakeCredentialStore).includes(entry.name)));
  fs.writeFileSync(canonical, JSON.stringify(fakeCredentialStore));
  try {
    const parentEnv = {};
    loadIntoEnv({ canonicalPath: canonical, legacyPath: legacy, env: parentEnv, logger: () => {} });
    const pipelineExtras = { PIPELINE_ISSUE: '5242' };
    const childEnv = { ...parentEnv, ...pipelineExtras };
    assert.equal(childEnv.TELEGRAM_BOT_TOKEN, 'fake-bot-token');
    assert.equal(childEnv.GOOGLE_DRIVE_FOLDER_ID, 'fake-folder');
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
  const rotas = manifest.entries
    .filter((entry) => entry.consumer_status === 'broken')
    .map((entry) => [entry.name, entry.blocked_by]);
  assert.deepEqual(rotas, [
    ['google_drive.oauth_client_id', '#4890'],
    ['google_drive.oauth_client_secret', '#4890'],
    ['google_drive.oauth_refresh_token', '#4890'],
  ]);
  const sinStatus = structuredClone(manifest);
  delete sinStatus.entries.find((entry) => entry.name === 'telegram.bot_token').consumer_status;
  assert.equal(validate(sinStatus).ok, false);
  const sinBlockedBy = structuredClone(manifest);
  delete sinBlockedBy.entries.find((entry) => entry.name === 'google_drive.oauth_client_id').blocked_by;
  assert.equal(validate(sinBlockedBy).ok, false);
});

test('ningun defer_reason afirma que el consumo funciona si su consumer_status es broken', () => {
  // El candado no puede quedarse en el largo minimo: el texto falso de rev-3 tenia
  // 100+ chars. Se combina una lista negra de afirmaciones de consumo sano con la
  // exigencia positiva de declarar el estado roto y el issue que lo cierra.
  const afirmaQueFunciona = /ya funciona|funciona hoy|fallback legacy|fallback vigente|resuelve por fallback|no desbloquea ning[uú]n consumo/i;
  const rotas = manifest.entries.filter((entry) => entry.consumer_status === 'broken');
  assert.equal(rotas.length, 3);
  for (const entry of rotas) {
    assert.doesNotMatch(entry.defer_reason, afirmaQueFunciona, entry.name);
    assert.match(entry.defer_reason, /vac[ií]a?o?|roto/i, entry.name);
    assert.ok(entry.defer_reason.includes(entry.blocked_by), entry.name);
  }
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
    'providers.openai.api_key',
    'providers.cerebras.api_key',
    'providers.nvidia.api_key',
    'google_drive.drive_folder_id',
  ]);
  // `resolved` implica `required_when` distinto de never: una clave que nadie
  // debe reponer no puede a la vez tener consumidor sano.
  for (const entry of manifest.entries.filter((item) => item.consumer_status === 'resolved')) {
    assert.notEqual(entry.required_when, 'never', entry.name);
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
  assert.equal(resueltasDeProviders.length, 3);
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
