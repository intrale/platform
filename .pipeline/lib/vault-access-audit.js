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
const { VAULT_TELEMETRY_CATEGORIES, VAULT_TELEMETRY } = require('./secret-vault');

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
});
const UNKNOWN_SCOPE = 'desconocido';
const UNKNOWN_PRINCIPAL = 'desconocido';
const DEFAULT_AUTH_FAILURE_THRESHOLD = 3;

function asMillis(value) {
  const n = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(n) ? n : 0;
}

function normalizePrincipal(value) {
  if (typeof value !== 'string' || !value) return null;
  const assumed = /^arn:aws[^:]*:sts::(\d{12}):assumed-role\/([^/]+)\/[^/]+$/.exec(value);
  return assumed ? `arn:aws:iam::${assumed[1]}:role/${assumed[2]}` : value;
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
function evaluateAccessEvents({ now, events, state, config }) {
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

const CONSECUENCIA = Object.freeze({
  IDENTIDAD_NO_ESPERADA: 'alguien que no está en la lista de identidades autorizadas leyó credenciales '
    + 'del vault: hay que asumir que esas credenciales quedaron expuestas hasta demostrar lo contrario',
  AUTORIZACION_RECHAZADA: 'se acumularon rechazos de permisos contra el vault: o hay una identidad '
    + 'probando accesos que no le corresponden, o un host quedó con permisos incompletos y sus agentes '
    + 'van a fallar al arrancar',
  RAFAGA_DE_LECTURAS: 'el volumen de lecturas se salió del patrón normal de la ventana: puede ser un '
    + 'lazo de reintentos del propio pipeline o un uso que no debería estar ocurriendo',
});

const ACCION = Object.freeze({
  IDENTIDAD_NO_ESPERADA: 'revisá el Event history de CloudTrail para la ventana informada y confirmá si '
    + 'ese acceso era legítimo. Si no lo era, rotá los secretos del scope afectado siguiendo '
    + '`docs/pipeline/vault-rotacion-auditoria.md`. Si lo era, sumá el rol a '
    + '`vault.access_audit.expected_principals` en `.pipeline/config.yaml`.',
  AUTORIZACION_RECHAZADA: 'revisá en el Event history quién recibió los rechazos y contrastá la policy '
    + 'del rol del host contra `docs/pipeline/vault-rotacion-auditoria.md`.',
  RAFAGA_DE_LECTURAS: 'revisá el detalle del rastro antes de subir `vault.access_audit.burst_threshold`: '
    + 'si el volumen viene del propio pipeline, el umbral está mal calibrado y hay que recalibrarlo, no silenciarlo.',
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
  const lines = [HEADER_ALERTA, ''];
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

function readJson(file, fsImpl) {
  try { return fsImpl.existsSync(file) ? JSON.parse(fsImpl.readFileSync(file, 'utf8')) : {}; }
  catch { return {}; }
}

function runAccessAuditTick(opts = {}) {
  const fsImpl = opts.fsImpl || fs;
  const config = opts.config && typeof opts.config === 'object' ? opts.config : {};
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  if (config.enabled !== true) return { skipped: true, reason: 'disabled', records: [], notifications: [], errors: [] };
  if (!Array.isArray(config.expected_principals) || config.expected_principals.length === 0) {
    log('[vault-access-audit] tick omitido: expected_principals está vacía');
    return { skipped: true, reason: 'empty-allowlist', records: [], notifications: [], errors: [] };
  }

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
    return { skipped: true, reason: 'sin-region', records: [], notifications: [], errors: [] };
  }

  const now = opts.now instanceof Date ? opts.now : new Date();
  const pipelineDir = opts.pipelineDir || path.resolve(__dirname, '..');
  const statePath = opts.statePath || path.join(pipelineDir, 'vault-access-audit-state.json');
  const auditPath = opts.auditPath || path.join(pipelineDir, 'logs', 'vault-access-audit.jsonl');
  const lookbackMin = Math.max(1, Number(config.lookback_min || 30));
  const start = new Date(now.getTime() - lookbackMin * 60 * 1000).toISOString();
  const runner = opts.lookupEvents
    || createCloudTrailRunner(opts.sourceEnv || process.env, region, opts);
  const events = [];
  const errors = [];

  for (const eventName of ACCESS_EVENT_NAMES) {
    try {
      const payload = JSON.parse(runner(eventName, start, now.toISOString()) || '{}');
      events.push(...(Array.isArray(payload.Events) ? payload.Events : []));
    } catch (_err) {
      errors.push({ stage: 'lookup-events', event_name: eventName, message: 'consulta CloudTrail falló' });
      log(`[vault-access-audit] WARN lookup-events falló para ${eventName}`);
    }
  }

  const state = readJson(statePath, fsImpl);
  const result = evaluateAccessEvents({ now, events, state, config });
  for (const entry of result.records) {
    try { appendChained({ file: auditPath, entry, fsImpl }); }
    catch (_err) { errors.push({ stage: 'append-audit', message: 'no se pudo escribir el rastro encadenado' }); }
  }

  // #5801 · SEC-4/SEC-5 — Cada detección deja entrada encadenada ANTES de
  // intentar notificar, y también cuando el cooldown suprime el aviso: si el
  // registro dependiera del envío, silenciar el canal borraría la evidencia.
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

  if (result.notifications.length && typeof opts.sendTelegramFn === 'function') {
    const correlationId = `vault-${now.getTime().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    try { opts.sendTelegramFn(formatAccessAlert(result.notifications, correlationId)); }
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

  try {
    fsImpl.writeFileSync(statePath, JSON.stringify(result.nextState, null, 2));
  } catch (_err) {
    errors.push({ stage: 'persist-state', message: 'no se pudo persistir el cursor de auditoría' });
  }
  return { ...result, errors, skipped: false };
}

module.exports = {
  ACCESS_EVENT_NAMES,
  BURST_UNIT,
  CAUSAS,
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
  createCloudTrailRunner,
  runAccessAuditTick,
};
