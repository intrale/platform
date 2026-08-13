#!/usr/bin/env node
// =============================================================================
// #5243 (Split de #5218, épico #5215) — TRAMO 2 · Detectar y avisar.
//
// Health-check de secretos al arranque del Pulpo. NO prohíbe nada: detecta y
// reporta. Tres estados (`ok` / `missing` / `chain_broken`), aviso agrupado por
// cuatro canales en orden degradante, y halt suave en dos tiempos.
//
// Frontera de seguridad (SEC-1): `evaluate()` es PURO y NUNCA ve un valor de
// secreto. Recibe sólo NOMBRES: el resultado de `loadIntoEnv` (arrays de env
// vars), el manifiesto (#5242) y un mapa de presencia precalculado. La única
// función que toca valores es `collectPresence()`, del lado del cargador, y lo
// que devuelve son nombres clasificados — nunca el valor, ni un prefijo, ni la
// longitud, ni un hash (CA-7d).
//
// Por qué el halt es SUAVE y no un `process.exit`: `watchdog.ps1` respawnea el
// Pulpo cada 2 min sin leer exit code ni aplicar backoff. Un `exit` en el boot
// reproduce exactamente las 12 h de Commander caído de #5073. El único
// `process.exit` del módulo vive bajo `require.main === module` (rama CLI/CI,
// donde no hay watchdog) — ver CA-5b.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');

const credentials = require('./credentials');
const secretsManifest = require('./secrets-manifest');
const redact = require('./redact');

// -----------------------------------------------------------------------------
// Constantes de contrato
// -----------------------------------------------------------------------------

/** Autoría del marker `.paused` que escribe este módulo (CA-5). */
const HALT_SOURCE = 'secrets-health-halt';

/** Autoría que se registra al levantar la pausa automáticamente (CA-5). */
const AUTO_RECOVERY_SOURCE = 'secrets-auto-recovery';

/** Nombre del artefacto que consume el dashboard (#5230). Precedente: `infra-health.json`. */
const HEALTH_JSON_NAME = 'secrets-health.json';

/**
 * U2 — presupuesto de caracteres del aviso agrupado.
 *
 * `sendTelegramWithMarkup` (`pulpo.js`) corta en 4000 con un `slice` mudo: un
 * truncado silencioso es justo lo que U2 prohíbe. Presupuestamos por debajo del
 * corte duro y truncamos ACÁ, de forma explícita y contada.
 */
const TG_BUDGET = 3600;

/**
 * Ventana de repetición del aviso cuando el estado NO cambió (rev-1 de review).
 *
 * El dedup por firma calla el mensaje repetido, pero un problema que persiste
 * no puede volverse invisible: pasada esta ventana el aviso vuelve a salir una
 * vez. 24 h es el orden de magnitud del vecino (`lastConfigCorruptionAlertMs`
 * en `pulpo.js`) llevado a un canal que se lee una vez por día.
 */
const ALERT_REPEAT_MS = 24 * 60 * 60 * 1000;

/** Estados posibles de una entrada (CA-4). */
const STATE = Object.freeze({ OK: 'ok', MISSING: 'missing', CHAIN_BROKEN: 'chain_broken' });

/** Niveles del contrato de datos (CA-6b). */
const LEVEL = Object.freeze({ OK: 'ok', WARN: 'warn', ALERT: 'alert' });

/** Remediaciones distinguibles (CA-4 / U1): la acción del operador es distinta. */
const REMEDIATION = Object.freeze({ REPONER: 'REPONER', CABLEAR: 'CABLEAR' });

/**
 * U3 — el nombre lógico viene del manifiesto (archivo del repo, editable por
 * cualquier issue) y no puede romper el canal ni el JSON. Se limpian los
 * caracteres de control y se valida contra un alfabeto cerrado.
 * Patrón calcado de `safeSkillName` (`agent-models-change-alert.js`).
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;
const SAFE_NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SAFE_NAME_FALLBACK = '[secreto_invalido]';

/**
 * CA-6b / U9 — copy de `label`: texto corto en español, uno por secreto.
 *
 * El `label` es COPY, no dato de infraestructura: el manifiesto de #5242 trae
 * `name`/`service`/`restore` pero NO trae `label` a propósito. La tabla canónica
 * la entrega UX en `.pipeline/assets/mockups/5243/ux-labels-5243.md` (26 entradas,
 * 1:1 con el manifiesto) y se transcribe acá tal cual — con tildes, que es lo que
 * protege U5. El dev no inventa etiquetas.
 *
 * NO se agrega el campo a `.pipeline/secrets-manifest.json`: ese archivo es el
 * contrato de datos de #5242 y tocarlo desde acá rompe su bloque `_precedence`.
 */
const SECRET_LABELS = Object.freeze({
  'telegram.bot_token': 'token del bot de Telegram',
  'telegram.chat_id': 'chat de Telegram del pipeline',
  'telegram.leo_operator_chat_id': 'chat privado del operador',
  'providers.openai.api_key': 'clave de API de OpenAI',
  'providers.anthropic.api_key': 'clave de API de Anthropic',
  'providers.google.api_key': 'clave de API de Google Gemini',
  'providers.cerebras.api_key': 'clave de API de Cerebras',
  'providers.nvidia.api_key': 'clave de API de NVIDIA NIM',
  'providers.moonshot.api_key': 'clave de API de Moonshot Kimi',
  'google_drive.drive_folder_id': 'carpeta de Google Drive',
  'google_drive.oauth_client_id': 'identificador de cliente OAuth de Google Drive',
  'google_drive.oauth_client_secret': 'secreto de cliente OAuth de Google Drive',
  'google_drive.oauth_refresh_token': 'token de refresco de Google Drive',
  'aws.access_key_id': 'clave de acceso de AWS',
  'aws.secret_access_key': 'clave secreta de AWS',
  'aws.region': 'región de AWS',
  'aws.profile': 'perfil de AWS',
  'aws.table_name': 'tabla de DynamoDB',
  'aws.coordination_table_name': 'tabla de coordinación del pipeline',
  'multimedia.elevenlabs_api_key': 'clave de API de ElevenLabs',
  'multimedia.elevenlabs_voice_id': 'voz de ElevenLabs',
  'github.token': 'token de GitHub',
  'r2.account_id': 'cuenta de Cloudflare R2',
  'r2.access_key_id': 'clave de acceso de Cloudflare R2',
  'r2.secret_access_key': 'clave secreta de Cloudflare R2',
  'r2.bucket': 'bucket de Cloudflare R2',
});

/**
 * Copy por servicio: qué se frena si falta (CA-7 "qué frena"). Texto corto en
 * español, tomado de la tabla de impacto del mismo entregable de UX. Es POR
 * SERVICIO, no por secreto: repetirlo en cada una de las cuatro entradas de `r2`
 * es la pared de texto que U4 prohíbe.
 */
const IMPACTO_POR_SERVICIO = Object.freeze({
  telegram: 'el pipeline queda ciego: no puede avisarte nada ni recibir tus órdenes',
  github: 'no puede leer ni comentar issues: no entra trabajo nuevo',
  providers: 'se cae un proveedor del fallback; el pipeline sigue con los que queden',
  google_drive: 'no se archivan los entregables ni el video de QA',
  aws: 'no se puede aprovisionar ni leer el estado del kernel',
  r2: 'no se comparte el video de QA',
  multimedia: 'no hay voz narrada en los avisos',
});

const IMPACTO_GENERICO = 'el servicio queda sin credencial y su funcion se degrada';

// -----------------------------------------------------------------------------
// Helpers de saneado
// -----------------------------------------------------------------------------

/**
 * U3 — normaliza un nombre lógico para que sea seguro en Telegram, en el log y
 * dentro del JSON. Cualquier cosa fuera del alfabeto cerrado cae al fallback.
 *
 * @param {unknown} name
 * @returns {string}
 */
function safeLabel(name) {
  // Se valida el nombre CRUDO contra el alfabeto cerrado. Limpiar primero y
  // validar después sería peor que no validar: `telegram.bot<LF>token` quedaría
  // como `telegram.bottoken` — un nombre que pasa el filtro, no está en el
  // manifiesto, y manda al operador a buscar un secreto que no existe. Un
  // nombre hostil tiene que caer al fallback, no ser rescatado.
  const s = String(name == null ? '' : name);
  return SAFE_NAME_RE.test(s) ? s : SAFE_NAME_FALLBACK;
}

/**
 * U9 — resuelve el `label` de un secreto. La tabla de UX manda; el fallback
 * garantiza que un secreto nuevo NUNCA deje al operador sin texto legible.
 *
 * Reglas de U9, en orden:
 *  1. `name` en la tabla → copy canónico de UX.
 *  2. `name` fuera de la tabla → se DERIVA: se parte por `.`, se reemplazan `_`
 *     por espacios y queda `<resto> de <servicio>`
 *     (`stripe.webhook_secret` → `webhook secret de stripe`).
 *  3. Nunca devuelve cadena vacía, `undefined`, ni el `name` crudo.
 *
 * El caso del nombre HOSTIL (falla el alfabeto cerrado de U3) es distinto del
 * caso "secreto nuevo" que describe U9: no se puede derivar copy de un nombre
 * que no se puede ni imprimir sin romper el canal. Ahí se degrada a una frase
 * legible anclada al servicio en vez de escupir `[secreto_invalido]`, que es
 * justamente lo que U9 prohíbe mostrarle al operador.
 *
 * @param {unknown} name
 * @param {unknown} service
 * @returns {string}
 */
function labelFor(name, service) {
  const safeName = safeLabel(name);
  if (Object.prototype.hasOwnProperty.call(SECRET_LABELS, safeName)) {
    return SECRET_LABELS[safeName];
  }

  const svcRaw = safeLabel(service || '');
  const svcOk = svcRaw !== SAFE_NAME_FALLBACK ? svcRaw.replace(/_/g, ' ').trim() : '';

  // Nombre inutilizable (hostil, vacío o fuera del alfabeto): no se deriva.
  if (safeName !== SAFE_NAME_FALLBACK) {
    const parts = safeName.split('.').filter(Boolean);
    if (parts.length > 0) {
      const svc = parts.length > 1 ? parts[0].replace(/_/g, ' ').trim() : svcOk;
      const rest = (parts.length > 1 ? parts.slice(1).join(' ') : parts[0])
        .replace(/_/g, ' ')
        .trim();
      if (rest) return svc ? `${rest} de ${svc}` : rest;
    }
  }

  return svcOk ? `secreto no identificado de ${svcOk}` : 'secreto no identificado';
}

/**
 * CA-7d — barrera de salida. Todo texto que sale del módulo (log, marker,
 * JSON, Telegram, y el camino `motivo:` → YAML → GitHub) pasa por acá.
 *
 * @param {unknown} text
 * @returns {string}
 */
function safeText(text) {
  const s = String(text == null ? '' : text).replace(CONTROL_CHARS_RE, ' ');
  try {
    return String(redact.redactSensitive(s));
  } catch {
    // Nunca dejar pasar el crudo si el redactor falla: fail-closed.
    return '[texto_no_redactable]';
  }
}

/**
 * El "grupo" de un secreto = su namespace, es decir el nombre lógico sin el
 * último segmento. `providers.moonshot.api_key` → `providers.moonshot`.
 *
 * Es más fino que `service` a propósito: `providers` agrupa seis proveedores
 * independientes, y que OpenAI esté configurado no implica que Moonshot lo
 * esté. Usar `service` como eje de actividad clasificaría a Moonshot como
 * "activo y faltante" sólo porque OpenAI existe (R-6).
 *
 * @param {string} name
 * @returns {string}
 */
function groupOf(name) {
  const parts = String(name || '').split('.');
  return parts.length > 1 ? parts.slice(0, -1).join('.') : String(name || '');
}

// -----------------------------------------------------------------------------
// Carga (lado del cargador — es el ÚNICO lugar que ve valores)
// -----------------------------------------------------------------------------

/**
 * Carga el manifiesto de #5242. Best-effort: si no existe o no valida, devuelve
 * un manifiesto vacío en vez de lanzar — un health-check que mata el boot es
 * peor que un health-check ausente (#5073).
 *
 * @param {{ path?: string }} [opts]
 * @returns {{ entries: Array<Object> }}
 */
function loadManifest(opts = {}) {
  try {
    const m = secretsManifest.load(opts.path ? { path: opts.path } : {});
    if (m && Array.isArray(m.entries)) return m;
    return { entries: [] };
  } catch {
    return { entries: [] };
  }
}

/**
 * Veredictos de `loadIntoEnv` que significan "el resolver lo resolvió Y ya
 * descartó que el valor fuera relleno". Se derivan del enum del dueño del store
 * (`credentials.SOURCE`), nunca de literales propios: la lista de fuentes
 * válidas cambió dos veces (#5353 sumó `vault`, #5635 sumó `file-bootstrap`) y
 * copiarla acá es la misma clase de duplicación que prohíbe CA-4b.
 *
 * `ENV_PREEXISTING` NO entra en esta lista (rev-2 de verificación). Los otros
 * cuatro veredictos los asigna el resolver DESPUÉS de pasar el valor por
 * `isPlaceholderOrEmpty` (`credentials.js:740` vault, `:785` file-bootstrap,
 * `:809` canonical/legacy). `env-preexisting` no: se asigna mirando sólo
 * `String(env[envVar]).length > 0` (`credentials.js:723,731-733`). Tratarlo como
 * resuelto reabre el fail-open de #4907/#4912 por otra puerta: con `REPLACE_ME`
 * en `process.env` el secreto se reportaba `ok` y el halt se desactivaba. Su
 * clasificación se hace aparte, abajo, contra `isPlaceholderOrEmpty` (CA-4).
 */
const SRC = credentials.SOURCE || {};
const VEREDICTOS_RESUELTOS = Object.freeze(new Set([
  SRC.VAULT, SRC.FILE_BOOTSTRAP, SRC.CANONICAL, SRC.LEGACY,
].filter(Boolean)));

/**
 * Clasifica la PRESENCIA de cada entrada del manifiesto sin dejar salir ningún
 * valor.
 *
 * REGLA DE AUTORIDAD (rev-1 de review) — para `source: store` el veredicto lo
 * da el RESOLVER, no este módulo. `source: store` no dice "está en el archivo
 * canónico": dice "lo resuelve el store canónico", y quién lo materializa es
 * `credentials.loadIntoEnv`, que desde #5353/#5635 puede hacerlo contra el
 * vault. Con `vault.enabled: true` la ausencia del archivo local es el estado
 * ESPERADO (`credentials.js`, textual), así que decidir la presencia leyendo
 * `CANONICAL_PATH` clasificaría las 21 entradas `store` como ausentes, daría
 * `alert` sobre los dos secretos de Telegram y haltearía el pipeline sobre
 * secretos que SÍ están y SÍ resuelven — un halt permanente disparado por un
 * cambio de CONFIG, no de código (#5073).
 *
 * Por eso `loadResult.sources[env_var]` manda: es el veredicto por variable que
 * ya distingue `vault`/`canonical`/`legacy`/`file-bootstrap`/`env-preexisting`
 * de `missing`/`empty`. La lectura del store queda como FALLBACK, y sólo para
 * las entradas sobre las que el resolver no se pronuncia: las `deferred`
 * (`aws.*`, `multimedia.*`), que no están en su mapping porque su consumidor
 * las pide más tarde.
 *
 * La clasificación de "valor no utilizable" se delega en
 * `credentials.isPlaceholderOrEmpty` — la función ya exportada por el dueño del
 * store. Declarar acá una expresión regular propia sería duplicar el criterio
 * y dejar que derive: exactamente el fail-open de #4907/#4912 (CA-4b).
 *
 * @param {{ manifest?: Object, storePath?: string, env?: Object, loadResult?: Object }} [opts]
 * @returns {{ present: string[], placeholder: string[], absent: string[], placeholder_env: string[] }}
 */
function collectPresence(opts = {}) {
  const manifest = opts.manifest || loadManifest();
  const env = opts.env || process.env;
  // `placeholder_env` es aditivo: mismo `placeholder` (cuenta como faltante),
  // pero recuerda que el relleno estaba en el AMBIENTE y no en el store, para
  // que el copy de CA-7 no mande a revisar el archivo equivocado.
  const out = { present: [], placeholder: [], absent: [], placeholder_env: [] };

  // Veredicto por variable del resolver (UX-2 de #5353). Sin `loadResult` el
  // módulo se comporta como antes: cae siempre al fallback de disco.
  const lr = opts.loadResult;
  const veredictos = (lr && typeof lr === 'object' && lr.sources && typeof lr.sources === 'object')
    ? lr.sources
    : null;

  let store = null;
  const storePath = opts.storePath || credentials.CANONICAL_PATH;
  try {
    if (fs.existsSync(storePath)) store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch {
    store = null;
  }

  for (const entry of manifest.entries || []) {
    const name = String(entry && entry.name ? entry.name : '');
    if (!name) continue;

    // `source: store` → lo resuelve el store canónico (hoy: vault, archivo
    // canónico, legacy o ventana de bootstrap). Manda el veredicto del resolver.
    // `source: env` / `external` → el store no lo conoce; la presencia se
    // comprueba contra el ambiente ya hidratado (gh CLI, R2, etc).
    let raw;
    if (entry.source === 'store') {
      const veredicto = (veredictos && entry.env_var) ? veredictos[entry.env_var] : undefined;
      if (veredicto !== undefined) {
        if (VEREDICTOS_RESUELTOS.has(veredicto)) { out.present.push(name); continue; }
        // `env-preexisting` es el ÚNICO veredicto de resolución que el resolver
        // asigna sin mirar el contenido: le alcanza con que la variable venga
        // seteada y no vacía (`credentials.js:723,731-733`). El filtro de
        // relleno lo aplica este módulo, con la misma función del dueño del
        // store — nunca con una regex propia (CA-4b). Sin este brazo,
        // `TELEGRAM_BOT_TOKEN=REPLACE_ME` en el ambiente apagaba el halt.
        if (veredicto === SRC.ENV_PREEXISTING) {
          if (credentials.isPlaceholderOrEmpty(env[entry.env_var])) {
            out.placeholder.push(name);
            out.placeholder_env.push(name);
          } else {
            out.present.push(name);
          }
          continue;
        }
        if (veredicto === SRC.EMPTY) { out.placeholder.push(name); continue; }
        if (veredicto === SRC.MISSING) { out.absent.push(name); continue; }
        // Veredicto desconocido (el enum del resolver creció y este módulo
        // todavía no lo conoce): no se inventa una clasificación, se cae al
        // fallback de disco.
      }
      raw = store ? credentials.getNested(store, name) : undefined;
    } else {
      raw = entry.env_var ? env[entry.env_var] : undefined;
    }

    if (raw === undefined || raw === null) {
      out.absent.push(name);
    } else if (credentials.isPlaceholderOrEmpty(raw)) {
      // Presente en la fuente pero inutilizable → cuenta como faltante (CA-4).
      out.placeholder.push(name);
    } else {
      out.present.push(name);
    }
  }

  return out;
}

// -----------------------------------------------------------------------------
// evaluate() — PURO (SEC-1)
// -----------------------------------------------------------------------------

/**
 * Evalúa la salud de los secretos. **Puro**: sin I/O, sin efectos laterales, y
 * sin acceso a valores (SEC-1). Todo lo que entra son nombres.
 *
 * Tres estados (CA-4):
 *  - `ok`            → requerido y presente/hidratado, o `required_when: never`
 *                      ausente, o servicio inactivo (CA-4c).
 *  - `missing`       → ausente del store, o presente pero inutilizable.
 *                      Remediación: **REPONER**.
 *  - `chain_broken`  → presente pero sin `env_var` declarado, mapeado y no
 *                      hidratado tras `loadIntoEnv`, o con el consumidor
 *                      declarado roto en el manifiesto (`consumer_status`).
 *                      Remediación: **CABLEAR** (U1).
 *
 * Ambos negativos dan `ok:false` pero quedan distinguibles: la acción del
 * operador es distinta.
 *
 * Sobre `halt` — R-6/CA-14. `ok:false` NO implica frenar el pipeline. Sólo un
 * `missing` de un secreto `required_when: always` frena (level `alert`): es el
 * único caso en que el pipeline no puede funcionar. Una degradación de un
 * servicio opcional (`service_active`) o una cadena rota se REPORTAN (level
 * `warn`) sin haltear. Sin esta distinción, el primer boot post-merge frenaría
 * el pipeline sobre `TELEGRAM_LEO_OPERATOR_CHAT_ID` / `ANTHROPIC_AUTH_TOKEN`,
 * que en el estado vivo están ausentes y son sanos por diseño.
 *
 * @param {{ hydrated?: string[], skipped_existing?: string[], skipped_empty?: string[], missing?: string[], source?: string }} loadResult
 * @param {{ entries?: Array<Object> }} manifest
 * @param {{ present?: string[], placeholder?: string[], absent?: string[] }} presence
 * @param {{ now?: string }} [opts]
 * @returns {{ ok: boolean, halt: boolean, ts: string, counts: Object, entries: Array<Object> }}
 */
function evaluate(loadResult, manifest, presence, opts = {}) {
  const ts = opts.now || new Date().toISOString();
  const lr = loadResult && typeof loadResult === 'object' ? loadResult : {};
  const entriesIn = (manifest && Array.isArray(manifest.entries)) ? manifest.entries : [];

  const present = new Set(Array.isArray(presence && presence.present) ? presence.present : []);
  const placeholder = new Set(Array.isArray(presence && presence.placeholder) ? presence.placeholder : []);
  // Subconjunto de `placeholder` cuyo relleno vino del ambiente, no del store.
  const placeholderEnv = new Set(Array.isArray(presence && presence.placeholder_env)
    ? presence.placeholder_env : []);

  const hydrated = new Set([
    ...(Array.isArray(lr.hydrated) ? lr.hydrated : []),
    ...(Array.isArray(lr.skipped_existing) ? lr.skipped_existing : []),
  ]);

  // Actividad por grupo: un grupo está ACTIVO si al menos uno de sus secretos
  // está presente y utilizable. Grupo sin ningún secreto = servicio que el
  // operador simplemente no usa → sus `service_active` no son faltantes (CA-4c).
  const gruposActivos = new Set();
  for (const entry of entriesIn) {
    if (entry && entry.name && present.has(entry.name)) gruposActivos.add(groupOf(entry.name));
  }

  const out = [];
  for (const entry of entriesIn) {
    if (!entry || !entry.name) continue;
    const name = String(entry.name);
    const requiredWhen = entry.required_when || 'always';
    const esExterno = entry.source === 'external';
    const estaPresente = present.has(name);
    const esPlaceholder = placeholder.has(name);
    const esPlaceholderDeAmbiente = placeholderEnv.has(name);

    // --- CA-4c: los dos caminos que dan `ok` aunque el secreto no esté. ---
    if (!estaPresente && requiredWhen === 'never') {
      out.push(buildEntry(entry, STATE.OK, LEVEL.OK, null, ts, 'no es requerido en esta instalacion'));
      continue;
    }
    if (!estaPresente && requiredWhen === 'service_active' && !gruposActivos.has(groupOf(name))) {
      out.push(buildEntry(entry, STATE.OK, LEVEL.OK, null, ts, 'el servicio no esta en uso'));
      continue;
    }

    // --- Faltante ---
    if (!estaPresente) {
      // Un `external` (gh CLI, keyring del SO) no vive en el store: que no
      // aparezca no prueba que falte, prueba que no está cableado a una env
      // var visible. La remediación es CABLEAR, no REPONER, y nunca haltea.
      if (esExterno) {
        out.push(buildEntry(entry, STATE.CHAIN_BROKEN, LEVEL.WARN, REMEDIATION.CABLEAR, ts,
          'se resuelve fuera del store y no esta visible en el ambiente'));
        continue;
      }
      const level = requiredWhen === 'always' ? LEVEL.ALERT : LEVEL.WARN;
      let motivo = 'no esta en el store';
      if (esPlaceholderDeAmbiente) {
        // El operador tiene que sacar el relleno del ambiente además de reponer
        // el secreto: mientras siga seteado, le gana al store (`credentials.js:731`).
        motivo = 'viene seteada en el ambiente con un valor de relleno, y el ambiente le gana al store';
      } else if (esPlaceholder) {
        motivo = 'esta en el store pero con un valor de relleno';
      }
      out.push(buildEntry(entry, STATE.MISSING, level, REMEDIATION.REPONER, ts, motivo));
      continue;
    }

    // --- Presente: ¿la cadena llega hasta el consumidor? ---
    if (!entry.env_var) {
      out.push(buildEntry(entry, STATE.CHAIN_BROKEN, LEVEL.WARN, REMEDIATION.CABLEAR, ts,
        'esta en el store pero el manifiesto no declara su variable de entorno'));
      continue;
    }
    // Sólo las `eager` deberían estar hidratadas después de `loadIntoEnv`; una
    // `deferred` se resuelve recién cuando su consumidor la pide.
    if (entry.source === 'store' && entry.hydration === 'eager' && !hydrated.has(entry.env_var)) {
      out.push(buildEntry(entry, STATE.CHAIN_BROKEN, LEVEL.WARN, REMEDIATION.CABLEAR, ts,
        'esta en el store pero no llego al ambiente al arrancar'));
      continue;
    }
    // #5242 §R5 — "presente en el store" ≠ "resoluble por su consumidor". Sin
    // este eje el health-check reportaría verde sobre una clave guardada que su
    // consumidor no puede resolver.
    if (entry.consumer_status === 'broken') {
      out.push(buildEntry(entry, STATE.CHAIN_BROKEN, LEVEL.WARN, REMEDIATION.CABLEAR, ts,
        'el manifiesto declara su consumidor roto'));
      continue;
    }

    out.push(buildEntry(entry, STATE.OK, LEVEL.OK, null, ts, 'presente y resoluble'));
  }

  const counts = { ok: 0, missing: 0, chain_broken: 0 };
  let halt = false;
  for (const e of out) {
    if (Object.prototype.hasOwnProperty.call(counts, e.state)) counts[e.state] += 1;
    if (e.level === LEVEL.ALERT) halt = true;
  }

  return {
    ts,
    ok: counts.missing === 0 && counts.chain_broken === 0,
    halt,
    source: typeof lr.source === 'string' ? lr.source : 'none',
    counts,
    entries: out,
  };
}

/**
 * Arma una entrada del contrato de datos (CA-6b). Todos los campos de texto
 * pasan por el saneado de salida — el manifiesto es un archivo del repo, no una
 * fuente confiable.
 */
function buildEntry(entry, state, level, remediation, ts, motivo) {
  return {
    name: safeLabel(entry.name),
    service: safeLabel(entry.service || 'desconocido'),
    // CA-6b — `label` es TEXTO: la información nunca viaja sólo por color.
    // U9 — copy corto en español de la tabla de UX, nunca el `name` crudo.
    label: safeText(labelFor(entry.name, entry.service)),
    state,
    level,
    remediation,
    motivo: safeText(motivo),
    impacto: safeText(IMPACTO_POR_SERVICIO[entry.service] || IMPACTO_GENERICO),
    // Ancla del runbook: es lo que convierte el aviso en accionable (CA-7).
    next_step: safeText(entry.restore || 'docs/runbooks/credential-rotation.md'),
    ts,
  };
}

// -----------------------------------------------------------------------------
// formatAlert() — CA-7 / CA-7b / CA-7c / U1 / U2
// -----------------------------------------------------------------------------

/**
 * Arma el aviso agrupado. UN SOLO texto para todos los faltantes (CA-7c): en un
 * primer arranque limpio faltan todos a la vez, y siete notificaciones seguidas
 * se archivan sin abrir.
 *
 * Estructura por entrada (CA-7): qué falta · qué frena · cómo reponerlo. Nunca
 * el valor, ni un prefijo, ni la longitud, ni un hash (CA-7d).
 *
 * @param {Object} evaluation resultado de `evaluate`
 * @param {{ budget?: number }} [opts]
 * @returns {string}
 */
function formatAlert(evaluation, opts = {}) {
  const budget = Number.isFinite(opts.budget) && opts.budget > 0 ? opts.budget : TG_BUDGET;
  const problemas = (evaluation && Array.isArray(evaluation.entries) ? evaluation.entries : [])
    .filter((e) => e.state !== STATE.OK);

  if (!problemas.length) return '[secrets-health] Todos los secretos requeridos estan presentes y resolubles.';

  const faltantes = problemas.filter((e) => e.state === STATE.MISSING);
  const rotos = problemas.filter((e) => e.state === STATE.CHAIN_BROKEN);
  const frena = !!(evaluation && evaluation.halt);

  const head = [];
  head.push('[secrets-health] Revision de secretos al arrancar el pipeline');
  head.push(`Faltantes: ${faltantes.length} · Cadena rota: ${rotos.length}`);
  head.push(frena
    ? 'El pipeline quedo PAUSADO: falta un secreto sin el cual no puede operar.'
    : 'El pipeline sigue despachando: ninguno de estos secretos lo frena, pero degradan funciones.');
  head.push('');

  // CA-7b — copy propio, NO el de `haltOnConfigCorruption`. Decirle al operador
  // que borre `.paused` a mano destruye el marker que distingue una pausa
  // automatica de una deliberada, y con el la posibilidad de auto-levantarla.
  const tail = [];
  tail.push('');
  tail.push('Como sigue: repone o cablea lo de arriba y el pipeline se reanuda solo '
    + 'en el siguiente ciclo. No hace falta tocar el archivo de pausa a mano.');
  tail.push(`Detalle completo: .pipeline/${HEALTH_JSON_NAME}`);

  const headText = head.join('\n');
  const tailText = tail.join('\n');

  const lines = [];
  let usado = headText.length + tailText.length;
  let cortadas = 0;

  for (let i = 0; i < problemas.length; i += 1) {
    const e = problemas[i];
    const accion = e.remediation === REMEDIATION.CABLEAR
      // U1 — `chain_broken` tiene salida PROPIA: decir "repone el secreto"
      // cuando el secreto ya esta guardado manda al operador a rehacer trabajo
      // que no resuelve nada. La remediacion real es cablearlo.
      ? `CABLEAR — el secreto esta guardado pero no llega a su consumidor. Revisa el cableado: ${e.next_step}`
      : `REPONER — subi el secreto al store canonico. Runbook: ${e.next_step}`;
    const bloque = [
      `• ${e.label} [${e.state}]`,
      `  Que pasa: ${e.motivo}`,
      `  Que frena: ${e.impacto}`,
      `  Que hacer: ${accion}`,
    ].join('\n');

    // U2 — el corte es EXPLICITO y contado. `sendTelegramWithMarkup` trunca con
    // un `slice` mudo a los 4000 chars; presupuestamos por debajo y avisamos
    // cuantas entradas quedaron afuera, en vez de perderlas en silencio.
    const marcador = `\n... y ${problemas.length - i} secreto(s) mas — detalle completo en .pipeline/${HEALTH_JSON_NAME}`;
    if (usado + bloque.length + 1 + marcador.length > budget) {
      cortadas = problemas.length - i;
      break;
    }
    lines.push(bloque);
    usado += bloque.length + 1;
  }

  const cuerpo = lines.join('\n');
  const corte = cortadas
    ? `\n... y ${cortadas} secreto(s) mas — detalle completo en .pipeline/${HEALTH_JSON_NAME}`
    : '';

  return `${headText}${cuerpo}${corte}${tailText}`;
}

/**
 * Resumen de una línea para el marker `.paused` y para el log. Ya redactado
 * (CA-6 pto 2, CA-7d).
 *
 * @param {Object} evaluation
 * @returns {string}
 */
function formatSummary(evaluation) {
  const c = (evaluation && evaluation.counts) || { ok: 0, missing: 0, chain_broken: 0 };
  const nombres = (evaluation && Array.isArray(evaluation.entries) ? evaluation.entries : [])
    .filter((e) => e.level === LEVEL.ALERT)
    .map((e) => e.name);
  const detalle = nombres.length ? ` — frena: ${nombres.join(', ')}` : '';
  return safeText(`secretos: ${c.ok} ok, ${c.missing} faltantes, ${c.chain_broken} con cadena rota${detalle}`);
}

// -----------------------------------------------------------------------------
// writeHealthJson() — CA-6 pto 3 / CA-6b
// -----------------------------------------------------------------------------

/**
 * Escribe el artefacto que consume el dashboard (#5230). Precedente:
 * `infra-health.json`.
 *
 * Write directo en `try/catch`, calcado de `connectivity-precheck.js`. NO se
 * usa el `atomicWriteFile` de `./waves`: arrastraría el módulo `waves` al camino
 * de boot y agregaría superficie de falla justo donde no puede haber throws.
 *
 * @param {Object} evaluation
 * @param {string} targetPath
 * @returns {{ ok: boolean, path: string, error?: string }}
 */
function writeHealthJson(evaluation, targetPath) {
  const dest = targetPath;
  try {
    const payload = {
      ts: evaluation.ts,
      ok: !!evaluation.ok,
      halt: !!evaluation.halt,
      counts: evaluation.counts,
      entries: (evaluation.entries || []).map((e) => ({
        service: e.service,
        name: e.name,
        label: e.label,
        state: e.state,
        level: e.level,
        remediation: e.remediation,
        motivo: e.motivo,
        impacto: e.impacto,
        next_step: e.next_step,
        ts: e.ts,
      })),
    };
    fs.writeFileSync(dest, JSON.stringify(payload, null, 2));
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, path: dest, error: safeText(e && e.message) };
  }
}

// -----------------------------------------------------------------------------
// Dedup del aviso (rev-1 de review)
// -----------------------------------------------------------------------------

/**
 * Firma del estado NEGATIVO de una evaluación. Es lo que decide si el aviso de
 * Telegram es una novedad o el mismo mensaje de siempre.
 *
 * Deliberadamente NO incluye `ts` ni los contadores: si entra un secreto nuevo
 * al manifiesto en estado `ok`, el operador no tiene que enterarse por una
 * alerta. Sí incluye `halt`, porque pasar de "reporta" a "frena" es un cambio
 * que el operador tiene que ver aunque el inventario de faltantes no cambie.
 *
 * Funciona igual sobre una evaluación fresca y sobre el payload ya escrito en
 * `secrets-health.json`: ambos traen `name`/`state`/`level` por entrada.
 *
 * @param {Object} report evaluación o payload previo
 * @returns {string}
 */
function alertSignature(report) {
  const entries = (report && Array.isArray(report.entries)) ? report.entries : [];
  const partes = entries
    .filter((e) => e && e.level && e.level !== LEVEL.OK)
    .map((e) => `${e.name}:${e.state}:${e.level}`)
    .sort();
  return `${report && report.halt ? 'halt' : 'nohalt'}|${partes.join(',')}`;
}

/**
 * Lee el reporte anterior. Best-effort: cualquier problema devuelve `null`, que
 * el dedup interpreta como "no hay con qué comparar" → se avisa.
 *
 * @param {string} jsonPath
 * @returns {Object|null}
 */
function readPreviousHealth(jsonPath) {
  try {
    if (!jsonPath || !fs.existsSync(jsonPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * ¿Corresponde mandar el aviso por Telegram?
 *
 * Se avisa cuando hay NOVEDAD: no hay reporte previo, o la firma cambió. Si el
 * estado es idéntico, se calla — con una ventana de repetición como red de
 * seguridad, para que un problema que persiste no se vuelva invisible para
 * siempre (un secreto faltante que nadie repone tiene que volver a sonar, pero
 * una vez por día, no una vez por reinicio).
 *
 * @param {Object} evaluation evaluación fresca
 * @param {Object|null} previous payload del reporte anterior
 * @param {number} nowMs
 * @returns {{ send: boolean, reason: string }}
 */
function shouldNotify(evaluation, previous, nowMs) {
  if (!previous) return { send: true, reason: 'sin-reporte-previo' };
  if (alertSignature(previous) !== alertSignature(evaluation)) {
    return { send: true, reason: 'cambio-de-estado' };
  }
  const prevMs = Date.parse(previous.ts);
  if (!Number.isFinite(prevMs)) return { send: true, reason: 'reporte-previo-sin-fecha' };
  if (!Number.isFinite(nowMs) || (nowMs - prevMs) >= ALERT_REPEAT_MS) {
    return { send: true, reason: 'ventana-vencida' };
  }
  return { send: false, reason: 'sin-cambios' };
}

// -----------------------------------------------------------------------------
// applyHalt() — CA-5 / CA-6
// -----------------------------------------------------------------------------

/**
 * Efectos laterales del health-check. Se llama en el **Tiempo 2** del boot
 * (bloque `--- SINGLETON ---` de `pulpo.js`), único punto donde `PAUSE_FILE` y
 * `partialPause` ya están inicializados.
 *
 * Orden obligatorio de canales (CA-6), cada uno en su propio `try/catch` — el
 * halt NO puede depender del último:
 *   1) log estructurado  2) marker `.paused`  3) `secrets-health.json`
 *   4) Telegram best-effort (si falta su propio token, `sendTelegram*` loguea y
 *      devuelve null: falla silenciosa, por eso va al final).
 *
 * NUNCA llama `process.exit` (CA-5b) y NUNCA lanza hacia afuera (G-1).
 *
 * @param {Object} evaluation
 * @param {{ pauseFile?: string, partialPause?: Object, sendTelegram?: Function, logger?: Function, pipelineDir?: string }} deps
 * @returns {{ halted: boolean, channels: Object }}
 */
function applyHalt(evaluation, deps = {}) {
  const res = { halted: false, channels: { log: false, marker: false, json: false, telegram: false } };
  if (!evaluation || evaluation.ok) return res;

  const summary = formatSummary(evaluation);
  const alerta = formatAlert(evaluation);

  // --- 1) Log estructurado ---
  try {
    if (typeof deps.logger === 'function') {
      deps.logger('secrets-health', summary);
    }
    res.channels.log = true;
  } catch { /* best-effort */ }

  // --- 2) Marker `.paused` (sólo si algo frena de verdad) ---
  if (evaluation.halt) {
    try {
      const pauseFile = deps.pauseFile;
      // CA-5 idempotencia: si ya hay un marker (pausa manual del operador, u
      // otro halt automático) NO lo pisamos — la manual gana y nunca se
      // auto-levanta. Ante cualquier ambigüedad se respeta lo deliberado.
      if (pauseFile && !fs.existsSync(pauseFile)) {
        if (deps.partialPause && typeof deps.partialPause.setFullPause === 'function') {
          // El dueño del estado de pausa escribe el marker (audita + lock +
          // write atómico). Desde #5399 persiste `source`, que es lo que hace
          // posible el auto-levantado de CA-5.
          deps.partialPause.setFullPause({
            source: HALT_SOURCE,
            justification: summary,
          });
        } else {
          fs.writeFileSync(pauseFile, JSON.stringify({
            source: HALT_SOURCE,
            ts: new Date().toISOString(),
            detail: summary,
          }));
        }
        res.channels.marker = true;
        res.halted = true;
      }
    } catch { /* best-effort — nunca matar el boot */ }
  }

  // --- 3) Artefacto para el dashboard ---
  // El reporte ANTERIOR es el insumo del dedup del paso 4, así que hay que
  // leerlo ANTES de pisarlo.
  const jsonPath = deps.pipelineDir ? path.join(deps.pipelineDir, HEALTH_JSON_NAME) : null;
  const previo = jsonPath ? readPreviousHealth(jsonPath) : null;
  try {
    if (jsonPath) {
      const r = writeHealthJson(evaluation, jsonPath);
      res.channels.json = !!r.ok;
    }
  } catch { /* best-effort */ }

  // --- 4) Telegram (best-effort, al final, y SÓLO si hay novedad) ---
  //
  // `applyHalt` corre en CADA boot del Pulpo, y el Pulpo reinicia seguido
  // (watchdog, /restart, respawn). Sin dedup, un `ok:false` que no frena nada
  // —el estado vivo de hoy: 1 faltante + 3 cadenas rotas, `halt:false`— manda
  // el MISMO mensaje indefinidamente y entrena al operador a ignorar el canal.
  // El vecino (`haltOnConfigCorruption`) ya se protege con un throttle en
  // memoria; acá el dedup va por FIRMA persistida contra el reporte anterior,
  // que es más fuerte: sobrevive al reinicio del proceso, que es justamente
  // cuando se dispara este aviso.
  const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
  const decision = shouldNotify(evaluation, previo, nowMs);
  res.notified = false;
  res.notify_reason = decision.reason;
  try {
    if (decision.send && typeof deps.sendTelegram === 'function') {
      deps.sendTelegram(alerta);
      res.channels.telegram = true;
      res.notified = true;
    }
  } catch { /* best-effort */ }

  return res;
}

// -----------------------------------------------------------------------------
// autoRecover() — CA-5 (paso inverso)
// -----------------------------------------------------------------------------

/**
 * Paso inverso del halt. Corre dentro del ciclo de `mainLoop`, no en
 * `loadConfig`: un secreto no se relee por ciclo como el config, así que hay
 * que RE-EVALUAR el store contra disco antes de decidir (R-3). Levantar la
 * pausa mirando la evaluación del boot sería hacerlo sobre datos rancios.
 *
 * Fail-closed: sólo limpia si el marker vigente es JSON válido con
 * `source: 'secrets-health-halt'` **y** la evaluación fresca ya no frena.
 * Cualquier ambigüedad (marker ilegible, vacío, no-JSON, sin `source`, o con
 * otro `source`) → `readFullPauseOrigin` devuelve `manual` y no se toca nada.
 *
 * @param {{ pauseFile?: string, partialPause?: Object, logger?: Function, pipelineDir?: string, sendTelegram?: Function }} deps
 * @returns {{ recovered: boolean, reason: string }}
 */
function autoRecover(deps = {}) {
  try {
    const pauseFile = deps.pauseFile;
    if (!pauseFile || !fs.existsSync(pauseFile)) return { recovered: false, reason: 'sin-pausa' };

    const pp = deps.partialPause;
    if (!pp || typeof pp.readFullPauseOrigin !== 'function') return { recovered: false, reason: 'sin-deps' };

    const origen = pp.readFullPauseOrigin();
    if (!origen || origen.source !== HALT_SOURCE) {
      // Incluye el caso `manual`: la pausa deliberada del operador se respeta.
      return { recovered: false, reason: 'pausa-no-es-nuestra' };
    }

    // Re-evaluación fresca contra disco. `env: {}` es descartable a propósito:
    // no queremos pisar `process.env` del Pulpo en caliente.
    const loadResult = credentials.loadIntoEnv({ env: {}, logger: () => {} });
    const manifest = loadManifest();
    const evaluation = evaluate(loadResult, manifest, collectPresence({ manifest, loadResult }));

    if (evaluation.halt) return { recovered: false, reason: 'sigue-faltando' };

    pp.clearFullPause({
      source: AUTO_RECOVERY_SOURCE,
      justification: formatSummary(evaluation),
    });
    try {
      if (deps.pipelineDir) writeHealthJson(evaluation, path.join(deps.pipelineDir, HEALTH_JSON_NAME));
    } catch { /* best-effort */ }
    try {
      if (typeof deps.logger === 'function') {
        deps.logger('secrets-health', safeText(
          '[#5243] Auto-recovery: los secretos requeridos volvieron a estar presentes '
          + '→ pausa secrets-health-halt levantada → dispatch reanudado'));
      }
    } catch { /* best-effort */ }
    return { recovered: true, reason: 'ok' };
  } catch {
    // Fail-closed: ante cualquier error, la pausa queda.
    return { recovered: false, reason: 'error' };
  }
}

// -----------------------------------------------------------------------------
// Fachada de boot
// -----------------------------------------------------------------------------

/**
 * Conveniencia para el **Tiempo 1** del boot: carga manifiesto + presencia y
 * evalúa. Puro salvo la lectura del manifiesto y del store.
 *
 * @param {Object} loadResult resultado ya obtenido de `loadIntoEnv`
 * @param {{ manifestPath?: string, storePath?: string, env?: Object }} [opts]
 * @returns {Object} evaluación
 */
function evaluateFromDisk(loadResult, opts = {}) {
  const manifest = loadManifest(opts.manifestPath ? { path: opts.manifestPath } : {});
  // `loadResult` no viaja sólo a `evaluate`: es también el veredicto de
  // presencia de las entradas `source: store` (ver `collectPresence`).
  const presence = collectPresence({
    manifest, storePath: opts.storePath, env: opts.env, loadResult,
  });
  return evaluate(loadResult, manifest, presence);
}

module.exports = {
  evaluate,
  evaluateFromDisk,
  applyHalt,
  autoRecover,
  formatAlert,
  formatSummary,
  writeHealthJson,
  loadManifest,
  collectPresence,
  alertSignature,
  shouldNotify,
  safeLabel,
  labelFor,
  safeText,
  groupOf,
  SECRET_LABELS,
  IMPACTO_POR_SERVICIO,
  HALT_SOURCE,
  AUTO_RECOVERY_SOURCE,
  HEALTH_JSON_NAME,
  TG_BUDGET,
  ALERT_REPEAT_MS,
  STATE,
  LEVEL,
  REMEDIATION,
};

// -----------------------------------------------------------------------------
// CLI — `node .pipeline/lib/secrets-health.js --ci`
//
// CA-5b: éste es el ÚNICO `process.exit` del módulo, y vive bajo
// `require.main === module`. Cargado como librería (el camino del Pulpo) el
// módulo no puede terminar el proceso.
// -----------------------------------------------------------------------------
if (require.main === module) {
  const ci = process.argv.includes('--ci');
  const loadResult = credentials.loadIntoEnv({ env: {}, logger: () => {} });
  const evaluation = evaluateFromDisk(loadResult);

  if (ci) {
    // R-4 / SEC-2 — el repo es PÚBLICO y en un runner sin secretos TODO reporta
    // faltante. Publicar el inventario nominal de lo que falta es un mapa de
    // ataque. En `--ci` sale SÓLO el agregado: ningún `label`, ningún `service`,
    // ningún nombre lógico.
    process.stdout.write(`${JSON.stringify({
      ok: evaluation.ok,
      halt: evaluation.halt,
      counts: evaluation.counts,
    })}\n`);
    process.exit(evaluation.halt ? 1 : 0);
  }

  process.stdout.write(`${formatAlert(evaluation)}\n`);
  process.exit(0);
}
