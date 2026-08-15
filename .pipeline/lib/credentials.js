// =============================================================================
// credentials.js — Cargador unificado de credenciales (#3311)
//
// Fuente única de verdad: ~/.claude/secrets/credentials.json
// Lee el archivo al boot del Pulpo/restart.js y popula process.env para que
// `validateCredentialsEnvPresence` (agent-models-validate.js) encuentre las
// credenciales sin que el operador tenga que setear setx manualmente por cada
// provider.
//
// Estructura esperada del JSON:
//   {
//     "telegram":   { "bot_token": "...", "chat_id": "..." },
//     "providers":  { "google": {"api_key": "..."}, "cerebras": {...}, ... }
//   }
//
// #3353 (mayo 2026): Groq fue descontinuado. Si el credentials.json todavía
// tiene `providers.groq`, la key se ignora silenciosamente (sin entrada en
// ENV_MAPPING) — el operador puede limpiarlo cuando quiera.
//
// Precedencia (alineada con loadApiKeys de telegram-secrets.js):
//   1. process.env ya seteado → respetar, no sobrescribir
//   2. credentials.json (canonical)
//   3. telegram-config.json (legacy, fallback con warning)
//
// -----------------------------------------------------------------------------
// #5353 — el vault de AWS pasa a ser la FUENTE PRIMARIA (gate `vault.enabled`)
// -----------------------------------------------------------------------------
//
// Con `vault.enabled: false` (default commiteado en `config.yaml`) todo lo de
// arriba sigue EXACTAMENTE igual y no se emite una sola llamada AWS: el módulo
// `secret-vault.js` ni siquiera se carga. Con el gate abierto, la precedencia
// pasa a ser:
//
//   1. `process.env` preseteado → gana, SALVO para las anclas de autorización
//      (B2.2: ahí gana el vault, sin excepción, y el shadowing se loguea).
//   2. El **vault** (`secret-vault.js`, camino SYNC — D-SYNC-1/D1.6).
//   3. La ventana de bootstrap sobre el archivo, SÓLO si el operador la
//      encendió a mano y no caducó (B1.3/B1.5). Jamás automática ante un error
//      del driver (B1.2), jamás para un ancla (B1.7/B2.4).
//   4. Nada más: **fail-closed** nombrando el secreto faltante. La variable
//      queda SIN SETEAR — nunca cadena vacía, nunca un default (B1.1).
//
// `loadIntoEnv()` sigue siendo **sync** (D-SYNC-1). No es cosmética: sus dos
// call-sites de arranque (`pulpo.js:18`, `restart.js:47`) son de nivel de
// módulo y su razón de ser es el ORDEN (#3311); CommonJS no tiene top-level
// `await`, así que volverla async destruiría la garantía, no la firma.
// =============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CANONICAL_PATH = path.join(os.homedir(), '.claude', 'secrets', 'credentials.json');
const LEGACY_PATH = path.join(os.homedir(), '.claude', 'secrets', 'telegram-config.json');

// Directorio del store canónico — ancla de CA-4 (#5898). Vive FUERA del repo
// POR DISEÑO: los secretos dentro del árbol versionado se pierden en cada
// respawn, así que la polaridad del chequeo es "dentro del store Y fuera del
// repo", nunca una sola de las dos.
const STORE_DIR = path.dirname(CANONICAL_PATH);

// Forma lógica del store para los mensajes al operador: nombrar el path
// resuelto expondría el home del host y no le sirve a nadie (UX-2, regla 2).
const STORE_DIR_LOGICO = '~/.claude/secrets/';
const STORE_FILE_LOGICO = '~/.claude/secrets/credentials.json';

// Raíz del repo — se usa para B1.4 (el archivo de la ventana de bootstrap tiene
// que estar FUERA del árbol versionado, coherente con #5218).
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// -----------------------------------------------------------------------------
// Descriptor de credenciales (#5353) — ENV_MAPPING se DERIVA de acá
// -----------------------------------------------------------------------------
//
// Cada entrada describe de dónde sale el valor y qué tratamiento merece:
//
//   env         nombre de la env var que esperan los CLIs.
//   backend     'ssm' → Parameter Store · 'secretsmanager' → Secrets Manager
//               (tier `rotating`) · 'file-only' → nunca va al vault.
//               La clasificación NO la inventa este módulo: sale de la tabla
//               firmada en `docs/pipeline/vault-secretos-aws.md` (#5351), que
//               manda a Secrets Manager sólo lo que rota FUERA del rol de
//               provisión. Hoy eso es un único valor.
//   shared      tier de provisión declarado: `shared/` (común a todos los
//               hosts) vs `hosts/<hostId>/`. Es la INTENCIÓN de alta; en
//               runtime la membresía autoritativa es `vault.shared_secrets`
//               (secret-vault.js), que es enumerada a propósito.
//   auth_anchor el valor no es un secreto: es la fuente de una decisión de
//               AUTORIZACIÓN. Cambia la precedencia (B2) — ver más abajo.
//   hydrate     `false` = el secreto pertenece al inventario del vault, pero
//               NO se inyecta en el `process.env` global (CA-6 de #5217).
//               Default `true` (omitido = se hidrata, como siempre).
//
// Sobre `hydrate` (#5217 · CA-6) — por qué existe este campo:
//
// `loadIntoEnv()` escribe en `process.env` (más abajo) y sus dos call-sites de
// arranque son `pulpo.js:18` y `restart.js:47`. O sea: TODO lo que entre a
// `ENV_MAPPING` lo hereda **cada proceso hijo de cada agente**, incluidos los
// procesos de providers de IA de terceros. Para una API key que el CLI hijo
// necesita leer del ambiente, eso es el mecanismo. Para las credenciales de
// Google Drive NO: su único consumidor es `qa/scripts/qa-video-share.js`, que
// desde #5217 las resuelve BAJO DEMANDA con `resolveScopedRefs` (lectura del
// namespace, sin tocar `process.env`). Hidratarlas globalmente es superficie de
// exposición sin ningún consumidor que la justifique.
//
// Por eso el campo separa dos cosas que #5172/#5353 habían dejado pegadas:
//   - pertenecer al INVENTARIO del vault (provisión, política IAM, rotación,
//     clasificación SSM vs Secrets Manager) → sigue siendo `ENV_DESCRIPTORS`;
//   - ser inyectado en el ENV GLOBAL de todo hijo → ahora sólo `hydrate: true`.
// El descriptor de Drive se conserva intacto: la tabla firmada de #5351
// (`docs/pipeline/vault-secretos-aws.md`) y `vault-iam-policy.json` siguen
// valiendo, y `vaultScopePlan()` sigue devolviendo `google_drive` en ambos
// backends. Lo único que cambia es que no se escriben en `process.env`.
//
// El scope del vault es el primer segmento del dot-path (`telegram`,
// `providers`, `google_drive`): las claves top-level del namespace de
// credenciales, mismo vocabulario que `resolveScopedRefs` (G-1 de #5352).
const VAULT_BACKENDS = Object.freeze(['ssm', 'secretsmanager', 'file-only']);

const ENV_DESCRIPTORS = Object.freeze({
  // Telegram bot
  'telegram.bot_token': {
    env: 'TELEGRAM_BOT_TOKEN', backend: 'ssm', shared: true, auth_anchor: false,
  },
  'telegram.chat_id': {
    env: 'TELEGRAM_CHAT_ID', backend: 'ssm', shared: true, auth_anchor: false,
  },
  // Chat del operador (Leo) para handlers proactivos (mockup UX, etc. — #3384).
  // Si no está configurada, el handler correspondiente se autodeshabilita.
  //
  // B2.1 — ÚNICA ancla de autorización del inventario. No es una API key: es la
  // única fuente de `resolveOperatorAllowlist()` (`operator-gate.js:78-85`), que
  // alimenta `authorizedSigners` en `pulpo.js`. Quien pueda escribir esta var en
  // el ambiente del Pulpo se auto-agrega a la allowlist de firmantes; por eso
  // con el gate abierto se resuelve EXCLUSIVAMENTE desde el vault (B2.2) y no
  // tiene fallback de ningún tipo (B2.4).
  'telegram.leo_operator_chat_id': {
    env: 'TELEGRAM_LEO_OPERATOR_CHAT_ID', backend: 'ssm', shared: true, auth_anchor: true,
  },
  // Providers IA (allowlist en agent-models-validate.js:ALLOWED_CREDENTIAL_ENV_VARS)
  'providers.openai.api_key': {
    env: 'OPENAI_API_KEY', backend: 'ssm', shared: true, auth_anchor: false,
  },
  'providers.anthropic.api_key': {
    env: 'ANTHROPIC_API_KEY', backend: 'ssm', shared: true, auth_anchor: false,
  },
  'providers.google.api_key': {
    env: 'GEMINI_API_KEY', backend: 'ssm', shared: true, auth_anchor: false,
  },
  // providers.groq.api_key se removió en #3353 — Groq descontinuado.
  'providers.cerebras.api_key': {
    env: 'CEREBRAS_API_KEY', backend: 'ssm', shared: true, auth_anchor: false,
  },
  'providers.nvidia.api_key': {
    env: 'NVIDIA_NIM_API_KEY', backend: 'ssm', shared: true, auth_anchor: false,
  },
  // #4880 — Kimi (Moonshot). Drop-in de Claude Code contra el endpoint
  // Anthropic-compat: autentica con su token en `ANTHROPIC_AUTH_TOKEN` (var
  // distinta de `ANTHROPIC_API_KEY`, la OAuth/Max real). Fuente única en
  // credentials.json; jamás por Telegram (SEC-5). El valor nunca se loguea (el
  // loader sólo lista nombres de var).
  'providers.moonshot.api_key': {
    env: 'ANTHROPIC_AUTH_TOKEN', backend: 'ssm', shared: true, auth_anchor: false,
  },
  // #5172 — Google Drive (persistencia de evidencia de QA).
  //
  // Hasta ahora estas credenciales vivían SÓLO en el archivo versionado
  // `.claude/hooks/telegram-config.json`, que es tracked por git: la copia
  // commiteada NO tiene las claves `google_*`, así que cada respawn con
  // `git reset --hard` las borraba y `qa-video-share` quedaba con
  // "Google Drive no configurado" hasta que el operador las recargaba a mano.
  // Migradas al store externo (que sobrevive al reset) para cerrar ese ciclo.
  // El refresh_token es un secreto: el loader sólo lista NOMBRES de var.
  //
  // `hydrate: false` (#5217 · CA-6): siguen en el inventario del vault —se
  // provisionan, se rotan y la política IAM las cubre— pero NO se inyectan en
  // el `process.env` global. Su único consumidor (`qa-video-share.js`) las
  // resuelve bajo demanda por namespace desde #5217, así que hidratarlas sería
  // exponer un refresh token de Google en el ambiente de todo agente hijo sin
  // que nadie lo lea de ahí. El campo `env` se conserva porque sigue siendo el
  // nombre canónico de la variable: es el override operativo que el consumidor
  // consulta primero, y el que se nombra en los diagnósticos al operador.
  //
  // Relación con #5242 / #5281: ese issue las declaró `hydration: "eager"` en
  // `.pipeline/secrets-manifest.json` porque en ese momento el nivel 2 (store)
  // de `qa-video-share.js` resolvía vía `loadIntoEnv`, o sea vía `ENV_MAPPING`:
  // dejarlas `deferred` rompía la subida de evidencia. #5217 elimina esa
  // dependencia —el consumidor pasa a `resolveScopedRefs`, que lee el namespace
  // directo del JSON sin tocar `process.env`—, así que la premisa de `eager`
  // dejó de valer y las cuatro pasan a `deferred` en el manifiesto EN ESTE
  // MISMO PR. La invariante bidireccional de CA-3b (`source: "store"` + `eager`
  // ⟺ clave de `ENV_MAPPING`) se mantiene intacta: se sigue cumpliendo 1:1,
  // ahora con las cuatro fuera de los dos lados. (Tras #5353 este bloque es
  // `ENV_DESCRIPTORS` y `ENV_MAPPING` se DERIVA de él, así que la invariante se
  // evalúa sobre el mapa derivado.)
  'google_drive.oauth_client_id': {
    env: 'GOOGLE_OAUTH_CLIENT_ID', backend: 'ssm', shared: true, auth_anchor: false,
    hydrate: false,
  },
  'google_drive.oauth_client_secret': {
    env: 'GOOGLE_OAUTH_CLIENT_SECRET', backend: 'ssm', shared: true, auth_anchor: false,
    hydrate: false,
  },
  // El ÚNICO ocupante de Secrets Manager hoy: lo emite un tercero con su propio
  // ciclo de refresh (Google lo renueva y puede invalidarlo sin que nadie lo
  // escriba desde el rol de provisión) — regla (a) de la tabla de #5351.
  'google_drive.oauth_refresh_token': {
    env: 'GOOGLE_OAUTH_REFRESH_TOKEN', backend: 'secretsmanager', shared: true, auth_anchor: false,
    hydrate: false,
  },
  'google_drive.drive_folder_id': {
    env: 'GOOGLE_DRIVE_FOLDER_ID', backend: 'ssm', shared: true, auth_anchor: false,
    hydrate: false,
  },
});

// Subconjunto del inventario que SÍ se inyecta en `process.env` (CA-6 de #5217).
// Un descriptor sin `hydrate` se hidrata: el default preserva el comportamiento
// histórico y obliga a que sacar algo del env global sea una decisión explícita.
function seHidrata(descriptor) {
  return !descriptor || descriptor.hydrate !== false;
}

// Retrocompat OBLIGATORIA (G1): el mapa plano `dotPath -> envVar` se DERIVA del
// descriptor, nunca se duplica a mano. Sigue siendo un objeto plano CONGELADO
// —no un `Proxy`, no un getter lazy— porque sus consumidores lo recorren con
// `Object.entries()` / `Object.values()` / `Object.keys()` directo:
//
//   .pipeline/lib/wizards/providers/index.js:73  ← PRODUCCIÓN. `listProviders()`
//        filtra `providers.*.api_key` sobre este mapa. Si desapareciera,
//        devolvería `[]` SIN lanzar excepción y el wizard de providers del
//        dashboard quedaría vacío: falla silenciosa, por eso tiene test propio.
//   .pipeline/lib/__tests__/credentials.test.js, credentials-google-drive.test.js,
//   kimi-provider-4880.test.js, .pipeline/tests/dashboard/wizard-providers-flow.test.js
//
// (Ojo: `hydrate-provider-env.js:35` declara OTRO `ENV_MAPPING` local y
// homónimo, sin relación con éste. Un `grep` lo trae; no es parte de esto.)
//
// #5217 · CA-6: se derivan SÓLO los descriptores con `hydrate` distinto de
// `false`. `ENV_MAPPING` es, por definición, "lo que se escribe en el
// `process.env` global", y ése es exactamente el contrato que consumen
// `loadIntoEnv()` y `listProviders()`. El inventario completo (incluidas las
// claves que no se hidratan) sigue siendo `ENV_DESCRIPTORS`: quien necesite
// enumerar TODO el material de clave —provisión del vault, política IAM,
// métricas de cobertura— tiene que leer el descriptor, no este mapa.
const ENV_MAPPING = Object.freeze(Object.fromEntries(
  Object.entries(ENV_DESCRIPTORS)
    .filter(([, d]) => seHidrata(d))
    .map(([dotPath, d]) => [dotPath, d.env]),
));

// Subconjunto del descriptor que participa del ciclo de hidratación. Es el
// denominador correcto para la ventana sombra del vault (#5427): esa métrica
// mide la cobertura del camino `loadIntoEnv` —una fila por variable resuelta—,
// y un secreto que por diseño NUNCA se hidrata no puede producir esa fila.
// Contarlo igual lo dejaría para siempre en `no_verificados` y la ventana no
// cerraría nunca, o sea el fallback a archivo no se retiraría jamás: un cambio
// de alcance de #5217 congelando la salida del vault. El inventario completo
// (provisión, IAM, rotación) sigue siendo `ENV_DESCRIPTORS`.
const HYDRATED_DESCRIPTORS = Object.freeze(Object.fromEntries(
  Object.entries(ENV_DESCRIPTORS).filter(([, d]) => seHidrata(d)),
));

// B2.7 — nombres de las env vars que son anclas de autorización, derivados del
// descriptor (no se duplica el inventario). Es un Set por NOMBRE porque el
// camino del mapping legacy itera sin `dotPath`, y ahí no hay descriptor del que
// leer `auth_anchor`: sin esto, el fail-closed del ancla tendría un agujero.
const ANCHOR_ENV_VARS = Object.freeze(new Set(
  Object.values(ENV_DESCRIPTORS).filter((d) => d.auth_anchor).map((d) => d.env),
));

// Mapeo legacy: telegram-config.json usa flat keys (no nested). Solo cubre las
// que existían en ese formato — providers nuevos (google/cerebras/nvidia) no
// se cargan del legacy porque no existían cuando ese archivo era canónico.
//
// #3353 (mayo 2026): `groq_api_key` se removió del mapping legacy junto con la
// descontinuación de Groq. Si aparece en el JSON legacy se ignora silenciosamente.
const LEGACY_MAPPING = Object.freeze({
  'bot_token':           'TELEGRAM_BOT_TOKEN',
  'chat_id':             'TELEGRAM_CHAT_ID',
  'openai_api_key':      'OPENAI_API_KEY',
  'anthropic_api_key':   'ANTHROPIC_API_KEY',
});

const PLACEHOLDER_RE = /(REVOKED|PLACEHOLDER|MOVED|EXAMPLE|REPLACE|CHANGE_ME)/i;

function isPlaceholderOrEmpty(value) {
  if (value === null || value === undefined) return true;
  const s = String(value);
  if (s.trim().length === 0) return true;
  return PLACEHOLDER_RE.test(s);
}

function getNested(obj, dotPath) {
  return dotPath.split('.').reduce(
    (acc, k) => (acc && typeof acc === 'object') ? acc[k] : undefined,
    obj
  );
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

// =============================================================================
// Integración con el vault (#5353) — fuente primaria, sync, memoizada
// =============================================================================

// UX-2 — el origen se reporta POR VARIABLE. Un único `source` global no permite
// diagnosticar la ventana de bootstrap: con 13 vars y 4 orígenes posibles,
// "source: canonical" no dice cuál vino de dónde. `result.source` se conserva
// igual (retrocompat), pero la respuesta fina vive en `result.sources`.
const SOURCE = Object.freeze({
  VAULT:           'vault',
  FILE_BOOTSTRAP:  'file-bootstrap',
  CANONICAL:       'canonical',
  LEGACY:          'legacy',
  ENV_PREEXISTING: 'env-preexisting',
  EMPTY:           'empty',    // UX-3: presente en la fuente, pero vacía o placeholder
  MISSING:         'missing',  // UX-3: no configurada en ninguna fuente
});

// D-SYNC-7 — memoización por namespace A NIVEL DE MÓDULO. No es una
// optimización: `loadIntoEnv` NO se llama sólo en el boot. `action-token.js:77`
// la llama por resolución de token y `cerebras-runner.js:96` /
// `nvidia-nim-runner.js:90` POR LANZAMIENTO DE AGENTE. Sin esto, cada launch
// pagaría el arranque de un proceso Python de la AWS CLI (~1-2 s).
//
// El TTL sale de `vault.cache_ttl_seconds` (tope duro de 300 s en el módulo del
// vault, SEC-6): un caché sin vencimiento en un proceso que vive días
// convertiría una revocación en el vault en algo que no surte efecto hasta el
// restart — y para el ancla de autorización eso significa seguir aceptando a un
// firmante des-autorizado.
//
// Sin negative caching: un fallo NO se memoiza, para que `aws login` surta
// efecto sin reiniciar el Pulpo.
//
// #5899 — la memo pasa de UNA entrada a un `Map` PARTICIONADO. El defecto que
// esto mata no es contaminación cross-tenant (la clave siempre incluyó
// `projectId` y `hostId`, y se comparaba en la lectura) sino THRASH: con una
// sola ranura, dos proyectos alternándose se desalojaban mutuamente y la
// secuencia `A,A,B,A,B` pagaba `MISS,HIT,MISS,MISS,MISS`. Como esto corre POR
// LANZAMIENTO DE AGENTE y el fallo del vault se propaga fail-closed a
// propósito (CA-22), el thrash multi-tenant equivale a una denegación de
// servicio sobre la resolución de secretos.
//
// La cota superior (`vault.max_cached_tenants`) es un CONTROL DE SEGURIDAD, no
// una optimización (REQ-SEC-6): acota cuánto plaintext vive en el heap, que
// pasa de 1 namespace a N durante la ventana del TTL.
const _vaultMemo = new Map();   // clave -> { expiraEn, payload, vault, namespace }

// Cota por default cuando `vault.max_cached_tenants` no está configurada o no
// es un entero >= 1. Ocho cubre el máximo de instancias concurrentes que el
// kernel soporta hoy con holgura; el número real se documenta en config.yaml.
const DEFAULT_MAX_CACHED_TENANTS = 8;

// UX-OPS-1 — ventana de rate-limit del warn de evicción, POR NAMESPACE. Con la
// cota corta la evicción no ocurre una vez: ocurre por lanzamiento de agente, y
// N líneas idénticas en `pulpo.log` dejan de leerse. Mismo patrón que
// `kernel-degradation-alert.js` (cooldown por causa + reloj inyectable).
const EVICTION_WARN_COOLDOWN_MS = 5 * 60 * 1000;
const _evictionWarn = new Map();   // clave -> { ultimoAviso, acumuladas }

/**
 * G-5 — hay DOS cachés en capas: esta memo y la interna de `createSecretVault`.
 * Soltar la entrada de arriba sin limpiar la de abajo dejaría plaintext vivo
 * más allá de la cota, o sea una cota que da falsa sensación de acotamiento.
 */
function soltarVaultMemoizado(entrada) {
  if (!entrada || !entrada.vault || typeof entrada.vault.clearCache !== 'function') return;
  try {
    entrada.vault.clearCache();
  } catch (e) {
    // `clearCache` es idempotente por contrato (SEC-6(c)): un fallo acá no
    // puede voltear al caller ni impedir que la entrada se borre.
  }
}

/** CA-16 — la entrada se BORRA (no se marca) y arrastra la caché de abajo. */
function borrarDelMemo(clave) {
  const entrada = _vaultMemo.get(clave);
  if (!entrada) return;
  soltarVaultMemoizado(entrada);
  _vaultMemo.delete(clave);
}

/** Invalidación explícita. Exportada SÓLO para los tests. */
function _resetVaultCache() {
  for (const clave of [..._vaultMemo.keys()]) borrarDelMemo(clave);
  _vaultMemo.clear();
  _evictionWarn.clear();
}

/** `providers.openai.api_key` → `{ scope: 'providers', subPath: 'openai.api_key' }`. */
function splitDotPath(dotPath) {
  const i = dotPath.indexOf('.');
  return i < 0
    ? { scope: dotPath, subPath: '' }
    : { scope: dotPath.slice(0, i), subPath: dotPath.slice(i + 1) };
}

/**
 * Agrupa los scopes que hay que pedirle al vault, por backend. Es una función
 * pura para que el test la ejerza sin tocar red ni config.
 *
 * D5 (#5352) — el vault resuelve SÓLO los scopes declarados, y `scopes` es un
 * puñado (3), no 13: no existe un camino que hidrate variable por variable.
 *
 * @returns {{ssm: string[], secretsmanager: string[]}}
 */
function vaultScopePlan(descriptors = ENV_DESCRIPTORS) {
  const plan = { ssm: [], secretsmanager: [] };
  for (const [dotPath, d] of Object.entries(descriptors)) {
    if (!VAULT_BACKENDS.includes(d.backend)) {
      throw new Error(`[credentials] descriptor "${dotPath}": backend desconocido "${d.backend}"`);
    }
    // `file-only` nunca va al vault: se resuelve por el camino del archivo.
    if (d.backend === 'file-only') continue;
    const { scope } = splitDotPath(dotPath);
    if (!plan[d.backend].includes(scope)) plan[d.backend].push(scope);
  }
  return plan;
}

/** ¿El path cae DENTRO del árbol del repo? (B1.4, coherente con #5218) */
function estaDentroDelRepo(p) {
  const rel = path.relative(REPO_ROOT, path.resolve(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Lee la sección `vault:` de config.yaml (+ `kernel.region`, que el vault
 * REUTILIZA por diseño de #5352).
 *
 * B2.7 (rev-1) — DOS decisiones de seguridad viven acá:
 *
 * 1. La RAÍZ de la config se fija en código (`REPO_ROOT`), igual que hace el
 *    Pulpo (`pulpo.js`, `resolve({pipelineDir: PIPELINE})`). `resolve({})` deja
 *    que el ENTORNO elija qué `config.yaml` es la autoridad
 *    (`PIPELINE_DIR_OVERRIDE` / `PIPELINE_STATE_DIR` / `PIPELINE_REPO_ROOT`), y
 *    esa es exactamente la capacidad que B2 asume en el adversario: quien puede
 *    escribir `TELEGRAM_LEO_OPERATOR_CHAT_ID` puede escribir `PIPELINE_REPO_ROOT`,
 *    desviar la lectura a una carpeta suya y apagar el gate del vault desde
 *    afuera — con el gate apagado el ancla vuelve al régimen de `process.env` y
 *    el atacante queda como firmante del gate del operador. Fijar la raíz cierra
 *    el vector entero. `opts.pipelineDir` sigue disponible porque es un
 *    ARGUMENTO (código), no entorno — la misma distinción que documenta
 *    `config-resolver.js` para su propio orden de precedencia.
 *
 * 2. "No pude leer la config" NO es "vault apagado". Son estados distintos con
 *    políticas opuestas: `enabled: false` es una decisión deliberada y commiteada;
 *    un error de lectura es una condición NO gobernada. Colapsarlos es fail-open
 *    disfrazado — el mismo razonamiento que el código ya aplica a B1.2 para el
 *    error de red del driver. Por eso el retorno es un TRI-estado y el
 *    indeterminado se propaga hasta la precedencia del ancla.
 *
 * @returns {{cfg: object|null, indeterminado: boolean, causa: string|null}}
 */
function readVaultConfig(opts, logger) {
  // Inyección de tests: una config provista por firma es una decisión conocida,
  // nunca un indeterminado.
  if (opts.vaultConfig !== undefined) {
    return { cfg: opts.vaultConfig, indeterminado: false, causa: null };
  }
  const pipelineDir = opts.pipelineDir
    ? path.resolve(opts.pipelineDir)
    : path.join(REPO_ROOT, '.pipeline');
  try {
    const cfg = require('./config-resolver').resolve({ pipelineDir });
    // Config LEÍDA y sin sección `vault:` es una decisión conocida (el vault no
    // está configurado), no un indeterminado: gate cerrado y nada más.
    if (!cfg || !cfg.vault) return { cfg: null, indeterminado: false, causa: null };
    return {
      cfg: { ...cfg.vault, region: cfg.kernel && cfg.kernel.region },
      indeterminado: false,
      causa: null,
    };
  } catch (e) {
    const causa = (e && e.name) || 'error';
    logger(`[credentials] WARN: no se pudo leer config.yaml para el vault (${causa}). `
      + 'Impacto: el gate del vault queda CERRADO para los 12 secretos (se usa el archivo), '
      + 'pero las anclas de autorizacion fallan CERRADAS: no se puede probar que el vault este '
      + 'apagado a proposito, y un error de lectura no puede devolverle el ancla al ambiente (B2.7). '
      + `Proximo paso: reparar ${path.join(pipelineDir, 'config.yaml')}`);
    return { cfg: null, indeterminado: true, causa };
  }
}

/**
 * Evalúa la ventana de bootstrap de B1 sobre el archivo de credenciales.
 *
 * Es la ÚNICA puerta al archivo cuando el gate del vault está abierto, y está
 * cerrada por default. Todas las condiciones tienen que darse a la vez.
 */
function evaluarVentanaBootstrap(cfg, { canonicalPath, legacyPath, ahora, logger }) {
  // B1.3 — flag deliberado. Fail-closed: sólo el booleano `true` exacto.
  if (!cfg || cfg.bootstrap_fallback !== true) {
    return { activo: false, motivo: 'flag-apagado' };
  }

  // B1.5 — `until` OBLIGATORIO. Sin fecha, "bootstrap temporal" se vuelve
  // permanente por olvido, que es justo lo que la ventana existe para evitar.
  const hasta = typeof cfg.bootstrap_fallback_until === 'string'
    ? cfg.bootstrap_fallback_until.trim() : '';
  if (!hasta) {
    logger('[credentials] ERROR: `vault.bootstrap_fallback: true` sin '
      + '`vault.bootstrap_fallback_until`. Impacto: la ventana de bootstrap NO se '
      + 'aplica y las variables que falten en el vault quedan sin setear. '
      + 'Proximo paso: poner una fecha ISO-8601 de caducidad o apagar el flag');
    return { activo: false, motivo: 'until-ausente' };
  }
  const vence = Date.parse(hasta);
  if (!Number.isFinite(vence)) {
    logger(`[credentials] ERROR: \`vault.bootstrap_fallback_until\` no es una fecha ISO-8601 valida ("${hasta}"). `
      + 'Impacto: la ventana de bootstrap NO se aplica. Proximo paso: corregir la fecha en config.yaml');
    return { activo: false, motivo: 'until-invalido' };
  }
  if (ahora > vence) {
    // B1.5 — caduca sola, aunque el flag siga en `true`.
    logger(`[credentials] WARN: la ventana de bootstrap del vault CADUCO el ${hasta}. `
      + 'Impacto: el fallback al archivo ya no se aplica y lo que falte en el vault queda sin setear. '
      + 'Proximo paso: subir los secretos faltantes al vault y apagar `vault.bootstrap_fallback`');
    return { activo: false, motivo: 'caducada' };
  }

  // B1.4 — el archivo del fallback tiene que estar FUERA del árbol del repo,
  // aunque el flag esté encendido. No relajamos #5218 por la ventana.
  for (const p of [canonicalPath, legacyPath]) {
    if (estaDentroDelRepo(p)) {
      logger(`[credentials] ERROR: el archivo de credenciales resuelve DENTRO del arbol del repo (${p}). `
        + 'Impacto: la ventana de bootstrap se RECHAZA aunque el flag este encendido (#5218). '
        + 'Proximo paso: mover el store fuera del repo (~/.claude/secrets/)');
      return { activo: false, motivo: 'archivo-en-repo' };
    }
  }

  // UX-4 — avisa MIENTRAS está activa, y avisa ANTES de caducar (no después de
  // que el arranque falle).
  const diasRestantes = Math.floor((vence - ahora) / 86400000);
  logger(`[credentials] WARN: ventana de bootstrap del vault ACTIVA hasta ${hasta} `
    + `(quedan ${diasRestantes} dia/s). Impacto: las variables ausentes del vault se leen del archivo `
    + 'y se reportan con source `file-bootstrap`, nunca `vault`. '
    + 'Proximo paso: subir esos secretos al vault antes de la fecha');
  if (diasRestantes <= 3) {
    logger('[credentials] WARN: la ventana de bootstrap del vault esta POR CADUCAR. '
      + 'Impacto: al vencer, toda variable que siga faltando en el vault quedara sin setear '
      + 'y el componente que la necesite fallara. Proximo paso: completar la migracion al vault YA');
  }
  return { activo: true, vence, hasta };
}

/** Dedup + orden estable: el conjunto de scopes, no la lista que llegó. */
function scopesNormalizados(scopes) {
  return [...new Set(Array.isArray(scopes) ? scopes : [])].sort().join(',');
}

/**
 * G-2 / REQ-SEC-3 — clave COMPLETA e inyectiva de la memo.
 *
 * El namespace solo no alcanza: el payload memoizado DEPENDE del conjunto de
 * scopes pedido y del tier de cada uno. Omitirlos produce un HIT falso, que es
 * peor que el MISS que #5899 viene a matar: devuelve un `missing` espurio y
 * dispara un fail-closed indebido sobre un tenant legítimo.
 *
 * Es inyectiva PORQUE cada componente ya pasó por `validateVaultNamespace`:
 * `#`, `|`, `:` y `,` no pertenecen a `SEGMENT_RE`, y `/` sólo aparece dentro
 * del prefijo, que `PREFIX_RE` ancla al arranque. Deja de serlo apenas un
 * componente entre sin validar — por eso la validación va SIEMPRE antes.
 * Los dos regex viven en `secret-vault.js` y NO se exportan a propósito: acá no
 * hay copia de ninguno, sólo la llamada al validador canónico.
 */
function claveMemo({ prefix, projectId, hostId, plan, sharedScopes }) {
  return `${prefix}/${projectId}#${hostId}`
    + `|ssm:${scopesNormalizados(plan && plan.ssm)}`
    + `|rot:${scopesNormalizados(plan && plan.secretsmanager)}`
    + `|shared:${scopesNormalizados(sharedScopes)}`;
}

/** CA-12 — cota de namespaces cacheados a la vez. Entero >= 1 o el default. */
function cotaDeNamespaces(cfg, logger) {
  const declarada = cfg && cfg.max_cached_tenants;
  if (declarada === undefined || declarada === null) return DEFAULT_MAX_CACHED_TENANTS;
  if (typeof declarada === 'number' && Number.isInteger(declarada) && declarada >= 1) {
    return declarada;
  }
  logger(`[credentials] WARN: \`vault.max_cached_tenants\` invalida (${JSON.stringify(declarada)}). `
    + `Impacto: se usa el default (${DEFAULT_MAX_CACHED_TENANTS}) para acotar el plaintext en memoria. `
    + 'Proximo paso: poner un entero >= 1 en .pipeline/config.yaml, igual al maximo de instancias concurrentes');
  return DEFAULT_MAX_CACHED_TENANTS;
}

/**
 * CA-13 / UX-OPS-1/2 — warn de evicción: nombres, nunca valores; una línea por
 * namespace por ventana, con el contador acumulado de la ventana para no perder
 * la señal de que la cota quedó corta.
 */
function avisarEviccion(clave, cota, ahora, logger) {
  const estado = _evictionWarn.get(clave) || { ultimoAviso: null, acumuladas: 0 };
  estado.acumuladas += 1;
  const vencido = estado.ultimoAviso === null
    || (ahora - estado.ultimoAviso) >= EVICTION_WARN_COOLDOWN_MS;
  if (vencido) {
    const extra = estado.acumuladas > 1
      ? ` (y ${estado.acumuladas - 1} eviccion/es mas de este namespace en la ventana)` : '';
    logger(`[credentials] WARN: eviccion del namespace del vault "${clave}" por cota${extra}. `
      + `Causa: \`vault.max_cached_tenants\` = ${cota} y hay mas namespaces activos que esa cota. `
      + 'Impacto: el proximo acceso a ese namespace paga un MISS, o sea un proceso de la AWS CLI '
      + 'por lanzamiento de agente. '
      + 'Proximo paso: subir `vault.max_cached_tenants` en .pipeline/config.yaml hasta el numero '
      + 'de instancias concurrentes — por debajo de ese numero el thrash vuelve');
    estado.ultimoAviso = ahora;
    estado.acumuladas = 0;
  }
  _evictionWarn.set(clave, estado);
  // El estado del cooldown es metadata (dos números por namespace), pero en un
  // proceso que vive días con muchos tenants igual no puede crecer sin techo:
  // misma regla que la memo, se poda por antigüedad de inserción.
  while (_evictionWarn.size > MAX_ESTADOS_DE_AVISO) {
    const vieja = _evictionWarn.keys().next().value;
    if (vieja === undefined) break;
    _evictionWarn.delete(vieja);
  }
}

/**
 * Escribe en la memo respetando la cota. La víctima es la entrada MÁS VIEJA por
 * orden de escritura (`Map` preserva el orden de inserción); la lectura NO
 * reordena ni extiende vigencia (CA-14).
 */
function escribirEnMemo(clave, entrada, cota, ahora, logger) {
  if (_vaultMemo.has(clave)) borrarDelMemo(clave);
  while (_vaultMemo.size >= cota) {
    const victima = _vaultMemo.keys().next().value;
    if (victima === undefined) break;
    borrarDelMemo(victima);
    avisarEviccion(victima, cota, ahora, logger);
  }
  _vaultMemo.set(clave, entrada);
}

/**
 * #5899 — núcleo ÚNICO de la resolución contra el vault, parametrizado por
 * `projectId`, plan de scopes y allowlist. `resolverVault` (camino global de
 * los 13 secretos) y `resolveInstanceVault` (camino por instancia) son dos
 * callers finos de esto: un solo broker de secretos, nunca dos en paralelo.
 *
 * LANZA: `VaultConfigError` si el namespace no valida (fail-closed, antes de la
 * clave de la memo y antes de tocar el driver) y cualquier error del vault. El
 * caller decide si lo propaga o lo convierte en resultado.
 *
 * @param {object} args
 * @param {object}   args.cfg             sección `vault:` + `region`
 * @param {string}   args.projectId       identidad EFECTIVA (kernel o instancia)
 * @param {{ssm:string[], secretsmanager:string[]}} args.plan  scopes a pedir
 * @param {string[]} args.requiredScopes  allowlist efectiva (CA-7)
 * @param {string[]} args.sharedScopes    membresía `shared` ENUMERADA (G-3)
 * @param {object}   args.opts            opts del caller (driver, now, …)
 */
function resolverVaultConPlan({ cfg, projectId, plan, requiredScopes, sharedScopes, opts }, logger) {
  const sv = require('./secret-vault');

  const pedidosSsm = Array.isArray(plan && plan.ssm) ? plan.ssm : [];
  const pedidosRot = Array.isArray(plan && plan.secretsmanager) ? plan.secretsmanager : [];
  const declarados = Array.isArray(requiredScopes) ? requiredScopes : [];
  const compartidos = new Set(Array.isArray(sharedScopes) ? sharedScopes : []);
  // G-3 — `host` es el default; `shared` SÓLO si está enumerado. Nunca se
  // infiere de la presencia de `hostId`: `buildParameterPath` exige tier explícito.
  const tierDe = (scope) => (compartidos.has(scope) ? 'shared' : 'host');

  // 1 · REQ-SEC-2/3 · CA-6/CA-8 — validación CANÓNICA antes de construir la
  //     clave de la memo y antes de emitir una sola llamada al driver.
  //     `validateVaultNamespace` corre `buildParameterPath` por dentro: es la
  //     única fuente del esquema. Copiar `SEGMENT_RE` acá sería exactamente la
  //     regresión de SEC-3 de #5352 que este cableado evita — por eso los regex
  //     NO se exportan (secret-vault.js:1218-1221).
  sv.validateVaultNamespace({
    prefix: cfg.prefix, projectId, hostId: cfg.hostId, tier: 'host', root: true,
  });
  for (const scope of new Set([...declarados, ...compartidos, ...pedidosSsm])) {
    sv.validateVaultNamespace({
      prefix: cfg.prefix, projectId, hostId: cfg.hostId, scope, tier: tierDe(scope),
    });
  }
  for (const scope of pedidosRot) {
    sv.validateVaultNamespace({ prefix: cfg.prefix, projectId, scope, tier: 'rotating' });
  }

  // 2 · memo. El namespace REPORTADO sigue siendo el de siempre
  //     (`<prefix>/<projectId>#<hostId>`); la clave de la memo es más fina.
  const ahora = typeof opts.now === 'function' ? opts.now() : Date.now();
  const namespace = `${cfg.prefix}/${projectId}#${cfg.hostId}`;
  const clave = claveMemo({
    prefix: cfg.prefix, projectId, hostId: cfg.hostId,
    plan: { ssm: pedidosSsm, secretsmanager: pedidosRot },
    sharedScopes: [...compartidos],
  });

  const entrada = _vaultMemo.get(clave);
  if (entrada) {
    if (entrada.expiraEn > ahora) {
      // CA-14 / REQ-SEC-5 — la lectura NO refresca `expiraEn`. El TTL es la
      // ventana de revocación: el tráfico de un tenant no puede prolongar la
      // vigencia del material de otro (ni del propio).
      return { enabled: true, namespace, payload: entrada.payload, error: null, cfg };
    }
    borrarDelMemo(clave);   // CA-16: vencida se BORRA, no se marca
  }

  try {
    const driver = opts.vaultDriver || (() => {
      // SEC-2 — el ambiente de origen del runner es EXPLÍCITO y es el del
      // proceso padre. `opts.env` es el ambiente DESTINO (los scripts de QA
      // pasan un scratch descartable); la identidad AWS no sale de ahí.
      const runner = sv.createAwsCliVaultRunner(process.env, cfg.region);
      return sv.createAwsCliVaultDriver({ run: runner.run });
    })();

    // B3-A.1/B3-A.3 — el namespace se construye desde config y
    // `validateVaultConfig` rechaza un `hostId` vacío o inválido NOMBRANDO
    // `vault.hostId`. CA-5/CA-7: `projectId` y la allowlist son los EFECTIVOS,
    // que sin override son exactamente los de config.
    const vault = sv.createSecretVault({
      config: { ...cfg, projectId, required_scopes: declarados, shared_secrets: [...compartidos] },
      driver,
      // CA-23 — al logger del vault sólo llegan NOMBRES de scope.
      logger: {
        info: (msg, meta) => logger(`[credentials] ${msg} ${JSON.stringify(meta || {})}`),
        warn: (msg, meta) => logger(`[credentials] WARN: ${msg} ${JSON.stringify(meta || {})}`),
      },
    });

    const payload = { ssm: {}, secretsmanager: {} };
    // D1.6 — sólo el camino SYNC. Dos llamadas batch como máximo para `ssm`
    // (SEC-3) y una por scope para `rotating`.
    if (pedidosSsm.length) {
      payload.ssm = vault.resolveScopeSync({ scopes: pedidosSsm });
    }
    if (pedidosRot.length) {
      payload.secretsmanager = vault.resolveScopeSync({
        scopes: pedidosRot, tier: 'rotating',
      });
    }

    const ttlMs = (typeof cfg.cache_ttl_seconds === 'number' ? cfg.cache_ttl_seconds : 300) * 1000;
    // G-5 — la instancia del vault se memoiza JUNTO al payload para poder
    // propagarle `clearCache()` al evictar o resetear.
    escribirEnMemo(clave, { expiraEn: ahora + ttlMs, payload, vault, namespace },
      cotaDeNamespaces(cfg, logger), ahora, logger);
    return { enabled: true, namespace, payload, error: null, cfg };
  } catch (err) {
    // REQ-SEC-7 — el fallo NO memoiza negativo, NO evicta y NO toca la entrada
    // de otro namespace: se propaga fail-closed SÓLO para el tenant que falló.
    // El namespace ya está validado, así que viaja en el error para que el
    // caller lo reporte igual que antes de #5899.
    if (err && typeof err === 'object' && err.vaultNamespace === undefined) {
      err.vaultNamespace = namespace;
    }
    throw err;
  }
}

/**
 * Resuelve el namespace del vault por el camino SYNC, memoizado por namespace.
 *
 * Caller delgado de `resolverVaultConPlan`: sin overrides, el camino global de
 * los 13 secretos queda IDÉNTICO al de antes de #5899 (CA-5).
 *
 * @param {object} [opts.projectId]      #5899 CA-5 — override de instancia; default `cfg.projectId`.
 * @param {string[]} [opts.requiredScopes] #5899 CA-7 — allowlist por instancia; default `cfg.required_scopes`.
 * @param {string[]} [opts.sharedScopes] membresía `shared` enumerada; default `cfg.shared_secrets`.
 * @param {object} [opts.vaultPlan]      plan de scopes `{ssm, secretsmanager}`; default el global.
 * @returns {{enabled:boolean, indeterminado:boolean, namespace:string|null,
 *            payload:object|null, error:object|null}}
 */
function resolverVault(opts, logger) {
  const { cfg, indeterminado, causa } = readVaultConfig(opts, logger);

  // D-SYNC-8 — con el gate cerrado no se construye el vault, no se carga
  // `secret-vault.js` y no se toca el driver ni una vez. El comportamiento
  // productivo queda IDÉNTICO al de antes de #5353.
  //
  // B2.7 — `indeterminado` viaja aparte de `enabled`. Para los 12 no-ancla el
  // camino es el mismo que con el gate cerrado (por eso `enabled: false`); lo
  // que cambia es SÓLO la precedencia del ancla, que falla cerrada.
  if (!cfg || cfg.enabled !== true) {
    return {
      enabled: false,
      indeterminado: !!indeterminado,
      causaIndeterminado: causa || null,
      namespace: null,
      payload: null,
      error: null,
      cfg,
    };
  }

  // CA-5/CA-7 — overrides EXPLÍCITOS de instancia. Sin ellos, la identidad y la
  // allowlist son las del kernel (`config.yaml`), o sea el comportamiento de
  // siempre. Un override inválido NO se sanitiza: falla cerrado más abajo.
  const projectId = opts.projectId !== undefined ? opts.projectId : cfg.projectId;
  const requiredScopes = Array.isArray(opts.requiredScopes)
    ? opts.requiredScopes
    : (Array.isArray(cfg.required_scopes) ? cfg.required_scopes : []);
  const sharedScopes = Array.isArray(opts.sharedScopes)
    ? opts.sharedScopes
    : (Array.isArray(cfg.shared_secrets) ? cfg.shared_secrets : []);
  const plan = opts.vaultPlan || vaultScopePlan(ENV_DESCRIPTORS);

  try {
    return resolverVaultConPlan(
      { cfg, projectId, plan, requiredScopes, sharedScopes, opts }, logger,
    );
  } catch (err) {
    // CA-22 — un fallo del vault se PROPAGA como fallo, jamás se degrada a
    // vacío ni habilita el fallback al archivo (B1.2). El mensaje ya viene
    // redactado por `secret-vault.js` (SEC-1/SEC-5: nombra el path lógico y la
    // remediación, nunca el ARN, el account id ni el stdout de la CLI).
    //
    // UX-5 — se narra causa + impacto + próximo paso, no un stack trace.
    logger(`[credentials] ERROR: el vault no pudo resolverse (${(err && err.code) || (err && err.name) || 'error'}). `
      + `Causa: ${(err && err.message) || 'desconocida'}. `
      + 'Impacto: las credenciales respaldadas por el vault quedan SIN SETEAR (fail-closed); '
      + 'NO se cae al archivo. Proximo paso: revisar la remediacion que nombra la causa y reintentar');
    return {
      enabled: true,
      // El namespace sólo se reporta si LLEGÓ a validar: con config inválida no
      // hay namespace que nombrar, y devolver el string mal formado sugeriría
      // que el path se construyó (no se construyó — se falló antes, CA-6).
      namespace: (err && err.vaultNamespace) || null,
      payload: null,
      error: { name: (err && err.name) || 'Error', code: (err && err.code) || null, message: (err && err.message) || '' },
      cfg,
    };
  }
}

/** Extrae el valor de una variable del payload ya resuelto del vault. */
function valorDelVault(estado, dotPath, desc) {
  if (!estado.payload) return undefined;
  const { scope, subPath } = splitDotPath(dotPath);
  const porBackend = estado.payload[desc.backend];
  const scopeObj = porBackend && porBackend[scope];
  if (!scopeObj) return undefined;
  return subPath ? getNested(scopeObj, subPath) : scopeObj;
}

const VAULT_ONLY_ERROR_CODES = Object.freeze({
  VAULT_DISABLED: 'VAULT_DISABLED',
  VAULT_CONFIG_INDETERMINATE: 'VAULT_CONFIG_INDETERMINATE',
  VAULT_FAILURE: 'VAULT_FAILURE',
  VAULT_SECRET_INVALID: 'VAULT_SECRET_INVALID',
  VAULT_KEY_UNKNOWN: 'VAULT_KEY_UNKNOWN',
});

function vaultOnlyError(code, dotPath) {
  const err = new Error(`credentials: ${code} para ${dotPath}`);
  err.name = 'VaultOnlyCredentialError';
  err.code = code;
  err.logicalKey = dotPath;
  return err;
}

/**
 * Lee una credencial puntual exclusivamente desde el vault. No consulta ni
 * modifica process.env y tampoco habilita archivos o bootstrap legacy.
 */
function resolveVaultOnly(dotPath, opts = {}) {
  const logger = typeof opts.logger === 'function' ? opts.logger : console.error;
  const desc = ENV_DESCRIPTORS[dotPath];
  const fail = (code) => {
    const safeKey = desc ? dotPath : 'clave-no-declarada';
    const err = vaultOnlyError(code, safeKey);
    // Señal local deliberadamente independiente de Telegram. El texto se arma
    // sólo con constantes y la clave lógica allowlisted.
    logger(`[credentials] ${code}: operacion segura no ejecutada para ${safeKey}`);
    throw err;
  };

  if (!desc) return fail(VAULT_ONLY_ERROR_CODES.VAULT_KEY_UNKNOWN);
  const estado = resolverVault(opts, () => {});
  if (estado.indeterminado) return fail(VAULT_ONLY_ERROR_CODES.VAULT_CONFIG_INDETERMINATE);
  if (!estado.enabled) return fail(VAULT_ONLY_ERROR_CODES.VAULT_DISABLED);
  if (estado.error || !estado.payload) return fail(VAULT_ONLY_ERROR_CODES.VAULT_FAILURE);
  const value = valorDelVault(estado, dotPath, desc);
  if (isPlaceholderOrEmpty(value)) return fail(VAULT_ONLY_ERROR_CODES.VAULT_SECRET_INVALID);
  return String(value);
}

// =============================================================================
// #5899 · resolución de secretos POR INSTANCIA contra el vault
// =============================================================================

// UX-OPS-3 — el fail-closed dice POR QUÉ. "El vault está apagado a propósito",
// "no se pudo leer la config", "falta el secreto" y "la config no valida" se
// remedian distinto: colapsarlos a un `ok:false` indiferenciado obliga al
// operador a leer código para saber qué tocar. Misma distinción que la familia
// hermana `VAULT_ONLY_ERROR_CODES` (`indeterminado` viaja aparte de `enabled`).
const INSTANCE_VAULT_ERROR_CODES = Object.freeze({
  VAULT_DISABLED: 'VAULT_DISABLED',
  VAULT_CONFIG_INDETERMINATE: 'VAULT_CONFIG_INDETERMINATE',
  VAULT_CONFIG_INVALID: 'VAULT_CONFIG_INVALID',
  VAULT_SCOPES_REQUIRED: 'VAULT_SCOPES_REQUIRED',
  VAULT_SCOPE_MISSING: 'VAULT_SCOPE_MISSING',
  VAULT_FAILURE: 'VAULT_FAILURE',
});

/**
 * Resuelve los scopes declarados de UNA instancia contra el vault, con el
 * `projectId` de esa instancia.
 *
 * Familia SIN efectos sobre el ambiente (hermana de `resolveVaultOnly`): NO
 * toca `process.env`, NO se apoya en `loadIntoEnv` —que hidrata
 * `opts.env || process.env`— y NO lee el archivo de credenciales ni la ventana
 * de bootstrap (REQ-SEC-10 · CA-3 · CA-17).
 *
 * REQ-SEC-1 — `projectId` entra SÓLO out-of-band (la clave del registry de
 * instancias). El descriptor del producto aporta a lo sumo `scopes`, que pasan
 * por el validador canónico; su `secrets.path` no compone NADA del path del
 * vault: `prefix` y `hostId` salen de config y el tier es explícito.
 *
 * @param {object} args
 * @param {string}   args.projectId       identidad de la instancia (out-of-band)
 * @param {string[]} args.scopes          scopes declarados por la instancia
 * @param {string[]} [args.sharedScopes]  subconjunto que vive en `shared/` (G-3)
 * @param {object} [opts]  `logger`, `vaultConfig`, `vaultDriver`, `pipelineDir`, `now`
 * @returns {{ok:boolean, code:string|null, namespace:string|null,
 *            scopes:object, missing:string[], error?:string}}
 *          Misma forma que `resolveScopedRefs`, así que `redactScoped` la come igual.
 * @throws {VaultConfigError} si el namespace no valida — fail-closed ruidoso,
 *         antes de la clave de la memo y con CERO llamadas al driver (CA-6).
 */
function resolveInstanceVault({ projectId, scopes, sharedScopes } = {}, opts = {}) {
  const logger = typeof opts.logger === 'function' ? opts.logger : console.error;
  const fail = (code, error, missing = []) => ({
    ok: false, code, namespace: null, scopes: {}, missing, error,
  });

  const { cfg, indeterminado } = readVaultConfig(opts, logger);

  // CA-17 / G-4 — con el gate cerrado se falla CERRADO. Jamás se cae al archivo
  // de credenciales: un fallback silencioso es exactamente la degradación que
  // CA-22/B1.2 prohíben. El texto distingue "apagado a propósito" de "no se
  // pudo leer la config", que se remedian distinto.
  // El producto se NOMBRA en el diagnóstico —mismo criterio que
  // `resolveScopedRefs`, que ya nombra el namespace rechazado— para que el
  // operador sepa QUÉ instancia quedó sin credenciales sin abrir el código.
  const producto = String(projectId);
  if (indeterminado) {
    return fail(INSTANCE_VAULT_ERROR_CODES.VAULT_CONFIG_INDETERMINATE,
      `no se pudo leer la seccion \`vault:\` de .pipeline/config.yaml, asi que el producto "${producto}" `
      + 'no puede resolver credenciales y tampoco se puede probar que el vault este apagado a proposito. '
      + 'Impacto: la instancia queda SIN credenciales (fail-closed); NO se cae al archivo. '
      + 'Proximo paso: reparar .pipeline/config.yaml');
  }
  if (!cfg || cfg.enabled !== true) {
    return fail(INSTANCE_VAULT_ERROR_CODES.VAULT_DISABLED,
      `el vault esta APAGADO a proposito (\`vault.enabled: false\` en .pipeline/config.yaml), asi que el `
      + `producto "${producto}" no resuelve credenciales. `
      + 'Esto NO es un problema de credenciales: no falta ningun secreto. '
      + 'Impacto: la instancia queda SIN credenciales (fail-closed); NO se cae al archivo. '
      + 'Proximo paso: encender y poblar el vault (#5339 / #5393)');
  }

  const pedidos = Array.isArray(scopes) ? scopes.filter((s) => typeof s === 'string' && s !== '') : [];
  if (!pedidos.length) {
    return fail(INSTANCE_VAULT_ERROR_CODES.VAULT_SCOPES_REQUIRED,
      `el producto "${producto}" no declara que credenciales necesita. `
      + 'Proximo paso: agregar "secrets.scopes" (array no vacio) al descriptor del producto');
  }

  // G-3 — `shared` es membresía ENUMERADA y acotada a lo pedido; todo lo demás
  // vive en el namespace del host, que es lo que preserva el aislamiento.
  const compartidos = (Array.isArray(sharedScopes) ? sharedScopes : [])
    .filter((s) => pedidos.includes(s));

  let estado;
  try {
    estado = resolverVaultConPlan({
      cfg,
      projectId,
      plan: { ssm: pedidos, secretsmanager: [] },
      // CA-7 — allowlist POR INSTANCIA. `cfg.required_scopes` NO se usa: la
      // unión global autorizaría a cada tenant a los scopes de todos los demás
      // y erosionaría el least-privilege en la capa que menos se ve.
      requiredScopes: pedidos,
      sharedScopes: compartidos,
      opts,
    }, logger);
  } catch (err) {
    // CA-6 — la config inválida se propaga como `VaultConfigError`: fail-closed
    // ruidoso, nunca sanitizado en silencio. El error nombra la CLAVE de config.
    if (err && err.name === 'VaultConfigError') throw err;

    // UX-OPS-3 — "falta el secreto" se remedia cargándolo; el resto, mirando el
    // log del vault. REQ-SEC-9: viajan NOMBRES y códigos, nunca `err.message`
    // crudo del vault ni el stdout de la CLI.
    if (err && err.code === 'VAULT_SECRET_MISSING') {
      const faltante = (err && err.scope) ? [err.scope] : [...pedidos];
      return fail(INSTANCE_VAULT_ERROR_CODES.VAULT_SCOPE_MISSING,
        `al producto "${projectId}" le falta en el vault el scope declarado: ${faltante.join(', ')}. `
        + 'Impacto: la instancia queda SIN credenciales (fail-closed). '
        + `Proximo paso: subir ese scope al vault bajo el namespace del producto "${projectId}"`,
        faltante);
    }
    logger(`[credentials] ERROR: el vault no pudo resolver los scopes de la instancia `
      + `"${projectId}" (${(err && err.code) || (err && err.name) || 'error'}). `
      + 'Impacto: la instancia queda SIN credenciales (fail-closed); NO se cae al archivo. '
      + 'Proximo paso: revisar el log del vault, que nombra la causa y su remediacion');
    return fail(INSTANCE_VAULT_ERROR_CODES.VAULT_FAILURE,
      `no se pudieron resolver contra el vault las credenciales del producto "${projectId}" `
      + `(scopes: ${pedidos.join(', ')} · error: ${(err && err.code) || (err && err.name) || 'desconocido'}). `
      + 'Impacto: la instancia queda SIN credenciales (fail-closed); NO se cae al archivo. '
      + 'Proximo paso: revisar el log del vault, que nombra la causa y su remediacion');
  }

  const resueltos = (estado && estado.payload && estado.payload.ssm) || {};
  // Copia sin prototipo: un scope llamado `toString` o `constructor` no puede
  // resolver contra `Object.prototype` y entregar una función como si fuera un
  // secreto (mismo criterio que `resolveScopedRefs`, CA-5 de #5898).
  const seguro = Object.assign(Object.create(null), resueltos);
  const out = Object.create(null);
  const missing = [];
  for (const s of pedidos) {
    const v = Object.prototype.hasOwnProperty.call(seguro, s) ? seguro[s] : undefined;
    if (v === undefined || v === null) missing.push(s);
    else out[s] = v;
  }
  if (missing.length) {
    return fail(INSTANCE_VAULT_ERROR_CODES.VAULT_SCOPE_MISSING,
      `al producto "${projectId}" le faltan credenciales en el vault: ${missing.join(', ')}. `
      + 'Impacto: la instancia queda SIN credenciales (fail-closed). '
      + `Proximo paso: subir esos scopes al vault bajo el namespace del producto "${projectId}"`,
      missing);
  }

  // La forma pública es literal (no el objeto sin prototipo): devolverlo crudo
  // pondría rojo cualquier `deepEqual` strict contra `{}` (R-4 de #5898).
  return { ok: true, code: null, namespace: estado.namespace, scopes: { ...out }, missing: [] };
}

// Índice inverso del mapping legacy (`TELEGRAM_BOT_TOKEN` → `bot_token`), para
// poder leer del archivo legacy aun cuando la iteración va por el descriptor.
const LEGACY_KEY_BY_ENV = Object.freeze(Object.fromEntries(
  Object.entries(LEGACY_MAPPING).map(([flat, envVar]) => [envVar, flat]),
));

/**
 * Popula `env` con las credenciales mapeadas. **Sync** (D-SYNC-1): el retorno
 * es el objeto de resultado, nunca una `Promise`.
 *
 * Fuentes, en orden: `process.env` preexistente (salvo anclas) → vault →
 * ventana de bootstrap sobre el archivo → fail-closed.
 *
 * @param {object} [opts]
 * @param {function} [opts.logger=console.log] Logger para warnings/errors.
 * @param {string}   [opts.canonicalPath]      Path del archivo canónico (override para tests).
 * @param {string}   [opts.legacyPath]         Path del archivo legacy (override para tests).
 * @param {object}   [opts.env=process.env]    Env target (override para tests).
 * @param {object}   [opts.vaultConfig]        Sección `vault:` inyectada (tests).
 * @param {string}   [opts.pipelineDir]        Raíz de `.pipeline` para resolver config.yaml.
 *                                             Por default se fija en código (`REPO_ROOT`):
 *                                             el ENTORNO no elige la autoridad (B2.7).
 * @param {object}   [opts.vaultDriver]        Driver del vault inyectado (tests).
 * @param {function} [opts.now]                Reloj inyectable en ms (tests de la ventana B1.5).
 * @param {object}   [opts.shadowMetrics]      Núcleo de la ventana sombra inyectado (#5448, tests).
 * @returns {{source: string, hydrated: string[], skipped_existing: string[],
 *           skipped_empty: string[], missing: string[], sources: object, vault: object}}
 */
function loadIntoEnv(opts = {}) {
  const logger = typeof opts.logger === 'function' ? opts.logger : console.log;
  const canonicalPath = opts.canonicalPath || CANONICAL_PATH;
  const legacyPath = opts.legacyPath || LEGACY_PATH;
  const env = opts.env || process.env;

  const result = {
    source: 'none',
    hydrated: [], skipped_existing: [], skipped_empty: [],
    // Campos NUEVOS (#5353). `hydrated` / `skipped_existing` / `skipped_empty`
    // no cambian de forma: siguen siendo arrays de NOMBRES de env var.
    missing: [],   // B1.1 — fail-closed: quedaron SIN SETEAR
    sources: {},   // UX-2 — origen por variable
    vault: { enabled: false, namespace: null, error: null },
  };

  const vaultEstado = resolverVault(opts, logger);
  result.vault = {
    enabled: vaultEstado.enabled,
    // B2.7 — visible para quien audite el arranque: `enabled:false` con
    // `indeterminado:true` NO es "el operador apagó el vault", es "no se pudo
    // leer la config", y las anclas se trataron como fail-closed.
    indeterminado: !!vaultEstado.indeterminado,
    namespace: vaultEstado.namespace,
    error: vaultEstado.error,
  };

  // B2.7 — fail-closed de las anclas cuando el gate quedó INDETERMINADO (no se
  // pudo leer config.yaml). Va ACÁ, antes de cualquier salida temprana: los
  // caminos "no hay archivo de credenciales" y "el legacy es JSON inválido"
  // retornan sin llegar al loop de precedencia, y ahí el ancla preseteada
  // sobreviviría intacta — que es exactamente el bypass que hay que cerrar.
  //
  // No se puede probar que el vault esté apagado a propósito, así que el ancla
  // NO vuelve al régimen de `process.env`: se descarta y se cuenta como
  // faltante, igual que cuando el gate está abierto y el vault no la tiene
  // (B2.4). Las 12 no-ancla no se tocan: su camino sigue siendo el del gate
  // cerrado, idéntico al de antes de #5353.
  const anclasCerradas = new Set();
  if (vaultEstado.indeterminado) {
    for (const envVar of ANCHOR_ENV_VARS) {
      if (env[envVar] && String(env[envVar]).length > 0) {
        delete env[envVar];
        logger(`[credentials] WARN: ${envVar} estaba preseteada en el ambiente y se DESCARTO. `
          + 'Causa: no se pudo leer config.yaml, asi que no hay forma de probar que el vault este '
          + 'apagado a proposito, y un ancla de autorizacion no puede venir del ambiente (B2.7). '
          + 'Impacto: el gate del operador queda con cero firmantes (fail-closed). '
          + 'Proximo paso: reparar config.yaml y, si el vault esta encendido, subir el ancla al vault');
      }
      result.missing.push(envVar);
      result.sources[envVar] = SOURCE.MISSING;
      anclasCerradas.add(envVar);
    }
  }

  let data = null;
  let usingMapping = null;

  if (fs.existsSync(canonicalPath)) {
    try {
      data = readJsonFile(canonicalPath);
      result.source = 'canonical';
      usingMapping = ENV_MAPPING;
    } catch (e) {
      logger(`[credentials] WARN: ${canonicalPath} es JSON invalido (${e.message}); intentando fallback al legacy`);
    }
  }

  if (!data && fs.existsSync(legacyPath)) {
    try {
      data = readJsonFile(legacyPath);
      result.source = 'legacy';
      usingMapping = LEGACY_MAPPING;
      logger(`[credentials] WARN: usando archivo legacy ${legacyPath}. Migrar a ${canonicalPath} (ver docs/runbooks/credential-rotation.md)`);
    } catch (e) {
      logger(`[credentials] ERROR: legacy ${legacyPath} es JSON invalido (${e.message}); process.env queda como esta`);
      if (!vaultEstado.enabled) return result;
    }
  }

  if (!data) {
    if (!vaultEstado.enabled) {
      // Con el gate cerrado, sin archivo no hay nada que hacer: exactamente el
      // mismo mensaje y el mismo camino de salida que antes de #5353.
      logger(`[credentials] WARN: no se encontro ${canonicalPath} ni ${legacyPath}; process.env queda como esta`);
      return result;
    }
    // Con el gate abierto la ausencia del archivo es el estado ESPERADO
    // (Gherkin 1 / B1.8): la fuente primaria es el vault. Decir "process.env
    // queda como esta" acá sería falso — el vault sí va a hidratar.
    logger('[credentials] no hay archivo de credenciales local; se resuelve todo contra el vault '
      + '(estado esperado con `vault.enabled: true`)');
  }

  // B1.2 — la ventana de bootstrap sólo se evalúa con el gate del vault
  // ABIERTO, y NUNCA se evalúa si el vault falló: un error de red, de sesión o
  // de permisos no puede habilitar la lectura del archivo (sería fail-open
  // disfrazado, activable por cualquiera que degrade la red).
  const bootstrap = (vaultEstado.enabled && !vaultEstado.error)
    ? evaluarVentanaBootstrap(vaultEstado.cfg, {
        canonicalPath, legacyPath, logger,
        ahora: typeof opts.now === 'function' ? opts.now() : Date.now(),
      })
    : { activo: false, motivo: vaultEstado.error ? 'vault-fallido' : 'gate-cerrado' };

  /** Valor de la variable en el archivo, con el mapping que corresponda. */
  const leerDelArchivo = (dotPath, envVar) => {
    if (!data) return undefined;
    if (usingMapping === LEGACY_MAPPING) {
      const flat = LEGACY_KEY_BY_ENV[envVar];
      return flat === undefined ? undefined : data[flat];
    }
    return dotPath ? getNested(data, dotPath) : undefined;
  };

  // Con el gate cerrado y archivo legacy se itera el mapping legacy, igual que
  // antes de #5353. En cualquier otro caso manda el descriptor.
  const entradas = (!vaultEstado.enabled && usingMapping === LEGACY_MAPPING)
    ? Object.values(LEGACY_MAPPING).map((envVar) => ({ dotPath: null, envVar }))
    : Object.entries(ENV_MAPPING).map(([dotPath, envVar]) => ({ dotPath, envVar }));

  let huboVault = false;
  let huboBootstrap = false;

  for (const { dotPath, envVar } of entradas) {
    const desc = dotPath ? ENV_DESCRIPTORS[dotPath] : null;
    // B2.1 — el ancla sólo cambia de régimen con el gate ABIERTO.
    const esAncla = vaultEstado.enabled && !!(desc && desc.auth_anchor);
    const preexistente = !!(env[envVar] && String(env[envVar]).length > 0);

    // B2.7 — el ancla ya se cerró arriba, antes de las salidas tempranas.
    if (anclasCerradas.has(envVar)) continue;

    // B2.6 — para las 12 no-ancla la precedencia NO cambia: `process.env`
    // preseteado sigue ganando. Esta hija no es el lugar para reordenar la
    // precedencia de las API keys.
    if (preexistente && !esAncla) {
      result.skipped_existing.push(envVar);
      result.sources[envVar] = SOURCE.ENV_PREEXISTING;
      continue;
    }

    // ---- Fuente primaria: el vault ----
    if (vaultEstado.enabled && desc && desc.backend !== 'file-only') {
      const valor = valorDelVault(vaultEstado, dotPath, desc);
      if (!isPlaceholderOrEmpty(valor)) {
        // B2.3 — el shadowing se ve en el log. SÓLO el nombre de la variable:
        // prohibido el valor, un prefijo, un sufijo o un hash. Es un chat_id, y
        // un hash sobre un espacio de valores chico se revierte por fuerza bruta.
        if (esAncla && preexistente && String(env[envVar]) !== String(valor)) {
          logger(`[credentials] WARN: ${envVar} venia preseteada en el ambiente con un valor DISTINTO `
            + 'al del vault y fue SOBRESCRITA. Causa: es un ancla de autorizacion y se resuelve solo '
            + 'desde el vault (B2.2). Impacto: la allowlist de firmantes del gate del operador '
            + 'queda definida por el vault. Proximo paso: quitar esa variable del ambiente del host');
        }
        env[envVar] = String(valor);
        result.hydrated.push(envVar);
        result.sources[envVar] = SOURCE.VAULT;
        huboVault = true;
        continue;
      }

      // SEC-5 — el mensaje nombra el PATH LÓGICO del secreto
      // (`providers/openai/api_key`), nunca el ARN, el account id ni el valor.
      const faltante = dotPath.replace(/\./g, '/');

      // B1.7 / B2.4 — las anclas NO tienen fallback: ni a archivo (ni con el
      // flag encendido ni dentro de la ventana), ni a `process.env`, ni default.
      if (esAncla) {
        if (preexistente) {
          // Sin esto, cerrar el shadowing no cerraría nada: el valor del
          // ambiente seguiría sosteniendo la allowlist de firmantes.
          delete env[envVar];
          logger(`[credentials] WARN: ${envVar} estaba preseteada en el ambiente y se DESCARTO. `
            + 'Causa: el vault no tiene el ancla de autorizacion, y un ancla no puede venir del ambiente (B2.4). '
            + 'Impacto: el gate del operador queda con cero firmantes (fail-closed). '
            + `Proximo paso: subir "${faltante}" al vault`);
        }
        result.missing.push(envVar);
        result.sources[envVar] = SOURCE.MISSING;
        logger(`[credentials] ERROR: falta el ancla de autorizacion "${faltante}" en el vault. `
          + `Impacto: ${envVar} queda SIN SETEAR y el gate del operador no autoriza a nadie. `
          + `Proximo paso: subir "${faltante}" al vault (ver docs/pipeline/vault-secretos-aws.md)`);
        continue;
      }

      // B1.3 / B1.5 — la ventana de bootstrap es la única puerta al archivo, y
      // sólo si el operador la encendió a mano y no caducó.
      if (bootstrap.activo) {
        const raw = leerDelArchivo(dotPath, envVar);
        if (!isPlaceholderOrEmpty(raw)) {
          env[envVar] = String(raw);
          result.hydrated.push(envVar);
          // B1.6 — el source del fallback es `file-bootstrap`. NUNCA `vault`.
          result.sources[envVar] = SOURCE.FILE_BOOTSTRAP;
          huboBootstrap = true;
          logger(`[credentials] WARN: ${envVar} se resolvio por la ventana de bootstrap, no por el vault. `
            + `Proximo paso: subir "${faltante}" al vault antes de que la ventana caduque`);
          continue;
        }
      }

      // B1.1 — fail-closed NOMBRANDO el secreto faltante. La variable queda SIN
      // SETEAR: nunca cadena vacía, nunca un default.
      result.missing.push(envVar);
      result.sources[envVar] = SOURCE.MISSING;
      logger(`[credentials] ERROR: falta el secreto "${faltante}" en el vault. `
        + `Impacto: ${envVar} queda SIN SETEAR (fail-closed) y el componente que la use fallara. `
        + `Proximo paso: subir "${faltante}" al vault (ver docs/pipeline/vault-secretos-aws.md)`);
      continue;
    }

    // ---- Camino del archivo (gate cerrado, o backend `file-only`) ----
    const raw = leerDelArchivo(dotPath, envVar);
    if (isPlaceholderOrEmpty(raw)) {
      result.skipped_empty.push(envVar);
      // UX-3 — "no configurada" y "vacia a proposito" dejan de ser lo mismo.
      result.sources[envVar] = (raw === undefined || raw === null) ? SOURCE.MISSING : SOURCE.EMPTY;
      continue;
    }
    env[envVar] = String(raw);
    result.hydrated.push(envVar);
    result.sources[envVar] = (usingMapping === LEGACY_MAPPING) ? SOURCE.LEGACY : SOURCE.CANONICAL;
  }

  // `result.source` conserva su forma de siempre y gana el valor `'vault'`
  // cuando alguna variable salió efectivamente del vault. La respuesta fina, por
  // variable, está en `result.sources` (UX-2).
  if (huboVault) result.source = SOURCE.VAULT;
  else if (huboBootstrap) result.source = SOURCE.FILE_BOOTSTRAP;

  // ---------------------------------------------------------------------------
  // #5427 · CA-14/CA-16 — hook ÚNICO de la ventana sombra (#5448)
  // ---------------------------------------------------------------------------
  //
  // Un solo call site = una sola superficie de regresión: no se re-instrumenta
  // ninguna rama del bucle de precedencia ni cambia la forma de `result`.
  //
  // CA-25 — sólo con el gate ABIERTO. Las salidas tempranas (`!vaultEstado.enabled`)
  // quedan sin instrumentar a propósito: con el gate cerrado no existe la
  // dicotomía vault/fallback y esas filas ensuciarían el denominador de CA-18.
  //
  // CA-16 — sync y sin I/O de red. Append a archivo sí; HTTP/Telegram no.
  // El `require` es perezoso para que el camino del gate cerrado ni cargue el
  // módulo. Todo el hook va en `try/catch`: la observabilidad NUNCA puede
  // tumbar el arranque de credenciales.
  //
  // `opts.shadowMetrics` inyecta el núcleo: es lo que usan los tests para no
  // escribir en el `.pipeline/audit/` real. En producción nadie lo pasa y se
  // usa el singleton del proceso.
  //
  // GUARDA DE INTEGRIDAD DE LA AUDITORÍA — a nivel de módulo, un boot de prueba
  // es indistinguible de uno real: mismo `loadIntoEnv`, mismo gate, mismo
  // singleton. Sin esta guarda, cualquier test que bootee con el gate abierto
  // (y hay decenas en credentials-vault-5353.test.js) inyecta filas sintéticas
  // en la evidencia sobre la que #5427 decide retirar el fallback, y —peor— una
  // vía negativa sintética REINICIA el t0 real, así que la ventana no cerraría
  // nunca mientras alguien corra la suite. Bajo `node --test` y sin inyección
  // explícita, entonces, no se instrumenta. `NODE_TEST_CONTEXT` lo pone el
  // runner de Node en el proceso hijo; no es configuración que alguien elija.
  if (vaultEstado.enabled) {
    try {
      // El `require` queda acá adentro para que el camino del gate cerrado ni
      // llegue a cargar el módulo.
      const metrics = opts.shadowMetrics
        || (process.env.NODE_TEST_CONTEXT ? null : require('./vault-shadow-metrics').getVaultShadowMetrics({
            notify: require('./notify-telegram').notifyTelegram,
        }));
      if (metrics) metrics.record(result.sources, {
        hostId: vaultEstado.cfg && vaultEstado.cfg.hostId,
        // Sólo lo hidratable: ver el comentario de `HYDRATED_DESCRIPTORS`.
        descriptors: HYDRATED_DESCRIPTORS,
      });
    } catch (e) {
      // Sólo el nombre del error: una excepción cruda podría arrastrar datos.
      logger(`[credentials] WARN: no se pudo registrar la ventana sombra del vault (${(e && e.name) || 'Error'}). `
        + 'Impacto: se subcuenta la cobertura y la ventana tarda mas en cerrar (fail-closed). '
        + 'Proximo paso: revisar permisos de .pipeline/audit/');
    }
  }

  return result;
}

// =============================================================================
// resolveScopedRefs — brokering de secretos por producto (#4687 · CA-C2)
//
// Aislamiento de blast radius (§5.1 · requisito de seguridad #3): un descriptor
// referencia credenciales por `ref` namespaceado + `scopes` declarados. El loader
// entrega SOLO los scopes declarados de ese namespace, SIN expandir a todo el
// archivo de credenciales. Preserva el mapping legacy (loadIntoEnv intacto).
//
// El valor de retorno CONTIENE los secretos resueltos (para inyección de env por
// proceso). Para logs/output usar `redactScoped()` — NUNCA loguear el objeto crudo.
// =============================================================================

// Bloques globales del store: NO son namespaces de tenant. Un projectId que
// coincida con uno de estos NO puede resolverlo (#5898 · D1 · A01/CWE-863).
//
// El control vive ACÁ y no en la validación de identidad porque `SAFE_ID_RE`
// (`project-descriptor.js:114`) admite `providers`, `telegram` y `aws` como
// projectId perfectamente válidos — el aislamiento estaba invertido: el tenant
// honesto fallaba y el que se registraba como `providers` cobraba las llaves de
// todos los proveedores.
//
// UNA SOLA definición: quien la necesite la importa desde acá, no la copia
// (CA-3). Si mañana se agrega un bloque global al store y no se suma a esta
// lista, el test de CA-3 de `credentials-namespace-5898.test.js` se pone rojo.
const RESERVED_STORE_NAMESPACES = Object.freeze([
  'telegram', 'providers', 'multimedia', 'aws', 'google_drive', 'aws_vault_bootstrap',
]);

// Claves que resuelven contra `Object.prototype` en un lookup ingenuo
// (#5898 · D2 · A03/CWE-1321).
const UNSAFE_JS_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

// `~/.claude/secrets/credentials.json#intrale`  →  { path, namespace }
function parseSecretRef(ref) {
  const m = /^(~?[A-Za-z0-9._/-]+)#([A-Za-z0-9._:-]+)$/.exec(String(ref == null ? '' : ref).trim());
  if (!m) return null;
  return { path: m[1], namespace: m[2] };
}

function expandHome(p) {
  if (typeof p === 'string' && (p === '~' || p.startsWith('~/'))) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * ¿El path de la ref cae DENTRO del store canónico y FUERA del repo? (CA-4)
 *
 * Son DOS condiciones conjuntas, no una. `estaDentroDelRepo` responde "¿está
 * dentro del repo?" y en su otro uso (ventana de bootstrap) sirve para
 * RECHAZAR; el store canónico vive fuera del repo. Reusarla tal cual como
 * "¿es válido?" rechazaría el store legítimo y aceptaría todo lo de afuera —
 * el agujero al revés.
 *
 * El control es SEMÁNTICO sobre el path resuelto, no sintáctico sobre el
 * literal: `path.resolve` normaliza `..` antes de comparar, así que
 * `~/.claude/secrets/../../evil.json` cae fuera de STORE_DIR y se rechaza.
 * Un regex que prohibiera `..` se eludiría con encodings y rompería paths
 * legítimos — por eso NO se toca `parseSecretRef`.
 *
 * Residual aceptado (R-8, seguimiento en #5912): el ancla es lógica, no
 * física. Un symlink DENTRO de STORE_DIR apuntando afuera la elude; endurecer
 * con `fs.realpathSync` quedó fuera del alcance de #5898.
 */
function refPathAnclado(rawPath) {
  const abs = path.resolve(expandHome(String(rawPath == null ? '' : rawPath)));
  const rel = path.relative(STORE_DIR, abs);
  const dentroDelStore = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  return dentroDelStore && !estaDentroDelRepo(abs);   // ← conjunción, NO alternativa
}

/**
 * Resuelve SOLO los scopes declarados de un namespace del archivo de credenciales.
 *
 * @param {string} ref     referencia namespaceada (`path#namespace`).
 * @param {string[]} scopes scopes declarados por el descriptor.
 * @param {object} [opts]
 * @param {object} [opts.data]  credentials ya parseadas (override de confianza; evita leer disco).
 * @param {string} [opts.canonicalPath] path del archivo (override de confianza; ver paso 6).
 * @param {boolean} [opts.systemNamespace] opt-in EXPLÍCITO de consumidor de primera
 *        parte: saltea SÓLO el paso 4 (deny-list de bloques globales) y ningún otro.
 *        El default —y por lo tanto todo dato que venga de un descriptor— sigue
 *        siendo el camino de tenant.
 * @returns {{ ok:boolean, namespace:string|null, scopes:object, missing:string[], error?:string }}
 */
function resolveScopedRefs(ref, scopes, opts = {}) {
  // Helper único de fail-closed: ningún camino puede salir con `error:
  // undefined` ni con un texto terminal genérico (CA-6). Cada mensaje dice
  // QUÉ pasó · POR QUÉ · QUÉ HACER, sin jerga de implementación y sin valores.
  const fail = (code, namespace, error, missing = []) => ({
    ok: false, code, namespace, scopes: {}, missing, error,
  });

  // 1 · ref mal formada.
  const parsed = parseSecretRef(ref);
  if (!parsed) {
    return fail('ref_invalida', null,
      'ref inválida: la referencia de credenciales está mal formada, se esperaba "<archivo>#<namespace>". '
      + 'Revisá "secrets.path" del descriptor del producto.');
  }
  const ns = parsed.namespace;

  // 2 · el producto no declara qué necesita.
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return fail('scopes_requeridos', ns,
      `el producto "${ns}" no declara qué credenciales necesita. `
      + 'Agregá "secrets.scopes" (array no vacío) al descriptor.');
  }

  // 3 · claves internas de JS como namespace (prototype pollution · CA-5).
  if (UNSAFE_JS_KEYS.includes(ns)) {
    return fail('namespace_invalido', ns,
      `namespace "${ns}" no es un nombre válido. Elegí un projectId que no sea una clave interna `
      + `de JavaScript (${UNSAFE_JS_KEYS.join(', ')}).`);
  }

  // 4 · bloque global del store pedido como namespace de tenant (CA-1/CA-2).
  //     Va ANTES de leer el archivo y DENTRO del resolver, para que cubra por
  //     igual a `kernel-supervisor`, `product-seed` (que pasa la ref verbatim)
  //     y `kernel-store`, sin que ningún call-site agregue su propia validación.
  //
  //     OPT-IN DE PRIMERA PARTE (`opts.systemNamespace === true`). Los bloques
  //     globales tienen consumidores LEGÍTIMOS del propio sistema: #5217 hizo de
  //     `qa-video-share.js` el lector de `google_drive`/`r2` del store, y ahí
  //     `google_drive` no es "el tenant que se registró con nombre de bloque
  //     global" sino el bloque global leído por quien es su dueño. Sin este
  //     opt-in la deny-list no protege: rompe al dueño y deja al pipeline sin
  //     credenciales de Drive (#5217 puso `hydrate:false`, así que no hay red
  //     de `process.env` debajo).
  //
  //     Por qué un flag y NO sacar `google_drive` de la lista ni abrir un
  //     segundo camino de resolución: sacarlo reabriría D1 (A01/CWE-863) para
  //     cualquier `projectId = 'google_drive'`, y un segundo resolver rompería
  //     la invariante de punto único. El flag es un booleano estricto que
  //     saltea SÓLO este paso — 3, 5, 6, 7 y 8 corren igual — y que no puede
  //     viajar dentro de un descriptor: `product-seed.js` pasa la ref verbatim
  //     pero NUNCA opts, así que D4 sigue cerrado por construcción.
  //
  //     `=== true` a propósito: un `opts` con `systemNamespace` truthy-por-
  //     accidente (string, 1, {}) no alcanza para saltear un control de acceso.
  const esPrimeraParte = opts.systemNamespace === true;
  if (RESERVED_STORE_NAMESPACES.includes(ns) && !esPrimeraParte) {
    return fail('namespace_reservado', ns,
      `"${ns}" es un bloque global del sistema, no un producto. Registrá el producto con otro `
      + `projectId — están reservados: ${RESERVED_STORE_NAMESPACES.join(', ')}.`);
  }

  // 5 · path anclado al store canónico (CA-4). Corre ANTES de cualquier
  //     lectura: el rechazo es "sin abrir el archivo", literal.
  if (!refPathAnclado(parsed.path)) {
    return fail('path_fuera_del_store', ns,
      `el archivo de credenciales "${parsed.path}" está fuera de ${STORE_DIR_LOGICO} (namespace "${ns}"). `
      + `Movelo ahí o corregí "secrets.path" del descriptor.`);
  }

  // 6 · lectura del store.
  //
  //     `opts.canonicalPath` es un OVERRIDE DE CONFIANZA, con el mismo criterio
  //     que `opts.data` —que ya se acepta sin ancla ninguna, y es estrictamente
  //     más poderoso: entrega el contenido del store directamente—. Los dos son
  //     argumentos JS de un call-site de primera parte en el mismo proceso; NO
  //     son dato de descriptor. Quien puede pasar `opts` ya está adentro.
  //
  //     Dónde vive CA-4, entonces: en `parsed.path` (paso 5), que SÍ sale del
  //     descriptor y es lo único que un tercero controla. Ese ancla no se
  //     toca — `~/.claude/secrets/../../evil.json#ns` se sigue rechazando sin
  //     abrir archivo, con `opts.canonicalPath` o sin él.
  //
  //     Anclar además el path efectivo no agregaba defensa (el atacante del
  //     modelo no llega a `opts`) y sí rompía a los consumidores de primera
  //     parte: el arnés de #5217 apunta a un store de `tmpdir`, y por esta
  //     rama se caía hasta el caso de `r2`, que ni siquiera está en la
  //     deny-list.
  let data = opts.data;
  if (!data) {
    const filePath = opts.canonicalPath || expandHome(parsed.path);
    try {
      data = readJsonFile(filePath);
    } catch (e) {
      return fail('store_ilegible', ns,
        `no se pudo leer el archivo de credenciales del sistema (namespace "${ns}"). `
        + `Verificá que ${STORE_FILE_LOGICO} exista y sea JSON válido.`);
    }
  }

  // 7 · lookup del namespace. `hasOwnProperty`, NUNCA acceso directo:
  //     `data.namespaces.__proto__` es truthy aunque `namespaces` no lo declare.
  //
  //     Sin fallback top-level cuando el store tiene `namespaces` (CA-1.b): el
  //     nombre puede existir en la raíz y aun así NO resuelve. La retrocompat
  //     top-level sobrevive SÓLO para stores sin `namespaces` — y aun ahí la
  //     deny-list del paso 4 ya cerró los bloques globales. Cuando #5217 migre
  //     el store, el fallback se apaga POR CONSTRUCCIÓN, sin un segundo cambio.
  //
  //     DÓNDE BUSCA CADA CAMINO. Los dos espacios del store no son el mismo y
  //     el opt-in del paso 4 elige entre ellos, no los mezcla:
  //       · primera parte  → bloque global, que vive TOP-LEVEL por definición
  //         (`telegram`, `providers`, `google_drive`… son claves de la raíz;
  //         `namespaces` es donde van los tenants). Buscar bajo `namespaces`
  //         sería buscar al dueño en la casa del inquilino.
  //       · tenant (default) → `namespaces.<id>`, con la retrocompat de abajo.
  //     Sigue siendo UN solo punto de resolución: mismo `fail`, mismos pasos
  //     3/5/6/8, misma forma de retorno. Lo único que cambia es la raíz del
  //     lookup, y sólo cuando el call-site se declaró explícitamente.
  const nsRoot = (data && typeof data.namespaces === 'object' && data.namespaces) || null;
  let nsObj = null;
  if (esPrimeraParte) {
    if (data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, ns)) nsObj = data[ns];
  } else if (nsRoot) {
    if (Object.prototype.hasOwnProperty.call(nsRoot, ns)) nsObj = nsRoot[ns];
  } else if (data && typeof data === 'object') {
    if (Object.prototype.hasOwnProperty.call(data, ns)) nsObj = data[ns];
  }

  if (!nsObj || typeof nsObj !== 'object') {
    // El remedio no es el mismo para los dos espacios: mandar al dueño de un
    // bloque global a crear `namespaces."google_drive"` lo haría migrar el
    // secreto al lugar equivocado y romper al resto de sus lectores.
    return fail('namespace_inexistente', ns,
      esPrimeraParte
        ? `namespace no encontrado: el bloque del sistema "${ns}" no tiene credenciales cargadas. `
          + `Agregá el bloque "${ns}" en la raíz de ${STORE_FILE_LOGICO}.`
        : `namespace no encontrado: el producto "${ns}" no tiene credenciales cargadas. `
          + `Agregá el bloque namespaces."${ns}" en ${STORE_FILE_LOGICO}.`,
      [...scopes]);
  }

  // 8 · scopes. La copia sin prototipo evita que un scope como `toString` o
  //     `constructor` resuelva contra Object.prototype y se entregue una
  //     función nativa como si fuera un secreto (CA-5).
  const safeNs = Object.assign(Object.create(null), nsObj);
  const out = Object.create(null);
  const missing = [];
  for (const s of scopes) {
    if (UNSAFE_JS_KEYS.includes(s)) { missing.push(s); continue; }
    const v = Object.prototype.hasOwnProperty.call(safeNs, s) ? safeNs[s] : undefined;
    if (typeof v === 'function') { missing.push(s); continue; }
    if (v !== undefined && !isPlaceholderOrEmpty(v)) out[s] = v;
    else missing.push(s);
  }

  if (missing.length > 0) {
    return {
      ok: false,
      code: 'scope_faltante',
      namespace: ns,
      // La forma pública NO cambia: spread a objeto literal. Devolver `out`
      // crudo (sin prototipo) pondría rojo cualquier `assert.deepEqual` strict
      // contra `{}` — la protección va adentro, no en la forma devuelta (R-4).
      scopes: { ...out },
      missing,
      error: `al producto "${ns}" le faltan credenciales: ${missing.join(', ')}. `
        + `Cargalas en namespaces."${ns}" de ${STORE_FILE_LOGICO}.`,
    };
  }

  return { ok: true, namespace: ns, scopes: { ...out }, missing };
}

// Redacta un resultado de resolveScopedRefs para logging: sólo nombres de scope,
// nunca valores (CA-C3).
function redactScoped(resolved) {
  if (!resolved || typeof resolved !== 'object') return { namespace: null, scopes: [] };
  const red = {
    ok: !!resolved.ok,
    namespace: resolved.namespace || null,
    scopes: Object.keys(resolved.scopes || {}),
    missing: resolved.missing || [],
  };
  // `code` y `error` viajan a la forma redactada para que el diagnóstico que
  // llega al operador sea accionable (CA-6/CA-6.b). Ninguno de los dos contiene
  // valores de credencial: sólo nombres de namespace, de scope y remediación.
  if (resolved.code) red.code = resolved.code;
  if (resolved.error) red.error = resolved.error;
  return red;
}

module.exports = {
  // Los 10 símbolos históricos — ninguno se quita ni cambia de forma.
  loadIntoEnv,
  CANONICAL_PATH,
  LEGACY_PATH,
  ENV_MAPPING,
  LEGACY_MAPPING,
  isPlaceholderOrEmpty,
  getNested,
  parseSecretRef,
  resolveScopedRefs,
  redactScoped,
  // #5898 — vocabulario ÚNICO de namespaces reservados. Se importa, no se
  // copia (CA-3): una segunda lista literal se desincroniza del store.
  RESERVED_STORE_NAMESPACES,
  // Agregados por #5353.
  ENV_DESCRIPTORS,
  // #5217 · CA-6 — predicado único de "¿este secreto va al process.env global?".
  // Se exporta para que los consumidores que enumeran el inventario completo
  // (métricas de cobertura del vault) distingan "no verificado" de "no se
  // hidrata por diseño" sin duplicar la regla.
  seHidrata,
  HYDRATED_DESCRIPTORS,
  VAULT_BACKENDS,
  SOURCE,
  vaultScopePlan,
  _resetVaultCache,
  resolveVaultOnly,
  VAULT_ONLY_ERROR_CODES,
  // #5899 — familia SIN efectos sobre el ambiente, para el camino por
  // instancia. Hermana de `resolveVaultOnly`: nunca pasa por `loadIntoEnv`.
  resolveInstanceVault,
  INSTANCE_VAULT_ERROR_CODES,
  DEFAULT_MAX_CACHED_TENANTS,
  // B2.7 — expuesto SÓLO para el test que verifica que la raíz de la config la
  // fija el código y no el entorno. No tiene call-site productivo fuera de
  // `resolverVault`.
  _readVaultConfig: readVaultConfig,
};

// CLI: dry-run que imprime resumen sin valores. Útil para diagnóstico operativo.
//   node .pipeline/lib/credentials.js
//
// UX-3 — `sources` distingue "no configurada" (`missing`) de "vacia a
// proposito" (`empty`), que antes caían las dos en `skipped_empty` y eran
// indistinguibles. Sigue sin imprimir un solo VALOR: sólo nombres de variable y
// etiquetas de origen (SEC-5).
if (require.main === module) {
  const result = loadIntoEnv({ logger: (m) => process.stderr.write(m + '\n') });
  process.stdout.write(JSON.stringify({
    source: result.source,
    vault: result.vault,
    hydrated_count: result.hydrated.length,
    hydrated: result.hydrated,
    skipped_existing: result.skipped_existing,
    skipped_empty: result.skipped_empty,
    missing: result.missing,
    sources: result.sources,
  }, null, 2) + '\n');
}
