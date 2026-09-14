'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { appendChained } = require('./audit-log');
const { redactAwsEvidence } = require('./kernel-table-verify');
const { buildAwsScopedEnv } = require('./kernel-provision');
// #5801 — El vocabulario de telemetría del vault tiene UNA sola fuente de
// verdad (`secret-vault.js`, #5803). Se importa en vez de reescribir los tres
// literales acá: un cuarto lugar donde figuren `physical_read`/`cache_hit`/
// `single_flight_join` es exactamente la deriva que ese enum vino a frenar, y
// una divergencia haría que el umbral se calibre contra un contador y se
// evalúe contra otro.
const { VAULT_TELEMETRY_CATEGORIES, VAULT_TELEMETRY, resolveVaultHostId } = require('./secret-vault');

const ACCESS_EVENT_NAMES = Object.freeze([
  'GetSecretValue',
  'BatchGetSecretValue',
  'GetParameter',
  'GetParameters',
  'GetParametersByPath',
]);
const CAUSAS = Object.freeze({
  IDENTIDAD_NO_ESPERADA: 'Un principal fuera de la allowlist leyó un secreto del vault.',
  AUTORIZACION_RECHAZADA: 'Se repitieron rechazos de autorización contra el vault.',
  RAFAGA_DE_LECTURAS: 'El volumen de lecturas superó el umbral de la ventana.',
  // #5563 · CA-2 — la auditoría NO pudo observar la ventana. No es "alguien
  // accedió": es "no estamos viendo". Sin esta causa, un fallo de recolección
  // se leía como `0 acceso(s)` limpio (#7067).
  RECOLECCION_FALLIDA: 'La consulta al Event history de CloudTrail falló; la auditoría no pudo observar la ventana.',
});
const UNKNOWN_SCOPE = 'desconocido';
const UNKNOWN_PRINCIPAL = 'desconocido';
const DEFAULT_AUTH_FAILURE_THRESHOLD = 3;

// #5563 · CA-1 — Convención del rol de lectura del vault POR HOST. Hasta acá la
// convención sólo existía en IAM (guru la observó con `aws iam list-roles`);
// ahora vive en código porque la allowlist se DERIVA de ella en runtime. Lo
// que se commitea es el mecanismo (prefijo + `hostIdFromHostname`), nunca el
// ARN: el repo es público y #5426 decidió no publicar ni account id ni hostId.
const HOST_ROLE_PREFIX = 'intrale-vault-runtime-';
// Mismo criterio de segmento que el vault (`secret-vault.js` · SEGMENT_RE):
// un hostId que no lo cumple no produce un ARN a medias, produce `null`.
const HOST_ID_RE = /^[A-Za-z0-9_-]+$/;
const ACCOUNT_ID_RE = /^\d{12}$/;

/**
 * Memo por proceso del account id, keyed por región: evita sumar una 6ª
 * llamada síncrona (`sts`) a cada tick (#5776). Se invalida cuando la
 * derivación falla, para que el próximo tick vuelva a preguntar en vez de
 * arrastrar una identidad que quizá ya no es la del ambiente.
 */
const ACCOUNT_ID_MEMO = new Map();

function asMillis(value) {
  const n = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(n) ? n : 0;
}

function normalizePrincipal(value) {
  if (typeof value !== 'string' || !value) return null;
  const assumed = /^arn:aws[^:]*:sts::(\d{12}):assumed-role\/([^/]+)\/[^/]+$/.exec(value);
  return assumed ? `arn:aws:iam::${assumed[1]}:role/${assumed[2]}` : value;
}

/**
 * ARN del rol de lectura del vault para un host (CA-1). Pura, sin I/O.
 * Devuelve `null` si alguno de los dos segmentos no valida: NUNCA un ARN a
 * medias, porque un ARN mal formado en la allowlist no matchea nada y el
 * resultado sería idéntico a "el host no está autorizado" — con alertas
 * `IDENTIDAD_NO_ESPERADA` sobre el propio pipeline.
 *
 * @param {string} accountId 12 dígitos
 * @param {string} hostId    segmento válido del vault
 * @returns {string|null}
 */
function buildHostRoleArn(accountId, hostId) {
  if (typeof accountId !== 'string' || !ACCOUNT_ID_RE.test(accountId)) return null;
  if (typeof hostId !== 'string' || !HOST_ID_RE.test(hostId)) return null;
  return `arn:aws:iam::${accountId}:role/${HOST_ROLE_PREFIX}${hostId}`;
}

/**
 * Resuelve la allowlist EFECTIVA del tick: literales de `expected_principals`
 * ∪ derivadas por host. La derivación es una señal POSITIVA y exacta
 * (`expected_principals_from_hosts === true`, como `hostIdFromHostname`): sin
 * ella el comportamiento es el de siempre y `"true"` string no deriva.
 *
 * Cuando la derivación se pidió y falla (sin `sts`, sin `hostId`, account id
 * ilegible), el resultado lo DICE (`derivation.ok === false` + `reason`) para
 * que el tick salga por `allowlist-no-derivable` y no por `empty-allowlist`
 * mudo: una allowlist que no se pudo armar es un fallo de recolección, no una
 * configuración vacía.
 *
 * @param {object} p
 * @param {object} p.config            sección `vault.access_audit`
 * @param {object} [p.vaultConfig]     sección `vault` completa (para `hostId`)
 * @param {Function|null} [p.getCallerIdentity] runner de `sts get-caller-identity`
 * @param {Function} [p.hostname]      inyectable para tests
 * @param {Map} [p.cache]              memo del account id (default: por proceso)
 * @param {string} [p.region]          clave de la memo
 * @returns {{principals: string[], derivation: {requested: boolean, ok: boolean, reason: string|null}}}
 */
function resolveExpectedPrincipals({ config, vaultConfig, getCallerIdentity, hostname, cache, region } = {}) {
  const cfg = config && typeof config === 'object' ? config : {};
  const literales = (Array.isArray(cfg.expected_principals) ? cfg.expected_principals : [])
    .filter((p) => typeof p === 'string' && p !== '');
  const requested = cfg.expected_principals_from_hosts === true;
  if (!requested) return { principals: literales, derivation: { requested: false, ok: true, reason: null } };

  const memo = cache instanceof Map ? cache : ACCOUNT_ID_MEMO;
  const memoKey = String(region || 'default');
  const fail = (reason) => {
    memo.delete(memoKey);
    return { principals: literales, derivation: { requested: true, ok: false, reason } };
  };

  const hostId = resolveVaultHostId(vaultConfig || {}, hostname ? { hostname } : {});
  if (!hostId || !HOST_ID_RE.test(hostId)) return fail('host-id-no-resuelto');

  let accountId = memo.get(memoKey) || null;
  if (!accountId) {
    if (typeof getCallerIdentity !== 'function') return fail('sts-no-disponible');
    try {
      const identity = JSON.parse(getCallerIdentity() || '{}');
      accountId = identity && typeof identity.Account === 'string' ? identity.Account : null;
    } catch (_err) {
      return fail('sts-fallo');
    }
    if (!accountId || !ACCOUNT_ID_RE.test(accountId)) return fail('account-id-ilegible');
    memo.set(memoKey, accountId);
  }

  const derivado = buildHostRoleArn(accountId, hostId);
  if (!derivado) return fail('arn-no-derivable');
  return {
    principals: [...new Set([...literales, derivado])],
    derivation: { requested: true, ok: true, reason: null },
  };
}

function hashPrincipal(value) {
  return crypto.createHash('sha256').update(String(value || 'unknown')).digest('hex');
}

/**
 * Identidad LÓGICA para el registro consultable (CA-3): tipo + nombre del
 * principal, sin account id ni ARN. La unidad es el rol por host (D-3): la
 * sesión ya viene colapsada al rol por `normalizePrincipal`.
 * Lo que no se puede nombrar con seguridad queda `desconocido` — nunca inferido.
 */
function logicalPrincipal(value) {
  if (typeof value !== 'string' || !value) return UNKNOWN_PRINCIPAL;
  const typed = /:(role|user|assumed-role|group)\/([^/]+)/.exec(value);
  const candidate = typed ? typed[2] : value.split(/[/:]/).filter(Boolean).pop();
  if (!candidate || /^\d{12}$/.test(candidate)) return UNKNOWN_PRINCIPAL;
  if (!/^[A-Za-z0-9_.@-]{1,80}$/.test(candidate)) return UNKNOWN_PRINCIPAL;
  return typed ? `${typed[1] === 'assumed-role' ? 'role' : typed[1]}/${candidate}` : candidate;
}

function parseCloudTrailEvent(event) {
  if (!event || typeof event !== 'object') return {};
  if (event.cloudTrailEvent && typeof event.cloudTrailEvent === 'object') return event.cloudTrailEvent;
  if (typeof event.CloudTrailEvent !== 'string') return {};
  try { return JSON.parse(event.CloudTrailEvent); } catch { return {}; }
}

function logicalScope(event, detail) {
  if (detail && detail.errorCode && detail.requestParameters == null) return UNKNOWN_SCOPE;
  const request = (detail && detail.requestParameters) || {};
  const raw = request.name || request.secretId || request.path || request.names;
  if (Array.isArray(raw)) return raw.map((v) => logicalName(v)).filter(Boolean).join(',') || UNKNOWN_SCOPE;
  return logicalName(raw) || UNKNOWN_SCOPE;
}

function logicalName(value) {
  if (typeof value !== 'string' || !value) return null;
  const withoutQuery = value.split('?')[0];
  const parts = withoutQuery.split(/[/:]/).filter(Boolean);
  const candidate = parts[parts.length - 1] || '';
  return /^[A-Za-z0-9_.-]{1,80}$/.test(candidate) ? candidate : UNKNOWN_SCOPE;
}

function normalizeEvent(event) {
  const detail = parseCloudTrailEvent(event);
  const principal = normalizePrincipal(
    detail.userIdentity && (detail.userIdentity.arn || detail.userIdentity.principalId)
      || event.Username
  );
  const errorCode = detail.errorCode || null;
  return {
    id: event.EventId || detail.eventID || crypto.createHash('sha256')
      .update(JSON.stringify([event.EventName, event.EventTime, principal, errorCode])).digest('hex'),
    timestamp: event.EventTime || detail.eventTime || null,
    principal,
    principal_logico: logicalPrincipal(principal),
    event_name: event.EventName || detail.eventName || 'Unknown',
    scope_logico: logicalScope(event, detail),
    resultado: errorCode ? 'denied' : 'ok',
    error_code: errorCode,
  };
}

/**
 * De qué almacén salió la lectura. Se deriva del nombre del evento porque es
 * lo único que el rastro informa: el *tier* del vault (`rotating`/`static`) NO
 * es observable desde CloudTrail y por eso no se registra — inventarlo sería
 * el mismo error que completar el scope de un `AccessDenied`.
 */
function almacenFor(eventName) {
  return String(eventName || '').includes('Secret') ? 'secrets-manager' : 'parameter-store';
}

function findingKey(finding) {
  return `${finding.causa}:${finding.principal_hash}:${finding.scope_logico}`;
}

// -----------------------------------------------------------------------------
// #5801 · umbral de ráfaga — contabilidad EXCLUSIVA de `physical_read`
// -----------------------------------------------------------------------------

/**
 * Unidad del umbral, explícita porque viaja al copy del operador y a la
 * documentación: lecturas FÍSICAS acumuladas en la ventana `lookback_min`.
 * No es una tasa por segundo: la ventana del auditor y la de la calibración se
 * declaran juntas justamente para que el número no se lea contra otra ventana.
 */
const BURST_UNIT = 'physical_read/ventana';

/**
 * Lectura fail-closed del umbral (#5801 · SEC-1). El esquema de configuración
 * ya lo rechaza al arrancar, pero el módulo NO vuelve a confiar en eso: los dos
 * controles fallan en momentos distintos (el esquema al arrancar, esto al
 * evaluar) y el evaluador también se usa desde tests y desde otros callers.
 *
 * PROHIBIDA la coerción: el `Number(cfg.burst_threshold || 0)` original
 * convertía `"12"`, `true` y `12.7` en un umbral operativo, y `0`/`null` en un
 * control apagado en silencio. Acá cada una de esas clases devuelve `null`, y
 * `evaluateAccessEvents` lo traduce en una EXCEPCIÓN (#5801 · R3) — nunca en
 * «no hay ráfaga», que es la lectura tranquilizadora que el fail-OPEN producía.
 *
 * @param {*} value valor crudo de `vault.access_audit.burst_threshold`
 * @returns {number|null} entero seguro positivo, o `null` si no lo es
 */
function readBurstThreshold(value) {
  // `typeof number` descarta string numérico, booleano, `null` y ausencia.
  // `Number.isSafeInteger` descarta fracción, `NaN`, `±Infinity` y los enteros
  // fuera del rango exacto de IEEE-754 (donde `n + 1 === n` y la comparación
  // estricta contra el conteo dejaría de discriminar).
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

/**
 * Clasifica un evento de entrada en el vocabulario de telemetría del vault.
 *
 * Dos rastros distintos entran por la misma puerta y NO se mezclan:
 *
 *   - `telemetry`  evento del emisor del vault (`{category, ts_ms}`, #5803).
 *                  La categoría viene declarada y se valida contra el enum; una
 *                  categoría fuera del vocabulario se RECHAZA y jamás se
 *                  reclasifica como `physical_read` (CA · eventos desconocidos).
 *   - `cloudtrail` entrada del Event history. Es una lectura física sólo si la
 *                  llamada llegó a AWS *y* salió bien: un `AccessDenied` no leyó
 *                  ningún secreto (y ya tiene su propio umbral, el de
 *                  `authorization_failure_threshold`), y un `EventName` fuera
 *                  del enum de lecturas no es una lectura.
 *
 * Por construcción `cache_hit` y `single_flight_join` NO pueden salir de la
 * rama de CloudTrail: una resolución servida por caché o por join nunca emite
 * una llamada a AWS, así que no deja rastro allí. Esa es la razón estructural
 * de por qué el contador físico no puede contaminarse desde este lado.
 *
 * @param {*} raw evento crudo
 * @returns {{kind: 'telemetry'|'cloudtrail'|'rejected', category: string|null}}
 */
function classifyAccessEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'rejected', category: null };
  }
  const declarada = Object.hasOwn(raw, 'category');
  const esCloudTrail = Object.hasOwn(raw, 'EventName') || Object.hasOwn(raw, 'CloudTrailEvent')
    || Object.hasOwn(raw, 'cloudTrailEvent') || Object.hasOwn(raw, 'EventId');
  if (declarada && !esCloudTrail) {
    const categoria = raw.category;
    if (typeof categoria !== 'string' || !VAULT_TELEMETRY_CATEGORIES.includes(categoria)) {
      return { kind: 'rejected', category: null };
    }
    return { kind: 'telemetry', category: categoria };
  }
  if (!esCloudTrail) return { kind: 'rejected', category: null };
  return { kind: 'cloudtrail', category: null };
}

/** Contadores del vocabulario en cero, más el cajón de los rechazados. */
function emptyCounters() {
  const counters = { rechazados: 0 };
  for (const categoria of VAULT_TELEMETRY_CATEGORIES) counters[categoria] = 0;
  return counters;
}

/**
 * Núcleo puro: clasifica eventos y aplica dedupe/cooldown sin I/O.
 *
 * @returns {{records: object[], notifications: object[], detections: object[],
 *            counters: object, burst: object, nextState: object}}
 *   `counters` trae los tres contadores del vocabulario del vault más los
 *   rechazados; `burst` es el diagnóstico de la decisión de ráfaga (si se
 *   evaluó, con qué umbral, cuántas lecturas físicas y sobre qué ventana);
 *   `detections` son TODAS las detecciones de la pasada, cada una con si se
 *   notificó o si el cooldown suprimió el aviso.
 */
function evaluateAccessEvents({ now, events, state, config, recoleccion }) {
  const nowMs = asMillis(now);
  const cfg = config && typeof config === 'object' ? config : {};
  const expected = new Set((cfg.expected_principals || []).map(normalizePrincipal).filter(Boolean));
  const previous = state && typeof state === 'object' ? state : {};
  const seen = { ...(previous.seen_events || {}) };
  const lastNotified = { ...(previous.last_notified || {}) };
  const cooldownMs = Math.max(0, Number(cfg.cooldown_min || 10) * 60 * 1000);
  const records = [];
  const candidates = [];
  // #5801 — Contadores del vocabulario del vault. `physical_read` es el ÚNICO
  // que decide la ráfaga; los otros dos viajan como contexto de la alerta y del
  // diagnóstico, y no pueden mover el veredicto.
  const counters = emptyCounters();
  // #5801 · D2 — dedupe INTRA-lote del conteo físico, independiente de `seen`.
  const vistosEnLote = new Set();

  for (const raw of Array.isArray(events) ? events : []) {
    const clasificado = classifyAccessEvent(raw);
    if (clasificado.kind === 'rejected') {
      // Rechazo EXPLÍCITO (contado, no descartado en silencio) y sin
      // reclasificar: un evento que no se pudo entender no es una lectura
      // física, y tampoco se convierte en una por defecto.
      counters.rechazados += 1;
      continue;
    }
    if (clasificado.kind === 'telemetry') {
      // Rastro LOCAL del vault. No produce registro de acceso — no hubo
      // llamada a AWS que auditar — y no pasa por `seen`: es un lote efímero
      // de la ventana en curso, no un cursor sobre el Event history.
      counters[clasificado.category] += 1;
      continue;
    }
    const ev = normalizeEvent(raw);
    // #5801 · D2 — El numerador del umbral es la VENTANA COMPLETA (`lookback_min`),
    // no los eventos nuevos del tick. Por eso el conteo va ANTES del dedupe
    // cross-tick: si dependiera de `seen`, en régimen se compararía ~`poll_interval_min`
    // (10 min) contra un umbral expresado en 30, y en el primer tick tras un reset
    // de estado se compararían los 30 — dos unidades distintas contra un mismo
    // número. El dedupe intra-lote es PROPIO (`vistosEnLote`) porque las cinco
    // consultas de `ACCESS_EVENT_NAMES` no deberían solaparse, pero el conteo no
    // puede depender de que no lo hagan.
    //
    // Una entrada de CloudTrail sólo cuenta como lectura física si la llamada
    // llegó a AWS y salió bien. Todo lo demás queda registrado igual, pero
    // fuera del numerador del umbral.
    if (!vistosEnLote.has(ev.id)) {
      vistosEnLote.add(ev.id);
      if (ev.resultado === 'ok' && ACCESS_EVENT_NAMES.includes(ev.event_name)) {
        counters[VAULT_TELEMETRY.PHYSICAL_READ] += 1;
      } else {
        counters.rechazados += 1;
      }
    }
    // Dedupe cross-tick: gobierna el RASTRO y las ALERTAS (no reescribe registros
    // ni renotifica), nunca el conteo de ráfaga.
    if (seen[ev.id]) continue;
    seen[ev.id] = nowMs;
    const principalHash = hashPrincipal(ev.principal);
    let causa = null;
    if (!ev.principal || !expected.has(ev.principal)) causa = 'IDENTIDAD_NO_ESPERADA';
    records.push({
      timestamp: ev.timestamp,
      // Identidad en dos formas: la lógica hace consultable el registro (CA-3),
      // el hash permite correlacionar sin conservar la topología de la cuenta.
      principal_logico: ev.principal_logico,
      principal_hash: principalHash,
      scope_logico: ev.scope_logico,
      almacen: almacenFor(ev.event_name),
      event_name: ev.event_name,
      resultado: ev.resultado,
      causa,
      evidencia: ev.error_code ? redactAwsEvidence(ev.error_code) : null,
    });
    if (causa) candidates.push({ causa, principal_hash: principalHash, scope_logico: ev.scope_logico });
  }

  const denied = records.filter((r) => r.resultado === 'denied');
  if (denied.length >= Number(cfg.authorization_failure_threshold || DEFAULT_AUTH_FAILURE_THRESHOLD)) {
    candidates.push({ causa: 'AUTORIZACION_RECHAZADA', principal_hash: 'multiple', scope_logico: UNKNOWN_SCOPE });
  }
  // #5801 — La decisión de ráfaga consume EXCLUSIVAMENTE `physical_read`, y es
  // estricta (`>`): el conteo igual al umbral es carga normal y no alerta.
  const lecturasFisicas = counters[VAULT_TELEMETRY.PHYSICAL_READ];
  // #5801 · R3 — Se fue el fail-OPEN: no hay `Number(cfg.burst_threshold || 0)`
  // ni guard `burstThreshold > 0 &&`. Con ellos, un umbral ausente o cero apagaba
  // la detección EN SILENCIO por cualquier camino que no pasara por el esquema, y
  // el resultado era indistinguible de «no hubo ráfaga». Ahora se LANZA: el
  // esquema ya bloquea el arranque (control primario) y esto es la segunda
  // barrera para un caller que arme la config a mano. `pulpo.js` envuelve el tick
  // en `try/catch` y registra el mensaje, así que el pipeline no se cae.
  //
  // El mensaje nombra la CLAVE y la condición esperada; NUNCA interpola el valor
  // recibido, que es configuración del vault.
  const burstThreshold = readBurstThreshold(cfg.burst_threshold);
  if (burstThreshold === null) {
    throw new Error('vault.access_audit.burst_threshold inválido: se requiere entero positivo');
  }
  const ventanaMin = Math.max(1, Number(cfg.lookback_min) || 30);
  const burst = {
    umbral: burstThreshold,
    lecturas_fisicas: lecturasFisicas,
    ventana_min: ventanaMin,
    unidad: BURST_UNIT,
  };
  // Estricto (`>`): el conteo IGUAL al umbral es carga normal y no alerta.
  if (lecturasFisicas > burstThreshold) {
    candidates.push({
      causa: 'RAFAGA_DE_LECTURAS',
      principal_hash: 'multiple',
      scope_logico: 'vault',
      lecturas_fisicas: lecturasFisicas,
      umbral: burstThreshold,
      ventana_min: ventanaMin,
      unidad: BURST_UNIT,
      contexto: {
        [VAULT_TELEMETRY.CACHE_HIT]: counters[VAULT_TELEMETRY.CACHE_HIT],
        [VAULT_TELEMETRY.SINGLE_FLIGHT_JOIN]: counters[VAULT_TELEMETRY.SINGLE_FLIGHT_JOIN],
      },
    });
  }

  // #5563 · CA-2 — Un fallo de recolección es UNA detección por tick (no una
  // por `event_name`, UX-B): cinco consultas fallidas del mismo tick son un
  // hecho, no cinco. Pasa por `candidates` para heredar el cooldown y la
  // persistencia de las otras causas, sin un segundo mecanismo.
  const fallidas = recoleccion && Number.isFinite(recoleccion.fallidas) ? recoleccion.fallidas : 0;
  if (fallidas > 0) {
    candidates.push({
      causa: 'RECOLECCION_FALLIDA',
      principal_hash: 'pipeline',
      scope_logico: 'vault',
      consultas_fallidas: fallidas,
      consultas_total: Number.isFinite(recoleccion.total) ? recoleccion.total : ACCESS_EVENT_NAMES.length,
      ventana_min: Number.isFinite(recoleccion.ventana_min) ? recoleccion.ventana_min : ventanaMin,
    });
  }

  // Detección y notificación son DOS cosas (SEC-4/SEC-5): el cooldown decide si
  // se vuelve a molestar al operador, nunca si la detección queda registrada.
  // Sin esta separación, una ráfaga sostenida dejaba de existir en el rastro
  // después de la primera alerta — que es exactamente el hueco por el que un
  // atacante esconde las ráfagas siguientes.
  const notifications = [];
  const detections = [];
  for (const finding of candidates) {
    const key = findingKey(finding);
    const enCooldown = Boolean(lastNotified[key]) && nowMs - lastNotified[key] < cooldownMs;
    detections.push({ ...finding, notificada: !enCooldown });
    if (enCooldown) continue;
    lastNotified[key] = nowMs;
    notifications.push(finding);
  }

  const retentionFloor = nowMs - Math.max(60, Number(cfg.lookback_min || 30) * 3) * 60 * 1000;
  for (const [id, timestamp] of Object.entries(seen)) {
    if (timestamp < retentionFloor) delete seen[id];
  }
  return {
    records,
    notifications,
    detections,
    counters,
    burst,
    nextState: { seen_events: seen, last_notified: lastNotified },
  };
}

// -----------------------------------------------------------------------------
// Copy del operador. Texto 100% FIJO (UX-1/UX-4). Las únicas partes variables
// son el TOKEN del enum, el nombre LÓGICO del scope y el correlationId, y los
// tres los produce el pipeline — nunca el driver de AWS. Glifo ⚠️ (UX-2): el
// pipeline sigue operativo, no quedó pausado. El sujeto es la superficie
// ("acceso al vault"), no el módulo (UX-3).
// -----------------------------------------------------------------------------
const HEADER_ALERTA = '⚠️ *Acceso al vault fuera de lo esperado* — el pipeline sigue operativo';
// #5563 · UX-B — La alerta "a oscuras" NO reusa `HEADER_ALERTA`: el operador
// leería un acceso anómalo que no existió. Mismo glifo y misma cláusula de
// estado, distinto sujeto: "no estamos viendo", no "alguien accedió".
const HEADER_OSCURAS = '⚠️ *Auditoría del vault a oscuras* — el pipeline sigue operativo, '
  + 'pero nadie está mirando quién lee los secretos';

const CONSECUENCIA = Object.freeze({
  IDENTIDAD_NO_ESPERADA: 'alguien que no está en la lista de identidades autorizadas leyó credenciales '
    + 'del vault: hay que asumir que esas credenciales quedaron expuestas hasta demostrar lo contrario',
  AUTORIZACION_RECHAZADA: 'se acumularon rechazos de permisos contra el vault: o hay una identidad '
    + 'probando accesos que no le corresponden, o un host quedó con permisos incompletos y sus agentes '
    + 'van a fallar al arrancar',
  RAFAGA_DE_LECTURAS: 'el volumen de lecturas se salió del patrón normal de la ventana: puede ser un '
    + 'lazo de reintentos del propio pipeline o un uso que no debería estar ocurriendo',
  RECOLECCION_FALLIDA: 'desde el último tick exitoso no hay garantía de que una lectura no autorizada '
    + 'hubiera sido detectada: la auditoría no pudo consultar el Event history y la ventana quedó sin observar',
});

const ACCION = Object.freeze({
  // #5563 · UX-A — Con la allowlist DERIVADA (CA-1) mandar a editar
  // `expected_principals` en `config.yaml` era una trampa: llevaba al operador
  // a commitear el account id y el hostId en un repo público. La acción ahora
  // distingue los tres casos de D1/D2 y nunca pide tocar `config.yaml`.
  IDENTIDAD_NO_ESPERADA: 'si fue una lectura manual tuya, es la alerta esperada: el control detecta '
    + 'lecturas humanas y no hay que agregarte a la allowlist. Si fue un host nuevo del pipeline, verificá '
    + `que su rol siga la convención \`${HOST_ROLE_PREFIX}<hostId>\` — la allowlist se deriva sola, no se `
    + 'edita el archivo de configuración. Si no fue ninguna de las dos, rotá los secretos del scope '
    + 'afectado siguiendo `docs/pipeline/vault-rotacion-auditoria.md`.',
  AUTORIZACION_RECHAZADA: 'revisá en el Event history quién recibió los rechazos y contrastá la policy '
    + 'del rol del host contra `docs/pipeline/vault-rotacion-auditoria.md`.',
  RAFAGA_DE_LECTURAS: 'revisá el detalle del rastro antes de subir `vault.access_audit.burst_threshold`: '
    + 'si el volumen viene del propio pipeline, el umbral está mal calibrado y hay que recalibrarlo, no silenciarlo.',
  // Sin el literal del error de AWS a propósito: el copy es cerrado (CA-6) y
  // ningún texto del driver cruza al canal.
  RECOLECCION_FALLIDA: 'confirmá que el usuario de auditoría `user/claude-code` conserva '
    + '`cloudtrail:LookupEvents` (Sid `VaultAuditReadEventHistory`) corriendo '
    + '`aws cloudtrail lookup-events --region us-east-2 --max-items 1`; si la respuesta es un rechazo de '
    + 'permisos, el grant se perdió. Si el permiso está, buscá `DEGRADADO` en `pulpo.log` para ver si '
    + 'la CLI está agotando el tiempo de espera.',
});

/**
 * Arma la alerta desde un template FIJO, en el orden de UX-1:
 * (1) severidad · (2) consecuencia en criollo · (3) causa como TOKEN + glosa ·
 * (4) qué hacer · y recién al final el diagnóstico. El diagnóstico NUNCA va
 * antes de la acción.
 *
 * @param {Array<{causa: string, scope_logico?: string}>} findings
 * @param {string} correlationId handle que liga alerta ↔ registro ↔ pulpo.log.
 * @returns {string}
 */
function formatAccessAlert(findings, correlationId) {
  const causas = [...new Set((Array.isArray(findings) ? findings : [])
    .map((f) => f && f.causa).filter((c) => Object.hasOwn(CAUSAS, c)))];
  const scopes = [...new Set((Array.isArray(findings) ? findings : [])
    .map((f) => (f && f.scope_logico) || UNKNOWN_SCOPE))].slice(0, 5);
  // #5563 · UX-B — Header "a oscuras" SÓLO cuando todas las causas son de
  // recolección. Si se mezclara con un acceso real gana el header de acceso:
  // el tick las envía por separado justamente para que esto no ocurra.
  const soloOscuras = causas.length > 0 && causas.every((c) => c === 'RECOLECCION_FALLIDA');
  const lines = [soloOscuras ? HEADER_OSCURAS : HEADER_ALERTA, ''];
  for (const causa of causas) {
    lines.push(CONSECUENCIA[causa], '', `Causa: \`${causa}\` — ${CAUSAS[causa]}`, '',
      `Qué hacer: ${ACCION[causa]}`, '');
  }
  // Diagnóstico al final (UX-1). Sólo nombres lógicos: nada de ARN, account id,
  // IP, path completo ni salida de la CLI.
  //
  // #5801 — Para la ráfaga, el diagnóstico lleva además los números de la
  // decisión con ETIQUETA y UNIDAD explícitas: sin ellos el operador no puede
  // distinguir «el umbral quedó corto» de «hay tráfico que no debería existir»,
  // que son las dos lecturas posibles de la misma alerta y llevan a acciones
  // opuestas. Los tres contadores se nombran con el vocabulario del vault para
  // que `cache_hit` y `single_flight_join` se lean inequívocamente como
  // CONTEXTO y no como parte del veredicto. Todos los valores son enteros que
  // produce el pipeline: no hay superficie para un dato del driver.
  const rafaga = (Array.isArray(findings) ? findings : [])
    .find((f) => f && f.causa === 'RAFAGA_DE_LECTURAS' && Number.isFinite(f.lecturas_fisicas));
  if (rafaga) {
    const ctx = rafaga.contexto || {};
    lines.push(`Lecturas fisicas (${VAULT_TELEMETRY.PHYSICAL_READ}): ${rafaga.lecturas_fisicas}`);
    lines.push(`Umbral configurado: ${rafaga.umbral} ${rafaga.unidad || BURST_UNIT}`);
    lines.push(`Ventana evaluada: ${rafaga.ventana_min} minutos`);
    lines.push('Contexto que NO cuenta para el umbral: '
      + `${VAULT_TELEMETRY.CACHE_HIT}=${Number(ctx[VAULT_TELEMETRY.CACHE_HIT]) || 0}, `
      + `${VAULT_TELEMETRY.SINGLE_FLIGHT_JOIN}=${Number(ctx[VAULT_TELEMETRY.SINGLE_FLIGHT_JOIN]) || 0}`);
  }
  // #5563 · UX-B — Diagnóstico de la recolección con etiqueta y unidad, como
  // el de la ráfaga. Enteros del pipeline; nada del driver.
  const oscuras = (Array.isArray(findings) ? findings : [])
    .find((f) => f && f.causa === 'RECOLECCION_FALLIDA' && Number.isFinite(f.consultas_fallidas));
  if (oscuras) {
    const total = Number.isFinite(oscuras.consultas_total) ? oscuras.consultas_total : ACCESS_EVENT_NAMES.length;
    lines.push(`Consultas fallidas: ${oscuras.consultas_fallidas}/${total}`);
    lines.push(`Ventana no observada: ${Number.isFinite(oscuras.ventana_min) ? oscuras.ventana_min : 30} minutos`);
  }
  lines.push(`Scopes afectados: ${scopes.join(', ') || UNKNOWN_SCOPE}`);
  lines.push(`id: ${correlationId}`);
  lines.push('El detalle completo está en el Event history de CloudTrail y en '
    + '`.pipeline/logs/vault-access-audit.jsonl`.');
  return lines.join('\n');
}

/**
 * Runner de sólo lectura sobre el Event history. Sin shell (así que la trampa
 * de MSYS no aplica al runtime, sí a los comandos manuales del runbook) y con
 * el env armado por ALLOWLIST: el proceso hijo NO hereda las API keys de los
 * proveedores que viven en `process.env`.
 */
function createCloudTrailRunner(sourceEnv, region, deps = {}) {
  const runFile = deps.execFileSync || execFileSync;
  const env = buildAwsScopedEnv(sourceEnv, region);
  return (eventName, startTime, endTime) => {
    const args = ['cloudtrail', 'lookup-events', '--lookup-attributes',
      `AttributeKey=EventName,AttributeValue=${eventName}`,
      '--start-time', startTime, '--end-time', endTime,
      '--region', region, '--output', 'json', '--no-cli-pager'];
    return runFile('aws', args, {
      env,
      shell: false,
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
      windowsHide: true,
    });
  };
}

/**
 * #5563 · CA-1 — Runner de `sts get-caller-identity`, espejo exacto del de
 * CloudTrail: sin shell, env por allowlist, timeout. Sólo se usa para leer el
 * account id con el que se deriva la allowlist; inyectable vía
 * `opts.getCallerIdentity` con el mismo contrato que `opts.lookupEvents`.
 */
function createStsIdentityRunner(sourceEnv, region, deps = {}) {
  const runFile = deps.execFileSync || execFileSync;
  const env = buildAwsScopedEnv(sourceEnv, region);
  return () => runFile('aws', ['sts', 'get-caller-identity', '--output', 'json', '--no-cli-pager'], {
    env,
    shell: false,
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function readJson(file, fsImpl) {
  try { return fsImpl.existsSync(file) ? JSON.parse(fsImpl.readFileSync(file, 'utf8')) : {}; }
  catch { return {}; }
}

/**
 * Entrada encadenada de un fallo de recolección (CA-2). Espejo de la de
 * `NOTIFICACION_NO_ENVIADA`: marcador cerrado del pipeline, nunca el error del
 * driver. `event_name` + `stage` dicen QUÉ consulta no se pudo hacer.
 */
function recoleccionFallidaEntry(now, eventName, stage) {
  return {
    timestamp: now.toISOString(),
    principal_logico: 'pipeline',
    principal_hash: hashPrincipal('pipeline'),
    scope_logico: 'vault',
    almacen: 'pipeline',
    event_name: eventName,
    resultado: 'error',
    causa: 'RECOLECCION_FALLIDA',
    evidencia: 'RECOLECCION_FALLIDA',
    stage,
  };
}

function runAccessAuditTick(opts = {}) {
  const startedAt = Date.now();
  const fsImpl = opts.fsImpl || fs;
  const config = opts.config && typeof opts.config === 'object' ? opts.config : {};
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const omitido = (reason, extra = {}) => ({
    skipped: true, reason, records: [], notifications: [], errors: [], duration_ms: Date.now() - startedAt, ...extra,
  });
  if (config.enabled !== true) return omitido('disabled');

  // La región sale SÓLO de `kernel.region` (pulpo.js la pasa en opts.region), que
  // es la misma fuente que documenta el runbook. NO se cae a AWS_REGION /
  // AWS_DEFAULT_REGION a propósito: el Event history de CloudTrail es POR REGIÓN,
  // así que una región heredada del ambiente que no sea la del vault no falla —
  // devuelve `Events: 0`, indistinguible de "nadie accedió al vault". Ese falso
  // negativo silencioso es justamente lo que este control existe para evitar, y
  // un fallback lo reintroduce por la puerta de atrás.
  const region = opts.region;
  // Sin región no se consulta nada: `--region undefined` devolvería un error de
  // la CLI que se leería como "no hubo accesos", o sea un control apagado que
  // aparenta estar prendido. Se prefiere no correr y decirlo (R-H).
  if (!opts.lookupEvents && !region) {
    log('[vault-access-audit] tick omitido: falta kernel.region');
    return omitido('sin-region');
  }

  const now = opts.now instanceof Date ? opts.now : new Date();
  const pipelineDir = opts.pipelineDir || path.resolve(__dirname, '..');
  const statePath = opts.statePath || path.join(pipelineDir, 'vault-access-audit-state.json');
  const auditPath = opts.auditPath || path.join(pipelineDir, 'logs', 'vault-access-audit.jsonl');
  const lookbackMin = Math.max(1, Number(config.lookback_min || 30));
  const sourceEnv = opts.sourceEnv || process.env;
  const errors = [];

  // #5563 · CA-1 — Allowlist EFECTIVA = literales ∪ derivadas por host. La
  // derivación necesita `sts`: sin región y sin runner inyectado no hay forma
  // de preguntar, y eso es `allowlist-no-derivable`, no `empty-allowlist`.
  const getCallerIdentity = typeof opts.getCallerIdentity === 'function'
    ? opts.getCallerIdentity
    : (region ? createStsIdentityRunner(sourceEnv, region, opts) : null);
  const allowlist = resolveExpectedPrincipals({
    config,
    vaultConfig: opts.vaultConfig,
    getCallerIdentity,
    hostname: opts.hostname,
    cache: opts.accountIdCache,
    region,
  });
  const state = readJson(statePath, fsImpl);
  const ticksDegradadosPrevios = Number.isSafeInteger(state.ticks_degradados_consecutivos)
    ? state.ticks_degradados_consecutivos : 0;

  if (allowlist.derivation.requested && !allowlist.derivation.ok) {
    // NO es silenciosa: cuenta como fallo de recolección (CA-2). Rastro
    // encadenado ANTES de notificar, y la notificación pasa por el mismo
    // cooldown que las demás causas (evaluador sin eventos, sólo la detección).
    log(`[vault-access-audit] tick omitido: allowlist-no-derivable (${allowlist.derivation.reason})`);
    errors.push({ stage: 'derive-allowlist', message: 'no se pudo derivar la allowlist por host' });
    const entry = recoleccionFallidaEntry(now, 'VaultAuditAllowlist', 'derive-allowlist');
    try { appendChained({ file: auditPath, entry, fsImpl }); }
    catch (_err) { errors.push({ stage: 'append-audit', message: 'no se pudo escribir el rastro encadenado' }); }
    const result = evaluateAccessEvents({
      now, events: [], state, config: { ...config, expected_principals: allowlist.principals },
      recoleccion: { fallidas: ACCESS_EVENT_NAMES.length, total: ACCESS_EVENT_NAMES.length, ventana_min: lookbackMin },
    });
    result.records.push(entry);
    persistDetections({ result, now, auditPath, fsImpl, errors });
    notifyFindings({ result, now, auditPath, fsImpl, errors, log, sendTelegramFn: opts.sendTelegramFn });
    persistState({
      statePath, fsImpl, errors,
      nextState: { ...result.nextState, ticks_degradados_consecutivos: ticksDegradadosPrevios + 1 },
    });
    return {
      ...omitido('allowlist-no-derivable'),
      records: result.records,
      notifications: result.notifications,
      detections: result.detections,
      errors,
      resumen: {
        consultas_total: ACCESS_EVENT_NAMES.length,
        consultas_fallidas: ACCESS_EVENT_NAMES.length,
        accesos_observados: 0,
        degradado: true,
      },
      duration_ms: Date.now() - startedAt,
    };
  }
  if (allowlist.principals.length === 0) {
    log('[vault-access-audit] tick omitido: expected_principals está vacía');
    return omitido('empty-allowlist');
  }

  const start = new Date(now.getTime() - lookbackMin * 60 * 1000).toISOString();
  const runner = opts.lookupEvents || createCloudTrailRunner(sourceEnv, region, opts);
  const events = [];
  const consultasFallidas = [];

  for (const eventName of ACCESS_EVENT_NAMES) {
    try {
      const payload = JSON.parse(runner(eventName, start, now.toISOString()) || '{}');
      events.push(...(Array.isArray(payload.Events) ? payload.Events : []));
    } catch (_err) {
      errors.push({ stage: 'lookup-events', event_name: eventName, message: 'consulta CloudTrail falló' });
      consultasFallidas.push(eventName);
      log(`[vault-access-audit] WARN lookup-events falló para ${eventName}`);
    }
  }

  // #5563 · CA-2 — Lo que no se pudo observar se DICE: una detección por tick
  // (misma causa, mismo cooldown) y una entrada encadenada por consulta.
  const recoleccion = consultasFallidas.length
    ? { fallidas: consultasFallidas.length, total: ACCESS_EVENT_NAMES.length, ventana_min: lookbackMin }
    : null;
  const result = evaluateAccessEvents({
    now, events, state, recoleccion,
    config: { ...config, expected_principals: allowlist.principals },
  });
  const accesosObservados = result.records.length;
  for (const entry of result.records) {
    try { appendChained({ file: auditPath, entry, fsImpl }); }
    catch (_err) { errors.push({ stage: 'append-audit', message: 'no se pudo escribir el rastro encadenado' }); }
  }
  for (const eventName of consultasFallidas) {
    const entry = recoleccionFallidaEntry(now, eventName, 'lookup-events');
    try { appendChained({ file: auditPath, entry, fsImpl }); }
    catch (_err) { errors.push({ stage: 'append-audit', message: 'no se pudo registrar la consulta fallida' }); }
    result.records.push(entry);
  }

  persistDetections({ result, now, auditPath, fsImpl, errors });
  notifyFindings({ result, now, auditPath, fsImpl, errors, log, sendTelegramFn: opts.sendTelegramFn });

  // #5563 · UX-B — Contador de ticks degradados consecutivos. Al recuperarse,
  // UNA línea en el log y nada por Telegram: cero ruido en el camino feliz.
  const degradado = consultasFallidas.length > 0;
  const ticksDegradados = degradado ? ticksDegradadosPrevios + 1 : 0;
  if (!degradado && ticksDegradadosPrevios > 0) {
    log(`[vault-access-audit] Tick recuperado tras ${ticksDegradadosPrevios} tick(s) degradado(s)`);
  }
  persistState({
    statePath, fsImpl, errors,
    nextState: { ...result.nextState, ticks_degradados_consecutivos: ticksDegradados },
  });
  return {
    ...result,
    errors,
    skipped: false,
    resumen: {
      consultas_total: ACCESS_EVENT_NAMES.length,
      consultas_fallidas: consultasFallidas.length,
      accesos_observados: accesosObservados,
      degradado,
    },
    duration_ms: Date.now() - startedAt,
  };
}

/**
 * #5801 · SEC-4/SEC-5 — Cada detección deja entrada encadenada ANTES de
 * intentar notificar, y también cuando el cooldown suprime el aviso: si el
 * registro dependiera del envío, silenciar el canal borraría la evidencia.
 */
function persistDetections({ result, now, auditPath, fsImpl, errors }) {
  for (const deteccion of result.detections || []) {
    const entry = {
      timestamp: now.toISOString(),
      principal_logico: 'pipeline',
      principal_hash: deteccion.principal_hash,
      scope_logico: deteccion.scope_logico,
      almacen: 'pipeline',
      event_name: 'VaultAuditDetection',
      resultado: 'detected',
      causa: deteccion.causa,
      notificada: deteccion.notificada,
      // Sólo enteros del pipeline y el vocabulario cerrado del vault: ni un
      // valor, payload o identificador que venga del driver.
      lecturas_fisicas: Number.isFinite(deteccion.lecturas_fisicas) ? deteccion.lecturas_fisicas : null,
      umbral: Number.isFinite(deteccion.umbral) ? deteccion.umbral : null,
      ventana_min: Number.isFinite(deteccion.ventana_min) ? deteccion.ventana_min : null,
      unidad: deteccion.unidad || null,
      evidencia: null,
    };
    try { appendChained({ file: auditPath, entry, fsImpl }); }
    catch (_err) { errors.push({ stage: 'append-audit', message: 'no se pudo registrar la detección' }); }
  }
}

/**
 * Envía las alertas del tick. #5563 · UX-B — las de recolección viajan en una
 * llamada SEPARADA de las de acceso, para que nunca se mezclen headers: "a
 * oscuras" y "acceso fuera de lo esperado" son dos hechos distintos.
 */
function notifyFindings({ result, now, auditPath, fsImpl, errors, log, sendTelegramFn }) {
  if (!result.notifications.length || typeof sendTelegramFn !== 'function') return;
  const accesos = result.notifications.filter((n) => n.causa !== 'RECOLECCION_FALLIDA');
  const oscuras = result.notifications.filter((n) => n.causa === 'RECOLECCION_FALLIDA');
  for (const grupo of [accesos, oscuras]) {
    if (!grupo.length) continue;
    const correlationId = `vault-${now.getTime().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    try { sendTelegramFn(formatAccessAlert(grupo, correlationId)); }
    catch (_err) {
      // R-D · El canal de la alerta depende del propio vault que la alerta
      // vigila. Fail-SOFT en la notificación, fail-CLOSED en el rastro: si no
      // se pudo avisar, el silencio del canal no puede leerse como "todo bien"
      // (UX-5), así que la falla queda como entrada encadenada.
      errors.push({ stage: 'send-telegram', message: 'no se pudo notificar al operador' });
      log('[vault-access-audit] WARN no se pudo notificar al operador');
      const failure = {
        timestamp: now.toISOString(),
        principal_logico: 'pipeline',
        principal_hash: hashPrincipal('pipeline'),
        scope_logico: 'telegram',
        almacen: 'pipeline',
        event_name: 'VaultAuditNotification',
        resultado: 'error',
        causa: null,
        // Nunca el error del canal: sólo un marcador cerrado del pipeline.
        evidencia: 'NOTIFICACION_NO_ENVIADA',
      };
      try { appendChained({ file: auditPath, entry: failure, fsImpl }); }
      catch (_e) { errors.push({ stage: 'append-audit', message: 'no se pudo registrar la falla de notificación' }); }
      result.records.push(failure);
    }
  }
}

/**
 * #5563 · UX-C — Línea de `pulpo.log` de un tick que corrió. Formato estable y
 * greppable, `DEGRADADO` al principio cuando alguna consulta falló, duración
 * siempre en `ms` con unidad. Los números salen de `resumen` (los decide el
 * módulo); acá sólo se formatean.
 *
 *   Tick OK: 0 acceso(s), 0 alerta(s), 5/5 consultas, 1834 ms
 *   Tick DEGRADADO: 5/5 consultas fallaron, 0 acceso(s) observados, 20012 ms
 */
function formatTickLogLine(result) {
  const r = (result && result.resumen) || {};
  const total = Number.isFinite(r.consultas_total) ? r.consultas_total : ACCESS_EVENT_NAMES.length;
  const fallidas = Number.isFinite(r.consultas_fallidas) ? r.consultas_fallidas : 0;
  const accesos = Number.isFinite(r.accesos_observados) ? r.accesos_observados
    : (result && Array.isArray(result.records) ? result.records.length : 0);
  const alertas = result && Array.isArray(result.notifications) ? result.notifications.length : 0;
  const ms = Number.isFinite(result && result.duration_ms) ? result.duration_ms : 0;
  if (r.degradado === true || fallidas > 0) {
    return `Tick DEGRADADO: ${fallidas}/${total} consultas fallaron, ${accesos} acceso(s) observados, ${ms} ms`;
  }
  return `Tick OK: ${accesos} acceso(s), ${alertas} alerta(s), ${total - fallidas}/${total} consultas, ${ms} ms`;
}

function persistState({ statePath, fsImpl, errors, nextState }) {
  try {
    fsImpl.writeFileSync(statePath, JSON.stringify(nextState, null, 2));
  } catch (_err) {
    errors.push({ stage: 'persist-state', message: 'no se pudo persistir el cursor de auditoría' });
  }
}

module.exports = {
  ACCESS_EVENT_NAMES,
  BURST_UNIT,
  CAUSAS,
  HOST_ROLE_PREFIX,
  buildHostRoleArn,
  resolveExpectedPrincipals,
  createStsIdentityRunner,
  classifyAccessEvent,
  readBurstThreshold,
  UNKNOWN_SCOPE,
  UNKNOWN_PRINCIPAL,
  normalizePrincipal,
  logicalPrincipal,
  almacenFor,
  normalizeEvent,
  evaluateAccessEvents,
  formatAccessAlert,
  formatTickLogLine,
  createCloudTrailRunner,
  runAccessAuditTick,
};
