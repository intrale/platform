// =============================================================================
// pr-mergeability-watcher.js — Observación segura de mergeabilidad de PRs (#4966)
// =============================================================================
//
// QUÉ RESUELVE
// ------------
// Un PR de la ola que queda `CONFLICTING` contra `main` por un merge posterior
// hoy es invisible para el pipeline: el issue se congela y sólo se descubre a
// mano (escape #4569). Este módulo detecta ese estado, lo confirma con dos
// observaciones separadas por un poll real, y emite un evento candidato.
//
// LO QUE ESTE MÓDULO **NO** HACE
// ------------------------------
// No ejecuta transiciones, no rebota issues, no cierra ni mergea PRs. Sólo
// OBSERVA y EMITE. Quien actúa es `pipeline-rewind.rewindFromMergeConflict`
// (#4967, ya mergeado), y quien lo engancha al barrido periódico es #4968.
//
// DOS CAPAS EN EL MISMO MÓDULO (molde `brazo-barrido-core.js`)
// -----------------------------------------------------------
//   - `decideMergeability(...)` — PURA. Sin `fs`, sin `gh`, sin `Date.now()`
//     propio, sin estado global. Todo entra por parámetro y sale por retorno.
//   - `runWatcherPoll(...)` — ADAPTADOR. Todo el I/O es inyectable por `deps`.
//
// DOS ARTEFACTOS DISTINTOS, A PROPÓSITO (G-UX-7)
// ----------------------------------------------
//   1. El **evento** que consume #4967 tiene shape CERRADO de 6 campos
//      (`MERGE_CONFLICT_EVENT_FIELDS` en `pipeline-rewind.js:1413`): una clave
//      extra es RECHAZO, no un campo ignorado. Se construye con
//      `buildMergeConflictEvent()` y nada más viaja ahí.
//   2. El **JSONL de auditoría** (`.pipeline/audit/pr-mergeability-events.jsonl`)
//      es la superficie del OPERADOR y necesita `decision`, `reason` y
//      `observations` — justo lo que el shape cerrado no admite. Colapsar los
//      dos artefactos deja al operador sin poder consultar por qué el watcher
//      hizo (o no hizo) algo.
//
// POR QUÉ DOS OBSERVACIONES (CA-2)
// --------------------------------
// GitHub calcula `mergeable` de forma DIFERIDA: `gh pr list` devuelve
// `UNKNOWN` y ceba el cálculo; `gh pr view <N>` sobre el mismo PR lo resuelve
// (verificado en vivo: 4/4 PRs abiertos con `UNKNOWN` en el list y resueltos en
// el view). Un watcher de una sola muestra vería `UNKNOWN` casi siempre → falso
// negativo permanente. De ahí el flujo `pr list` barato para cebar y barrer →
// `pr view` sólo sobre los sospechosos para confirmar.
//
// DEFENSA CONTRA RELOJ NO MONÓTONO
// --------------------------------
// El timestamp por sí solo no alcanza (NTP, suspensión de la máquina). El
// contador `pollSeq` es monótono y se persiste en el estado: se exigen AMBAS
// condiciones —`pollSeq` estrictamente creciente Y delta de `ts` no menor a
// `minPollIntervalMs`— y un delta negativo reinicia la secuencia sin emitir.
//
// IDEMPOTENCIA (CA-4)
// -------------------
// La clave del estado es `${repo}#${pr}` y la entrada guarda su `headRefOid`.
// Un `headRefOid` distinto descarta la entrada previa y arranca secuencia nueva
// — que es exactamente la semántica de dedupe por `{repo, pr, headRefOid}`,
// pero además deja detectable el cambio de HEAD (con el oid EN la clave, el
// cambio de HEAD sería indistinguible de un PR nuevo, y el archivo crecería una
// entrada por push).
//
// La barrera DURA de idempotencia del rebote NO vive acá: es
// `.pipeline/lib/rewind-merge-dedupe.js` (#4967 · CA-9), del lado del
// consumidor, dentro de su lock. Reimplementarla acá sería duplicar la
// autoridad sobre "esto ya se hizo".
//
// LIMITACIÓN DE COBERTURA DECLARADA (CA-9)
// ----------------------------------------
// `waves.json` guarda `{number, status}` por issue, SIN campo PR. La única
// vinculación issue↔PR posible es la convención de branch `agent/<issue>-`.
// Consecuencia: un PR abierto conflictivo cuya rama no sigue esa convención
// (ej. `docs/...`, `agent/api-pelada-agents-parity`) queda FUERA del universo
// observado. Es una decisión de diseño registrada —se audita como no-op
// `no_agent_branch`, se documenta en `docs/pipeline/pr-mergeability-watcher.md`—
// no un bug silencioso.
//
// Ver: docs/pipeline/pr-mergeability-watcher.md
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  fetchOpenPrCandidatesAsync,
  fetchPrMergeabilityAsync,
  _redact,
} = require('./pr-info-fetcher');

// -----------------------------------------------------------------------------
// Constantes
// -----------------------------------------------------------------------------

// Debe coincidir EXACTAMENTE con `MERGE_CONFLICT_SOURCE` de `pipeline-rewind.js`
// (comparación estricta allá, sin trim ni lowercase). No se importa el módulo
// para no arrastrar su costo de carga a un camino frío: se replica la constante
// y un test verifica que siguen siendo iguales.
const EVENT_SOURCE = 'mergeability-watcher';

// Shape cerrado del evento. Espejo de `MERGE_CONFLICT_EVENT_FIELDS`.
const EVENT_FIELDS = Object.freeze(['source', 'repo', 'pr', 'issue', 'headRefOid', 'detected_at']);

const STATE_DIRNAME = 'state';
const STATE_FILENAME = 'pr-mergeability-watcher.json';
const AUDIT_DIRNAME = 'audit';
const EVENTS_FILENAME = 'pr-mergeability-events.jsonl';

const STATE_VERSION = 1;

const REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const OID_RE = /^[0-9a-f]{7,64}$/;
// Convención de rama de agente. El guion final evita que `agent/30300-x` matchee
// el issue 3030 (misma defensa que `pr-info-fetcher._buildArgs`).
const AGENT_BRANCH_RE = /^agent\/(\d+)-/;

// Valores de GitHub que consideramos conflicto confirmado / estado sano.
const CONFLICT_MERGEABLE = 'CONFLICTING';
const CONFLICT_STATUS = 'DIRTY';
const HEALTHY_MERGEABLE = 'MERGEABLE';
const HEALTHY_STATUS = 'CLEAN';

const DEFAULT_MIN_POLL_INTERVAL_MS = 60_000;
const DEFAULT_GH_TIMEOUT_MS = 5_000;
const DEFAULT_CANDIDATE_LIMIT = 20;
const DEFAULT_STATE_ENTRY_TTL_HOURS = 72;
const DEFAULT_REPO = 'intrale/platform';
const DEFAULT_BASE = 'main';

// Máximo de observaciones retenidas por entrada. Con dos alcanza para decidir y
// el archivo de estado no crece por PR longevo.
const MAX_OBSERVATIONS = 2;

/**
 * Leyenda de motivos tipados. Van al JSONL de auditoría y son la evidencia de
 * CA-3: todo lo dudoso es no-op CON MOTIVO, nunca un evento y nunca un silencio.
 *
 * Los marcados `[body]` son los 19 definidos en la receta del issue; el resto se
 * agregaron porque el flujo real los necesita y un motivo sin nombre no es
 * auditable. La leyenda operativa completa vive en la doc del módulo.
 */
const REASONS = Object.freeze({
  // --- emisión ---------------------------------------------------------------
  CONFIRMED_CONFLICT: 'confirmed_conflict', // única razón que emite evento
  // --- secuencia de observación ---------------------------------------------
  UNKNOWN_STATE: 'unknown_state',           // [body] GitHub aún no resolvió mergeable
  SINGLE_SAMPLE: 'single_sample',           // [body] una sola muestra conflictiva
  FLAPPING: 'flapping',                     // [body] CONFLICTING -> sano -> ...
  RECOVERED: 'recovered',                   // PR volvió a estado sano
  HEAD_CHANGED: 'head_changed',             // [body] nuevo push: secuencia nueva
  CLOCK_NOT_MONOTONIC: 'clock_not_monotonic', // [body] ts/pollSeq retrocedieron
  SAME_POLL: 'same_poll',                   // [body] no pasó un poll real entre muestras
  ALREADY_EMITTED: 'already_emitted',       // [body] dedupe {repo,pr,headRefOid}
  // --- universo de candidatos (CA-1) ----------------------------------------
  AMBIGUOUS_ASSOCIATION: 'ambiguous_association', // [body] 0 o >1 PRs para el issue
  NOT_IN_ACTIVE_WAVE: 'not_in_active_wave',       // [body]
  FORK_OR_CROSS_REPO: 'fork_or_cross_repo',       // [body]
  UNEXPECTED_BASE: 'unexpected_base',             // [body]
  UNEXPECTED_REPO: 'unexpected_repo',             // el PR no pertenece al repo esperado
  NOT_OPEN: 'not_open',                           // estado distinto de OPEN
  NO_AGENT_BRANCH: 'no_agent_branch',             // limitación declarada de CA-9
  INVALID_ID: 'invalid_id',                       // [body]
  NO_ACTIVE_WAVE: 'no_active_wave',               // no hay ola activa: nada que observar
  // --- fallos de GitHub / datos ---------------------------------------------
  SCHEMA_INVALID: 'schema_invalid',         // [body]
  GH_TIMEOUT: 'gh_timeout',                 // [body]
  RATE_LIMITED: 'rate_limited',             // [body]
  NON_ZERO_EXIT: 'non_zero_exit',           // [body]
  JSON_PARSE_FAILED: 'json_parse_failed',   // [body]
  // --- estado / entorno ------------------------------------------------------
  STATE_CORRUPT: 'state_corrupt',           // [body]
  PATH_ESCAPE: 'path_escape',               // [body]
  DISABLED: 'disabled',                     // enabled:false — default de rollout
  INTERNAL_ERROR: 'internal_error',         // excepción capturada, nunca propagada
});

// -----------------------------------------------------------------------------
// Errores tipados
// -----------------------------------------------------------------------------

function typedError(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

// -----------------------------------------------------------------------------
// Config: defaults + clamps EN CÓDIGO (CA-5/CA-7). El YAML sugiere, el código
// decide. Un `candidate_limit: 100000` editado a mano no dispara 100k llamadas.
// -----------------------------------------------------------------------------

function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * Normaliza la sección `pr_mergeability_watcher` de `config.yaml`.
 * Nunca lanza: un config basura degrada a los defaults conservadores.
 */
function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const repo = typeof c.expected_repo === 'string' && REPO_RE.test(c.expected_repo)
    ? c.expected_repo
    : DEFAULT_REPO;
  const owner = typeof c.expected_owner === 'string' && c.expected_owner.length > 0
    ? c.expected_owner
    : repo.split('/')[0];
  const base = typeof c.expected_base === 'string' && c.expected_base.length > 0
    ? c.expected_base
    : DEFAULT_BASE;
  return {
    // Fail-closed: sólo el booleano `true` enciende. `'true'`, `1` y `'yes'` no.
    enabled: c.enabled === true,
    repo,
    owner,
    base,
    candidateLimit: clampInt(c.candidate_limit, 1, 100, DEFAULT_CANDIDATE_LIMIT),
    minPollIntervalMs: clampInt(c.min_poll_interval_ms, 1_000, 24 * 3_600_000, DEFAULT_MIN_POLL_INTERVAL_MS),
    ghTimeoutMs: clampInt(c.gh_timeout_ms, 1_000, 60_000, DEFAULT_GH_TIMEOUT_MS),
    stateEntryTtlMs: clampInt(c.state_entry_ttl_hours, 1, 24 * 30, DEFAULT_STATE_ENTRY_TTL_HOURS) * 3_600_000,
    pollIntervalMinutes: clampInt(c.poll_interval_minutes, 1, 1_440, 10),
  };
}

// -----------------------------------------------------------------------------
// Rutas: SIEMPRE derivadas de constantes internas, NUNCA de `repo`, branch, PR
// ni ningún otro valor de origen remoto (A01/A05, CA-4).
// -----------------------------------------------------------------------------

/**
 * Resuelve `segments` bajo `pipelineRoot` verificando contención.
 * @throws {Error} con `code = 'path_escape'` si el resultado sale del root.
 */
function resolveContained(pipelineRoot, segments) {
  if (typeof pipelineRoot !== 'string' || pipelineRoot.length === 0) {
    throw typedError(REASONS.PATH_ESCAPE, 'pipelineRoot invalido');
  }
  const root = path.resolve(pipelineRoot);
  const target = path.resolve(root, ...segments);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw typedError(REASONS.PATH_ESCAPE, 'la ruta resuelve fuera de .pipeline/');
  }
  return target;
}

function statePath(pipelineRoot) {
  return resolveContained(pipelineRoot, [STATE_DIRNAME, STATE_FILENAME]);
}

function eventsPath(pipelineRoot) {
  return resolveContained(pipelineRoot, [AUDIT_DIRNAME, EVENTS_FILENAME]);
}

/**
 * Rechaza escribir sobre un symlink: un atacante con acceso al directorio
 * podría apuntar el archivo de estado a cualquier lado antes del rename.
 */
function assertNotSymlink(target, fsImpl) {
  const _fs = fsImpl || fs;
  let st;
  try {
    st = _fs.lstatSync(target);
  } catch {
    return; // no existe todavía: nada que suplantar
  }
  if (st && typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) {
    throw typedError(REASONS.PATH_ESCAPE, 'el archivo destino es un symlink');
  }
}

// -----------------------------------------------------------------------------
// Estado
// -----------------------------------------------------------------------------

function emptyState() {
  return { version: STATE_VERSION, pollSeq: 0, entries: {} };
}

function stateKey(repo, pr) {
  return `${repo}#${pr}`;
}

function isValidObservation(o) {
  return (
    o && typeof o === 'object' && !Array.isArray(o)
    && typeof o.mergeable === 'string'
    && typeof o.mergeStateStatus === 'string'
    && Number.isFinite(o.ts)
    && Number.isInteger(o.pollSeq) && o.pollSeq > 0
  );
}

/**
 * Valida y normaliza una entrada del estado. Devuelve `null` si el shape no es
 * el esperado — arrancar de cero es correcto; heredar basura y emitir sobre
 * ella, no.
 */
function sanitizeEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (typeof entry.repo !== 'string' || !REPO_RE.test(entry.repo)) return null;
  if (!Number.isInteger(entry.pr) || entry.pr <= 0) return null;
  if (typeof entry.headRefOid !== 'string' || !OID_RE.test(entry.headRefOid)) return null;
  if (!Array.isArray(entry.observations)) return null;
  const observations = entry.observations.filter(isValidObservation).slice(-MAX_OBSERVATIONS);
  if (observations.length !== entry.observations.length) return null;
  return {
    repo: entry.repo,
    pr: entry.pr,
    issue: Number.isInteger(entry.issue) && entry.issue > 0 ? entry.issue : null,
    headRefOid: entry.headRefOid,
    observations,
    emitted: entry.emitted === true,
    emittedAt: Number.isFinite(entry.emittedAt) ? entry.emittedAt : null,
    lastHealthyAt: Number.isFinite(entry.lastHealthyAt) ? entry.lastHealthyAt : null,
    lastSeenPollSeq: Number.isInteger(entry.lastSeenPollSeq) && entry.lastSeenPollSeq >= 0 ? entry.lastSeenPollSeq : 0,
    lastSeenAt: Number.isFinite(entry.lastSeenAt) ? entry.lastSeenAt : null,
  };
}

/**
 * Valida el documento de estado completo.
 * @returns {{ok:true, state:object}|{ok:false, reason:'state_corrupt'}}
 */
function sanitizeState(raw) {
  if (raw === null || raw === undefined) return { ok: true, state: emptyState() };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: REASONS.STATE_CORRUPT };
  if (raw.version !== STATE_VERSION) return { ok: false, reason: REASONS.STATE_CORRUPT };
  if (!Number.isInteger(raw.pollSeq) || raw.pollSeq < 0) return { ok: false, reason: REASONS.STATE_CORRUPT };
  if (!raw.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries)) {
    return { ok: false, reason: REASONS.STATE_CORRUPT };
  }
  const entries = {};
  for (const key of Object.keys(raw.entries)) {
    const clean = sanitizeEntry(raw.entries[key]);
    // Una entrada corrupta invalida el documento: preferimos arrancar de cero
    // (sin emitir) antes que operar sobre un estado parcialmente confiable.
    if (!clean) return { ok: false, reason: REASONS.STATE_CORRUPT };
    if (stateKey(clean.repo, clean.pr) !== key) return { ok: false, reason: REASONS.STATE_CORRUPT };
    entries[key] = clean;
  }
  return { ok: true, state: { version: STATE_VERSION, pollSeq: raw.pollSeq, entries } };
}

// -----------------------------------------------------------------------------
// CAPA PURA — decisión
// -----------------------------------------------------------------------------

function isConflict(mergeable, mergeStateStatus) {
  return mergeable === CONFLICT_MERGEABLE || mergeStateStatus === CONFLICT_STATUS;
}

function isHealthy(mergeable, mergeStateStatus) {
  if (isConflict(mergeable, mergeStateStatus)) return false;
  return mergeable === HEALTHY_MERGEABLE || mergeStateStatus === HEALTHY_STATUS;
}

function newEntry(obs) {
  return {
    repo: obs.repo,
    pr: obs.pr,
    issue: obs.issue,
    headRefOid: obs.headRefOid,
    observations: [],
    emitted: false,
    emittedAt: null,
    lastHealthyAt: null,
    lastSeenPollSeq: 0,
    lastSeenAt: null,
  };
}

/**
 * Decide qué hacer con UNA observación de UN PR. Función pura.
 *
 * @param {object} p
 * @param {object|null} p.prevEntry Entrada persistida previa (o `null`).
 * @param {object} p.observation `{repo, pr, issue, headRefOid, mergeable, mergeStateStatus}`.
 * @param {number} p.pollSeq Contador monótono del poll actual (entero > 0).
 * @param {number} p.now Epoch ms del poll actual (lo provee el caller).
 * @param {number} [p.minPollIntervalMs] Separación mínima entre las dos muestras.
 * @returns {{action:'emit'|'observe'|'noop'|'reset', reason:string, nextEntry:object|null}}
 */
function decideMergeability({ prevEntry, observation, pollSeq, now, minPollIntervalMs } = {}) {
  const obs = observation;
  const invalid = (reason) => ({ action: 'noop', reason, nextEntry: sanitizeEntry(prevEntry) });

  if (!obs || typeof obs !== 'object' || Array.isArray(obs)) return invalid(REASONS.SCHEMA_INVALID);
  if (typeof obs.repo !== 'string' || !REPO_RE.test(obs.repo)) return invalid(REASONS.SCHEMA_INVALID);
  if (!Number.isInteger(obs.pr) || obs.pr <= 0) return invalid(REASONS.INVALID_ID);
  if (!Number.isInteger(obs.issue) || obs.issue <= 0) return invalid(REASONS.INVALID_ID);
  if (typeof obs.headRefOid !== 'string' || !OID_RE.test(obs.headRefOid)) return invalid(REASONS.SCHEMA_INVALID);
  if (typeof obs.mergeable !== 'string' || typeof obs.mergeStateStatus !== 'string') {
    return invalid(REASONS.SCHEMA_INVALID);
  }
  if (!Number.isInteger(pollSeq) || pollSeq <= 0) return invalid(REASONS.SCHEMA_INVALID);
  if (!Number.isFinite(now)) return invalid(REASONS.SCHEMA_INVALID);

  const minGap = Number.isFinite(minPollIntervalMs) && minPollIntervalMs >= 0
    ? minPollIntervalMs
    : DEFAULT_MIN_POLL_INTERVAL_MS;

  let base = sanitizeEntry(prevEntry);
  let headChanged = false;
  if (base && (base.repo !== obs.repo || base.pr !== obs.pr)) base = null;
  if (base && base.headRefOid !== obs.headRefOid) {
    // Nuevo push: la secuencia anterior ya no habla de este HEAD. Se descarta
    // entera, incluido el flag `emitted` — un HEAD nuevo es un evento nuevo.
    base = null;
    headChanged = true;
  }

  const entry = base ? { ...base, observations: base.observations.slice() } : newEntry(obs);
  entry.issue = obs.issue;
  entry.lastSeenPollSeq = pollSeq;
  entry.lastSeenAt = now;

  // --- estado sano: recuperación comprobada → habilita una secuencia nueva ---
  if (isHealthy(obs.mergeable, obs.mergeStateStatus)) {
    const veniaConflictuado = entry.observations.length > 0 || entry.emitted;
    entry.observations = [];
    entry.lastHealthyAt = now;
    entry.emitted = false;
    entry.emittedAt = null;
    return {
      action: 'reset',
      reason: veniaConflictuado ? REASONS.FLAPPING : REASONS.RECOVERED,
      nextEntry: entry,
    };
  }

  // --- no concluyente (UNKNOWN, BLOCKED, BEHIND...): rompe la consecutividad -
  if (!isConflict(obs.mergeable, obs.mergeStateStatus)) {
    entry.observations = [];
    return {
      action: 'observe',
      reason: headChanged ? REASONS.HEAD_CHANGED : REASONS.UNKNOWN_STATE,
      nextEntry: entry,
    };
  }

  // --- conflicto -------------------------------------------------------------
  if (entry.emitted) {
    // Dedupe por {repo, pr, headRefOid}: ya se emitió para este HEAD.
    return { action: 'noop', reason: REASONS.ALREADY_EMITTED, nextEntry: entry };
  }

  const prev = entry.observations.length > 0 ? entry.observations[entry.observations.length - 1] : null;
  const current = {
    mergeable: obs.mergeable,
    mergeStateStatus: obs.mergeStateStatus,
    ts: now,
    pollSeq,
  };

  if (prev) {
    if (prev.pollSeq === pollSeq) {
      // Dos observaciones del MISMO poll no son dos polls. No acumula.
      return { action: 'noop', reason: REASONS.SAME_POLL, nextEntry: entry };
    }
    if (pollSeq < prev.pollSeq || now < prev.ts) {
      // Reloj hacia atrás (NTP/suspensión) o secuencia desordenada: la muestra
      // previa deja de ser confiable. Se reinicia con la actual como ancla.
      entry.observations = [current];
      return { action: 'noop', reason: REASONS.CLOCK_NOT_MONOTONIC, nextEntry: entry };
    }
    if (now - prev.ts < minGap) {
      // Pasó un poll pero no el tiempo mínimo: se conserva el ancla y se espera.
      return { action: 'noop', reason: REASONS.SAME_POLL, nextEntry: entry };
    }
    entry.observations = [prev, current];
    entry.emitted = true;
    entry.emittedAt = now;
    return { action: 'emit', reason: REASONS.CONFIRMED_CONFLICT, nextEntry: entry };
  }

  entry.observations = [current];
  return {
    action: 'observe',
    reason: headChanged ? REASONS.HEAD_CHANGED : REASONS.SINGLE_SAMPLE,
    nextEntry: entry,
  };
}

// -----------------------------------------------------------------------------
// Evento canónico (CA-11) — shape CERRADO, lo valida `pipeline-rewind.js`
// -----------------------------------------------------------------------------

/**
 * Construye el evento que consume `rewindFromMergeConflict`. Exactamente las
 * claves de `EVENT_FIELDS`, ni una más: una clave extra es `EVENT_UNEXPECTED_FIELDS`
 * del lado del consumidor, no un campo ignorado.
 */
function buildMergeConflictEvent({ repo, pr, issue, headRefOid, detectedAt }) {
  return {
    source: EVENT_SOURCE,
    repo,
    pr,
    issue,
    headRefOid,
    detected_at: detectedAt,
  };
}

// -----------------------------------------------------------------------------
// Registro de auditoría (JSONL, append-only) — superficie del OPERADOR
// -----------------------------------------------------------------------------

function buildAuditRecord({ now, wave, decision, reason, repo, pr, issue, headRefOid, observations, detail }) {
  return {
    timestamp: new Date(now).toISOString(),
    repo: repo === undefined ? null : repo,
    pr: pr === undefined ? null : pr,
    issue: issue === undefined ? null : issue,
    head_ref_oid: headRefOid === undefined ? null : headRefOid,
    wave: wave === undefined ? null : wave,
    decision,
    reason,
    observations: Array.isArray(observations)
      ? observations.map((o) => ({
        mergeable: o.mergeable,
        merge_state_status: o.mergeStateStatus,
        ts: new Date(o.ts).toISOString(),
        poll_seq: o.pollSeq,
      }))
      : [],
    ...(detail ? { detail: _redact(detail) } : {}),
  };
}

// -----------------------------------------------------------------------------
// I/O por defecto (todo sustituible por `deps`)
// -----------------------------------------------------------------------------

function defaultReadState(pipelineRoot, fsImpl) {
  const _fs = fsImpl || fs;
  const target = statePath(pipelineRoot);
  let raw;
  try {
    raw = _fs.readFileSync(target, 'utf8');
  } catch {
    return null; // no existe todavía → estado vacío
  }
  return JSON.parse(raw); // el caller envuelve en try/catch → state_corrupt
}

function defaultWriteState(pipelineRoot, state, fsImpl) {
  const _fs = fsImpl || fs;
  const target = statePath(pipelineRoot);
  assertNotSymlink(target, _fs);
  _fs.mkdirSync(path.dirname(target), { recursive: true });
  const payload = JSON.stringify(state, null, 2);
  if (_fs === fs) {
    // Implementación canónica del repo: tmp + fsync + rename con reintentos
    // EPERM/EBUSY/EACCES (imprescindible en Windows). No se reimplementa.
    require('./waves').atomicWriteFile(target, payload);
  } else {
    // Con un `fsImpl` doble la atomicidad es una propiedad del filesystem real,
    // no del doble: write directo (mismo criterio que rewind-merge-dedupe).
    _fs.writeFileSync(target, payload);
  }
}

function defaultAppendEvent(pipelineRoot, record, fsImpl) {
  const _fs = fsImpl || fs;
  const target = eventsPath(pipelineRoot);
  assertNotSymlink(target, _fs);
  _fs.mkdirSync(path.dirname(target), { recursive: true });
  // APPEND-ONLY. Nunca `writeFileSync` sobre este path: es el registro histórico
  // que consulta el operador.
  _fs.appendFileSync(target, JSON.stringify(record) + '\n', { encoding: 'utf8' });
}

// -----------------------------------------------------------------------------
// Universo de candidatos (CA-1)
// -----------------------------------------------------------------------------

/**
 * Aplica los filtros del universo observable a UN PR. Todas las condiciones en
 * AND; cualquier falla devuelve el motivo tipado para auditarlo como no-op.
 *
 * @returns {{ok:true, issue:number}|{ok:false, reason:string}}
 */
function screenCandidate(pr, cfg, waveIssues) {
  if (!pr || typeof pr !== 'object') return { ok: false, reason: REASONS.SCHEMA_INVALID };
  if (pr.state !== 'OPEN') return { ok: false, reason: REASONS.NOT_OPEN };
  // El repo se fija por argv (`--repo`), pero la `url` viene del remoto: si no
  // coincide, la respuesta no es del repo que pedimos.
  if (typeof pr.url === 'string' && pr.url.length > 0 && !pr.url.includes(`/${cfg.repo}/pull/`)) {
    return { ok: false, reason: REASONS.UNEXPECTED_REPO };
  }
  if (pr.baseRefName !== cfg.base) return { ok: false, reason: REASONS.UNEXPECTED_BASE };
  const owner = pr.headRepositoryOwner && typeof pr.headRepositoryOwner.login === 'string'
    ? pr.headRepositoryOwner.login.toLowerCase()
    : null;
  if (pr.isCrossRepository === true || !owner || owner !== cfg.owner.toLowerCase()) {
    return { ok: false, reason: REASONS.FORK_OR_CROSS_REPO };
  }
  const m = AGENT_BRANCH_RE.exec(pr.headRefName || '');
  if (!m) return { ok: false, reason: REASONS.NO_AGENT_BRANCH }; // limitación CA-9
  const issue = Number(m[1]);
  if (!Number.isInteger(issue) || issue <= 0) return { ok: false, reason: REASONS.INVALID_ID };
  if (!waveIssues.has(issue)) return { ok: false, reason: REASONS.NOT_IN_ACTIVE_WAVE };
  return { ok: true, issue };
}

// -----------------------------------------------------------------------------
// ADAPTADOR — un poll completo
// -----------------------------------------------------------------------------

/**
 * Ejecuta un poll del watcher.
 *
 * NUNCA propaga excepción (CA-7): un fallo del watcher no puede frenar el
 * barrido del Pulpo, el lanzamiento de agentes ni el avance de la ola. Cualquier
 * error sale como `{ ok: false, reason }`.
 *
 * @param {object} p
 * @param {object} p.config Sección `pr_mergeability_watcher` de `config.yaml`.
 * @param {object} p.deps I/O inyectable.
 * @param {string} p.deps.pipelineRoot Path absoluto a `.pipeline/`.
 * @param {Function} [p.deps.fetchCandidates] `({repo,limit,timeoutMs}) => Promise<result>`
 * @param {Function} [p.deps.fetchPrDetail] `(pr, {repo,timeoutMs}) => Promise<result>`
 * @param {Function} [p.deps.readState] `() => object|null`
 * @param {Function} [p.deps.writeState] `(state) => void`
 * @param {Function} [p.deps.appendEvent] `(record) => void`
 * @param {Function} [p.deps.getActiveWave] `() => {number, issues:[{number}]}|null`
 * @param {Function} [p.deps.now] `() => epochMs`
 * @returns {Promise<object>} `{ok, pollSeq, events, audit, reason?}` — nunca throw.
 */
async function runWatcherPoll({ config, deps } = {}) {
  const d = deps && typeof deps === 'object' ? deps : {};
  const now = typeof d.now === 'function' ? d.now : Date.now;
  const audit = [];
  const events = [];
  let waveNumber = null;

  // Escribe una línea de auditoría. Un fallo del JSONL no puede tumbar el poll:
  // se registra en memoria y el resultado del poll lo refleja.
  const auditWriteErrors = [];
  const record = (rec) => {
    audit.push(rec);
    try {
      if (typeof d.appendEvent === 'function') d.appendEvent(rec);
      else defaultAppendEvent(d.pipelineRoot, rec, d.fsImpl);
    } catch (e) {
      auditWriteErrors.push(_redact(e && e.message));
    }
  };

  try {
    const cfg = normalizeConfig(config);
    if (!cfg.enabled) {
      return { ok: true, skipped: true, reason: REASONS.DISABLED, pollSeq: null, events, audit };
    }

    // --- estado -------------------------------------------------------------
    let state;
    try {
      const raw = typeof d.readState === 'function'
        ? d.readState()
        : defaultReadState(d.pipelineRoot, d.fsImpl);
      const sane = sanitizeState(raw);
      if (!sane.ok) {
        // Estado corrupto: se arranca de cero y se audita. NUNCA se emite sobre
        // un estado que no se pudo validar.
        record(buildAuditRecord({ now: now(), decision: 'noop', reason: REASONS.STATE_CORRUPT }));
        state = emptyState();
      } else {
        state = sane.state;
      }
    } catch (e) {
      if (e && e.code === REASONS.PATH_ESCAPE) throw e;
      record(buildAuditRecord({
        now: now(), decision: 'noop', reason: REASONS.STATE_CORRUPT, detail: e && e.message,
      }));
      state = emptyState();
    }

    const pollSeq = state.pollSeq + 1;
    state.pollSeq = pollSeq;

    // --- ola activa ---------------------------------------------------------
    let wave = null;
    try {
      wave = typeof d.getActiveWave === 'function'
        ? d.getActiveWave()
        : require('./waves').getActiveWave();
    } catch (e) {
      wave = null;
    }
    const waveIssues = new Set();
    if (wave && Array.isArray(wave.issues)) {
      waveNumber = Number.isInteger(wave.number) ? wave.number : null;
      for (const it of wave.issues) {
        const n = it && Number(it.number);
        if (Number.isInteger(n) && n > 0) waveIssues.add(n);
      }
    }
    if (waveIssues.size === 0) {
      record(buildAuditRecord({ now: now(), wave: waveNumber, decision: 'noop', reason: REASONS.NO_ACTIVE_WAVE }));
      // Igual persistimos el pollSeq: es un poll real que ocurrió.
      persistState(d, state);
      return { ok: true, pollSeq, reason: REASONS.NO_ACTIVE_WAVE, events, audit, auditWriteErrors };
    }

    // --- barrido barato: `pr list` (ceba el cálculo diferido de GitHub) ------
    const fetchCandidates = typeof d.fetchCandidates === 'function'
      ? d.fetchCandidates
      : (o) => fetchOpenPrCandidatesAsync(o);
    const listed = await fetchCandidates({
      repo: cfg.repo,
      limit: cfg.candidateLimit,
      timeoutMs: cfg.ghTimeoutMs,
    });
    if (!listed || listed.ok !== true) {
      const reason = (listed && listed.reason) || REASONS.SCHEMA_INVALID;
      record(buildAuditRecord({ now: now(), wave: waveNumber, decision: 'noop', reason }));
      persistState(d, state);
      return { ok: false, pollSeq, reason, events, audit, auditWriteErrors };
    }

    const candidates = Array.isArray(listed.candidates) ? listed.candidates : [];
    for (const bad of (Array.isArray(listed.invalid) ? listed.invalid : [])) {
      record(buildAuditRecord({
        now: now(), wave: waveNumber, pr: bad, decision: 'noop', reason: REASONS.SCHEMA_INVALID,
      }));
    }

    // --- filtro del universo (CA-1) ------------------------------------------
    const screened = [];
    for (const pr of candidates) {
      const verdict = screenCandidate(pr, cfg, waveIssues);
      if (!verdict.ok) {
        record(buildAuditRecord({
          now: now(),
          wave: waveNumber,
          repo: cfg.repo,
          pr: pr && pr.number,
          headRefOid: pr && pr.headRefOid,
          decision: 'noop',
          reason: verdict.reason,
        }));
        continue;
      }
      screened.push({ pr, issue: verdict.issue });
    }

    // --- ambigüedad: exactamente 1 PR abierto por issue ----------------------
    const porIssue = new Map();
    for (const s of screened) {
      if (!porIssue.has(s.issue)) porIssue.set(s.issue, []);
      porIssue.get(s.issue).push(s);
    }
    const unicos = [];
    for (const [issue, grupo] of porIssue) {
      if (grupo.length !== 1) {
        for (const s of grupo) {
          record(buildAuditRecord({
            now: now(),
            wave: waveNumber,
            repo: cfg.repo,
            pr: s.pr.number,
            issue,
            headRefOid: s.pr.headRefOid,
            decision: 'noop',
            reason: REASONS.AMBIGUOUS_ASSOCIATION,
          }));
        }
        continue;
      }
      unicos.push(grupo[0]);
    }

    // --- confirmación: `pr view` SÓLO sobre los sospechosos ------------------
    const fetchPrDetail = typeof d.fetchPrDetail === 'function'
      ? d.fetchPrDetail
      : (n, o) => fetchPrMergeabilityAsync(n, o);
    const vistos = new Set();

    for (const { pr, issue } of unicos) {
      const key = stateKey(cfg.repo, pr.number);
      vistos.add(key);

      let detalle = pr;
      // Si el `list` ya lo muestra sano no hace falta gastar un `pr view`: la
      // observación sana sólo resetea la secuencia.
      if (!isHealthy(pr.mergeable, pr.mergeStateStatus)) {
        const view = await fetchPrDetail(pr.number, { repo: cfg.repo, timeoutMs: cfg.ghTimeoutMs });
        if (!view || view.ok !== true) {
          record(buildAuditRecord({
            now: now(),
            wave: waveNumber,
            repo: cfg.repo,
            pr: pr.number,
            issue,
            headRefOid: pr.headRefOid,
            decision: 'noop',
            reason: (view && view.reason) || REASONS.SCHEMA_INVALID,
          }));
          continue;
        }
        // El detalle es más fresco que el list: puede traer otro HEAD o haberse
        // cerrado en el medio. Se re-filtra con el mismo criterio.
        const reverdict = screenCandidate(view.pr, cfg, waveIssues);
        if (!reverdict.ok || reverdict.issue !== issue) {
          record(buildAuditRecord({
            now: now(),
            wave: waveNumber,
            repo: cfg.repo,
            pr: pr.number,
            issue,
            headRefOid: view.pr && view.pr.headRefOid,
            decision: 'noop',
            reason: reverdict.ok ? REASONS.AMBIGUOUS_ASSOCIATION : reverdict.reason,
          }));
          continue;
        }
        detalle = view.pr;
      }

      const ts = now();
      const decision = decideMergeability({
        prevEntry: state.entries[key] || null,
        observation: {
          repo: cfg.repo,
          pr: detalle.number,
          issue,
          headRefOid: detalle.headRefOid,
          mergeable: detalle.mergeable,
          mergeStateStatus: detalle.mergeStateStatus,
        },
        pollSeq,
        now: ts,
        minPollIntervalMs: cfg.minPollIntervalMs,
      });

      if (decision.nextEntry) state.entries[key] = decision.nextEntry;

      const rec = buildAuditRecord({
        now: ts,
        wave: waveNumber,
        repo: cfg.repo,
        pr: detalle.number,
        issue,
        headRefOid: detalle.headRefOid,
        decision: decision.action,
        reason: decision.reason,
        observations: decision.nextEntry ? decision.nextEntry.observations : [],
      });

      if (decision.action === 'emit') {
        const event = buildMergeConflictEvent({
          repo: cfg.repo,
          pr: detalle.number,
          issue,
          headRefOid: detalle.headRefOid,
          detectedAt: ts,
        });
        events.push(event);
        rec.event = event;
      }
      record(rec);
    }

    // --- poda ---------------------------------------------------------------
    // Por ausencia: sólo si la lista NO vino truncada por `--limit`; si vino
    // llena no podemos distinguir "cerrado" de "quedó afuera de la página".
    const listaCompleta = candidates.length < cfg.candidateLimit;
    const ahora = now();
    for (const key of Object.keys(state.entries)) {
      if (vistos.has(key)) continue;
      const e = state.entries[key];
      const vencio = !Number.isFinite(e.lastSeenAt) || (ahora - e.lastSeenAt) > cfg.stateEntryTtlMs;
      if (listaCompleta || vencio) delete state.entries[key];
    }

    persistState(d, state);

    return {
      ok: true,
      pollSeq,
      wave: waveNumber,
      events,
      audit,
      ...(auditWriteErrors.length > 0 ? { auditWriteErrors } : {}),
    };
  } catch (e) {
    // CA-7 — jamás propaga. El Pulpo sigue barriendo aunque el watcher explote.
    return {
      ok: false,
      reason: (e && e.code) || REASONS.INTERNAL_ERROR,
      message: _redact(e && e.message),
      events,
      audit,
      ...(auditWriteErrors.length > 0 ? { auditWriteErrors } : {}),
    };
  }
}

// Persistencia del estado. Un fallo acá SÍ importa (perderíamos idempotencia),
// así que se propaga al catch global de `runWatcherPoll` → `{ok:false}`.
function persistState(d, state) {
  if (typeof d.writeState === 'function') d.writeState(state);
  else defaultWriteState(d.pipelineRoot, state, d.fsImpl);
}

module.exports = {
  // Capa pura
  decideMergeability,
  screenCandidate,
  normalizeConfig,
  sanitizeState,
  sanitizeEntry,
  buildMergeConflictEvent,
  buildAuditRecord,
  isConflict,
  isHealthy,
  stateKey,

  // Adaptador
  runWatcherPoll,

  // Rutas + guardas
  resolveContained,
  statePath,
  eventsPath,
  assertNotSymlink,

  // Constantes
  REASONS,
  EVENT_SOURCE,
  EVENT_FIELDS,
  STATE_VERSION,
  AGENT_BRANCH_RE,
  DEFAULT_MIN_POLL_INTERVAL_MS,
  DEFAULT_CANDIDATE_LIMIT,
};
