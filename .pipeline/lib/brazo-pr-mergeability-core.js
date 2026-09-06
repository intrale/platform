// =============================================================================
// brazo-pr-mergeability-core.js — Núcleo del brazo del watcher de PRs (#4968)
// =============================================================================
//
// QUÉ RESUELVE
// ------------
// #4966 sabe OBSERVAR (`runWatcherPoll`) y #4967 sabe ACTUAR
// (`rewindFromMergeConflict`). Ninguno de los dos corre solo: falta el brazo
// que los engancha al tick del Pulpo. Este módulo es ese brazo, menos el
// cascarón: acá vive TODA la decisión (normalización de config, guard de
// re-entrada, watchdog de wedge, scheduling con backoff, orquestación
// observación -> revalidación -> rewind, aislamiento de errores) y en `pulpo.js`
// queda un wrapper delgado que sólo aporta los efectos propios del proceso
// (`ghDesbloqueoCall`, `taskkill`, `log`).
//
// POR QUÉ ACÁ Y NO EN `pulpo.js` (H-A1 del architect)
// ---------------------------------------------------
// `pulpo.js` tiene ~27.000 líneas y no exporta nada salvo bajo
// `PULPO_NO_AUTOSTART=1`. El molde vigente del guard (`_unblockRunning`,
// `_unblockStartedAt`, `_unblockActivePid`) es estado global de módulo con
// `Date.now()` hardcodeado: replicarlo dejaría el CA-3 INVERIFICABLE (no hay
// forma de simular "tick colgado más allá del TTL" ni "dos ticks concurrentes"
// sin reloj inyectable). Acá el guard es un objeto con `now` inyectado.
//
// POR QUÉ LA CONFIG NO VA A `config-schema.js` (H-A2)
// ---------------------------------------------------
// `config-schema.js` es estricto en las claves de control de flujo: un valor
// fuera de rango sería `ConfigSchemaViolation` => halt del Pulpo, exactamente lo
// contrario de lo que pide el CA-1 ("el brazo queda deshabilitado y el Pulpo NO
// se cae"). Por eso `normalizeWatcherConfig` es una función PURA de este módulo
// con fail-closed local y códigos de motivo tipados.
//
// POR QUÉ NO SPAWNEAMOS `gh` PROPIO (H-A3)
// ----------------------------------------
// El runner del Pulpo (`_ghCallWithTimeout` -> `ghDesbloqueoCall`) ya aporta
// timeout con `taskkill`, registro del pid activo, args sanitizados en el log y
// el circuit breaker `_ghBreaker` (#4612). Un `gh` propio quedaría fuera del
// breaker y sus procesos colgados serían invisibles para el watchdog: el modo
// de falla de #3059 volvería intacto. El runner entra por `deps.ghCall` y este
// módulo lo adapta al contrato `asyncRunner` de `pr-info-fetcher`.
//
// LO QUE ESTE MÓDULO **NO** HACE
// ------------------------------
//   - No escribe carpetas ni archivos de estado del pipeline. TODA mutación
//     pasa por `rewindFromMergeConflict` (CA-4 / requisito 4 de security). Un
//     `fs.renameSync` sobre `pendiente/`/`trabajando/` acá sería un defecto.
//   - No cierra, no mergea y no rebasa PRs (CA-5). Sólo observa y reencola.
//   - No reimplementa la dedupe `{repo, pr, headRefOid}`: es de #4966/#4967. Dos
//     fuentes de verdad romperían CA-4 en el reinicio del Pulpo.
//   - No renombra ni ensancha los clamps de #4966 (`expected_repo`,
//     `expected_base`, `poll_interval_minutes`, `gh_timeout_ms`,
//     `candidate_limit`, `min_poll_interval_ms`, `state_entry_ttl_hours` son su
//     contrato, cubierto por sus propios tests). Sólo AGREGA las claves de
//     wiring y, donde corresponde, aplica un piso MÁS conservador.
//
// Ver: docs/pipeline/pr-mergeability-watcher.md - "Operación en el Pulpo"
// =============================================================================

'use strict';

const fs = require('node:fs');

const watcher = require('./pr-mergeability-watcher');
const prInfo = require('./pr-info-fetcher');

// -----------------------------------------------------------------------------
// Constantes y clamps duros (H-A2)
// -----------------------------------------------------------------------------

// Códigos de motivo. Son ENUMS internos: lo único que se loguea o audita cuando
// la config está mal. NUNCA se emite el valor crudo del YAML (SEC-2).
const REASONS = Object.freeze({
  MISSING_SECTION: 'missing_section',
  DISABLED: 'disabled',
  KILL_SWITCH: 'kill_switch',
  REPO_INVALID: 'repo_invalid',
  REPO_NOT_ALLOWED: 'repo_not_allowed',
  BASE_INVALID: 'base_invalid',
  OWNER_INVALID: 'owner_invalid',
  INTERVAL_INVALID: 'interval_invalid',
  TIMEOUT_INVALID: 'timeout_invalid',
  CONCURRENCY_INVALID: 'concurrency_invalid',
  BACKOFF_INVALID: 'backoff_invalid',
  WEDGE_INVALID: 'wedge_invalid',
  ALLOWLIST_INVALID: 'allowlist_invalid',
  // Último cinturón: la sección trajo algo que ni siquiera se puede leer
  // (getters que lanzan, proxies hostiles). Fail-closed, nunca propaga.
  CONFIG_UNREADABLE: 'config_unreadable',
});

// Motivos que son estado de rollout esperado, no configuración rota: no
// merecen un `[WARN]` en el log del Pulpo cada tick.
const SILENT_REASONS = Object.freeze([REASONS.MISSING_SECTION, REASONS.DISABLED, REASONS.KILL_SWITCH]);

// Decisiones del brazo que se auditan (esquema cerrado, CA-6).
const DECISIONS = Object.freeze({
  NOOP: 'noop',
  REWOUND: 'rewound',
  REWIND_BLOCKED: 'rewind_blocked',
  POLL_FAILED: 'poll_failed',
  TICK_FAILED: 'tick_failed',
});

// Motivos de no-op del tick (enums, no texto libre).
const TICK_REASONS = Object.freeze({
  NO_ACTIVE_WAVE: 'no_active_wave',
  NO_EVENTS: 'no_events',
  INTERNAL_ERROR: 'internal_error',
});

// Estado del guard que se audita.
const GUARD_STATES = Object.freeze({
  ENTERED: 'entered',
  SKIPPED: 'skipped',
  WEDGE_RESET: 'wedge_reset',
});

// Repo por default y allowlist mínima. El watcher sólo puede observar (y por lo
// tanto sólo puede terminar mutando issues de) un repo explícitamente permitido:
// un `expected_repo` editado a mano hacia otro repo es `repo_not_allowed`, no un
// default silencioso (OWASP A01).
const DEFAULT_ALLOWED_REPOS = Object.freeze(['intrale/platform']);

const REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const BASE_RE = /^[A-Za-z0-9._/-]{1,100}$/;
const OWNER_RE = /^[A-Za-z0-9-]{1,39}$/;

// Piso del intervalo del brazo: 5 minutos. Es MÁS conservador que el clamp de
// #4966 (`poll_interval_minutes` en [1, 1440]) a propósito — el watcher gasta la
// misma cuota `gh` que `brazoDesbloqueo`/`brazoIntake` (#4982) y el conflicto de
// un PR no es urgente al minuto. No ensancha nada: sólo sube el piso.
const MIN_POLL_INTERVAL_MS = 5 * 60 * 1000;
const MAX_POLL_INTERVAL_MS = 60 * 60 * 1000;

const CONCURRENCY_MIN = 1;
const CONCURRENCY_MAX = 5;
const DEFAULT_CONCURRENCY = 2;

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;
const DEFAULT_BACKOFF_BASE_MS = 60_000;
const DEFAULT_BACKOFF_MAX_MS = 900_000;

const WEDGE_MIN_MS = 60_000;
const WEDGE_MAX_MS = 60 * 60 * 1000;
const DEFAULT_WEDGE_TIMEOUT_MS = 600_000;

// Cota de rewinds por tick. `max_concurrency` limita las LECTURAS de GitHub, no
// las mutaciones: dos rewinds en paralelo competirían por locks de issue sin
// ganancia. El recorrido es secuencial y acotado para que un poll anómalo no
// convierta un tick en una tormenta de transiciones.
const MAX_REWINDS_PER_TICK = 3;

// -----------------------------------------------------------------------------
// Helpers puros
// -----------------------------------------------------------------------------

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Lee un entero de config con semántica fail-closed + clamp.
 *
 *   - ausente/undefined/null       -> `{ ok: true, value: fallback }`
 *   - no numérico / no entero / <=0 -> `{ ok: false }`  (config rota => fail-closed)
 *   - fuera de [min,max]           -> `{ ok: true, value: clamp }` (siempre hacia
 *                                     el lado conservador)
 */
function readInt(raw, { min, max, fallback }) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: fallback };
  let n;
  // `Number(x)` invoca `valueOf`/`toString` del objeto: un YAML que trajo algo
  // raro no puede hacer lanzar a una función declarada como pura.
  try { n = Number(raw); } catch { return { ok: false }; }
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return { ok: false };
  return { ok: true, value: Math.min(Math.max(n, min), max) };
}

/**
 * Normaliza la sección `pr_mergeability_watcher` para el BRAZO.
 *
 * Fail-closed y PURA: nunca lanza, nunca lee `fs`, nunca toca `Date`. Devuelve
 * `{ok:false, reason}` con un código tipado o `{ok:true, cfg}`.
 *
 * `cfg.raw` es la sección original: es lo que se le pasa a `runWatcherPoll`,
 * que aplica su propio `normalizeConfig` (#4966). Este módulo NO reimplementa
 * esos clamps ni renombra sus claves.
 */
function normalizeWatcherConfig(raw) {
  // "Nunca lanza" no puede depender de que el YAML se porte bien: la sección es
  // un objeto arbitrario y cualquier acceso a una propiedad puede ejecutar
  // código ajeno (getters, proxies). El cinturón de afuera lo garantiza.
  try {
    return _normalizeWatcherConfig(raw);
  } catch {
    return { ok: false, reason: REASONS.CONFIG_UNREADABLE };
  }
}

function _normalizeWatcherConfig(raw) {
  if (!isPlainObject(raw)) return { ok: false, reason: REASONS.MISSING_SECTION };
  // Fail-closed estricto: sólo el booleano `true` enciende (mismo criterio que
  // #4966). `'true'`, `1` y `'yes'` NO encienden.
  if (raw.enabled !== true) return { ok: false, reason: REASONS.DISABLED };
  // Corte en caliente, molde `wave_auto_transition`: pisa a `enabled`.
  if (raw.kill_switch === true) return { ok: false, reason: REASONS.KILL_SWITCH };

  // --- allowlist de repos ----------------------------------------------------
  let allowed = DEFAULT_ALLOWED_REPOS.slice();
  if (raw.allowed_repos !== undefined) {
    if (!Array.isArray(raw.allowed_repos) || raw.allowed_repos.length === 0) {
      return { ok: false, reason: REASONS.ALLOWLIST_INVALID };
    }
    if (!raw.allowed_repos.every(r => typeof r === 'string' && REPO_RE.test(r))) {
      return { ok: false, reason: REASONS.ALLOWLIST_INVALID };
    }
    allowed = raw.allowed_repos.slice();
  }

  // --- repo / base / owner: formato Y allowlist (A01/A03) --------------------
  // Ausente => default de #4966. Presente y mal formado => fail-closed: degradar
  // al default un repo escrito a mano significaría observar (y potencialmente
  // reencolar issues de) un repo distinto del declarado.
  let repo = allowed[0];
  if (raw.expected_repo !== undefined) {
    if (typeof raw.expected_repo !== 'string' || !REPO_RE.test(raw.expected_repo)) {
      return { ok: false, reason: REASONS.REPO_INVALID };
    }
    repo = raw.expected_repo;
  }
  if (!allowed.includes(repo)) return { ok: false, reason: REASONS.REPO_NOT_ALLOWED };

  let base = 'main';
  if (raw.expected_base !== undefined) {
    if (typeof raw.expected_base !== 'string' || !BASE_RE.test(raw.expected_base)) {
      return { ok: false, reason: REASONS.BASE_INVALID };
    }
    base = raw.expected_base;
  }

  let owner = repo.split('/')[0];
  if (raw.expected_owner !== undefined) {
    if (typeof raw.expected_owner !== 'string' || !OWNER_RE.test(raw.expected_owner)) {
      return { ok: false, reason: REASONS.OWNER_INVALID };
    }
    owner = raw.expected_owner;
  }
  // El owner declarado tiene que ser el del repo observado: si no, un PR del
  // repo esperado quedaría filtrado como `fork_or_cross_repo` para siempre.
  if (owner.toLowerCase() !== repo.split('/')[0].toLowerCase()) {
    return { ok: false, reason: REASONS.OWNER_INVALID };
  }

  // --- intervalo del brazo ---------------------------------------------------
  // La clave real es `poll_interval_minutes` (contrato de #4966). El brazo la
  // lee y le aplica su propio piso de 5 min, más conservador.
  const iv = readInt(raw.poll_interval_minutes, { min: 1, max: 1_440, fallback: 10 });
  if (!iv.ok) return { ok: false, reason: REASONS.INTERVAL_INVALID };
  const pollIntervalMs = Math.min(
    Math.max(iv.value * 60_000, MIN_POLL_INTERVAL_MS),
    MAX_POLL_INTERVAL_MS,
  );

  // --- timeout por llamada ---------------------------------------------------
  // Dueño previo: #4966 (`gh_timeout_ms`, clamp [1000, 60000]). El brazo lo LEE
  // para dimensionar el wedge; no lo redefine ni le ensancha el rango.
  const to = readInt(raw.gh_timeout_ms, { min: 1_000, max: 60_000, fallback: 5_000 });
  if (!to.ok) return { ok: false, reason: REASONS.TIMEOUT_INVALID };
  const ghTimeoutMs = to.value;

  // --- concurrencia de lecturas ---------------------------------------------
  const cc = readInt(raw.max_concurrency, {
    min: CONCURRENCY_MIN, max: CONCURRENCY_MAX, fallback: DEFAULT_CONCURRENCY,
  });
  if (!cc.ok) return { ok: false, reason: REASONS.CONCURRENCY_INVALID };
  const maxConcurrency = cc.value;

  // --- backoff ---------------------------------------------------------------
  const bb = readInt(raw.backoff_base_ms, {
    min: BACKOFF_MIN_MS, max: BACKOFF_MAX_MS, fallback: DEFAULT_BACKOFF_BASE_MS,
  });
  if (!bb.ok) return { ok: false, reason: REASONS.BACKOFF_INVALID };
  const bm = readInt(raw.backoff_max_ms, {
    min: BACKOFF_MIN_MS, max: BACKOFF_MAX_MS, fallback: DEFAULT_BACKOFF_MAX_MS,
  });
  if (!bm.ok) return { ok: false, reason: REASONS.BACKOFF_INVALID };
  // `base <= max` es invariante, no preferencia: si el YAML los cruza, el techo
  // se sube al base (conservador: nunca reintenta más seguido de lo declarado).
  const backoffBaseMs = bb.value;
  const backoffMaxMs = Math.max(bm.value, backoffBaseMs);

  // --- watchdog de wedge -----------------------------------------------------
  const wd = readInt(raw.wedge_timeout_ms, {
    min: WEDGE_MIN_MS, max: WEDGE_MAX_MS, fallback: DEFAULT_WEDGE_TIMEOUT_MS,
  });
  if (!wd.ok) return { ok: false, reason: REASONS.WEDGE_INVALID };
  // Invariante de H-A2: el wedge nunca puede ser menor que lo que legítimamente
  // puede tardar un tick (`gh_timeout_ms x max_concurrency`), o el watchdog
  // mataría ticks sanos.
  const wedgeTimeoutMs = Math.min(
    Math.max(wd.value, ghTimeoutMs * maxConcurrency),
    WEDGE_MAX_MS,
  );

  return {
    ok: true,
    cfg: {
      repo,
      base,
      owner,
      pollIntervalMs,
      ghTimeoutMs,
      maxConcurrency,
      backoffBaseMs,
      backoffMaxMs,
      wedgeTimeoutMs,
      // Sección cruda: es lo que consume `runWatcherPoll`, que aplica su propio
      // `normalizeConfig`. Congelada para que nadie la mute aguas abajo.
      raw: Object.freeze({ ...raw }),
    },
  };
}

// -----------------------------------------------------------------------------
// Guard de re-entrada + watchdog de wedge (H-A1 / CA-3)
// -----------------------------------------------------------------------------

/**
 * Guard anti-reentrada con watchdog, con reloj INYECTADO.
 *
 * Molde: `_checkAndResetUnblockWedge()` de `pulpo.js` (#3059), pero como objeto
 * en vez de variables sueltas de módulo — que es lo que vuelve verificable el
 * CA-3 ("tick colgado más allá del TTL").
 *
 * `wedgeTimeoutMs` puede llegar como número o como función: la config se
 * normaliza recién dentro del tick, así que el wrapper de `pulpo.js` construye
 * el guard una vez y le pasa un getter perezoso.
 */
function createReentryGuard({ wedgeTimeoutMs, now = () => Date.now(), onWedge = () => {} } = {}) {
  let running = false;
  let startedAt = 0;
  let activePid = null;

  const ttl = () => {
    let v;
    try { v = typeof wedgeTimeoutMs === 'function' ? wedgeTimeoutMs() : wedgeTimeoutMs; }
    catch { v = null; }
    const n = Number(v);
    // Fail-closed hacia el default: un TTL roto no puede desactivar el watchdog.
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_WEDGE_TIMEOUT_MS;
    return Math.min(Math.max(n, WEDGE_MIN_MS), WEDGE_MAX_MS);
  };

  return {
    /**
     * Corre ANTES del guard, igual que `brazoDesbloqueo` (`pulpo.js:23250`).
     * Devuelve `null` si no hay wedge, o `{wedgeMs, killedPid}` si lo destrabó.
     */
    checkWedge() {
      if (!running || startedAt === 0) return null;
      const wedgeMs = now() - startedAt;
      // Un reloj que retrocede (NTP / suspensión) no puede fabricar un wedge.
      if (!Number.isFinite(wedgeMs) || wedgeMs <= ttl()) return null;
      const killed = activePid;
      running = false;
      startedAt = 0;
      activePid = null;
      // El efecto (taskkill + reset del scheduler) lo aporta el wrapper. Un
      // `onWedge` que explote no puede dejar el guard tomado: por eso el reset
      // del estado va ANTES y la llamada va en try/catch.
      try { onWedge({ wedgeMs, pid: killed }); } catch { /* best-effort */ }
      return { wedgeMs, killedPid: killed };
    },
    tryEnter() {
      if (running) return false;
      running = true;
      startedAt = now();
      activePid = null;
      return true;
    },
    /** SIEMPRE en `finally`, también con excepción (CA-3). Idempotente. */
    release() {
      running = false;
      startedAt = 0;
      activePid = null;
    },
    setActivePid(pid) {
      activePid = Number.isInteger(pid) && pid > 0 ? pid : null;
    },
    getActivePid: () => activePid,
    isRunning: () => running,
    getStartedAt: () => startedAt,
  };
}

// -----------------------------------------------------------------------------
// Scheduler: intervalo + backoff con jitter (CA-1)
// -----------------------------------------------------------------------------

/**
 * Decide CUÁNDO corre el tick. Reloj y RNG inyectados => el backoff es
 * verificable sin esperar tiempo real.
 *
 * Backoff exponencial con jitter sobre fallos CONSECUTIVOS de GitHub; un tick
 * exitoso lo resetea. Nunca reintenta más seguido que `pollIntervalMs`.
 */
function createScheduler({ now = () => Date.now(), random = Math.random } = {}) {
  let lastTickAt = 0;
  let failures = 0;
  let nextEarliestAt = 0;

  return {
    shouldRun(cfg) {
      const t = now();
      if (t - lastTickAt < cfg.pollIntervalMs) return { run: false, reason: 'interval' };
      if (nextEarliestAt > 0 && t < nextEarliestAt) return { run: false, reason: 'backoff' };
      lastTickAt = t;
      return { run: true };
    },
    recordSuccess() {
      failures = 0;
      nextEarliestAt = 0;
    },
    recordFailure(cfg) {
      failures += 1;
      const exp = Math.min(
        cfg.backoffBaseMs * Math.pow(2, Math.max(0, failures - 1)),
        cfg.backoffMaxMs,
      );
      // Jitter en [50%, 100%] del delay: desincroniza reintentos sin volverlos
      // más agresivos que el piso configurado.
      const r = Number(random());
      const jitter = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 1;
      const delay = Math.round(exp * (0.5 + 0.5 * jitter));
      nextEarliestAt = now() + delay;
      return { failures, delay };
    },
    /**
     * Reset del wedge: el brazo arranca en el PRÓXIMO tick, sin esperar el
     * intervalo completo (lección explícita de #3059).
     */
    reset() {
      lastTickAt = 0;
      nextEarliestAt = 0;
    },
    state: () => ({ lastTickAt, failures, nextEarliestAt }),
  };
}

// -----------------------------------------------------------------------------
// Semáforo de concurrencia de lecturas (CA-1)
// -----------------------------------------------------------------------------

/**
 * Limita las llamadas a `gh` EN VUELO desde este brazo. Aplica a las LECTURAS:
 * las mutaciones (rewind) son secuenciales por diseño.
 */
function createSemaphore(limit) {
  const max = Number.isInteger(limit) && limit > 0 ? limit : 1;
  let inFlight = 0;
  let peak = 0;
  const cola = [];

  const liberar = () => {
    inFlight -= 1;
    const siguiente = cola.shift();
    if (siguiente) siguiente();
  };

  return {
    async run(fn) {
      if (inFlight >= max) await new Promise(resolve => cola.push(resolve));
      inFlight += 1;
      if (inFlight > peak) peak = inFlight;
      try {
        return await fn();
      } finally {
        liberar();
      }
    },
    peak: () => peak,
    inFlight: () => inFlight,
    limit: max,
  };
}

// -----------------------------------------------------------------------------
// Auditoría del brazo (CA-6) — esquema CERRADO, append-only
// -----------------------------------------------------------------------------

const AUDIT_FIELDS = Object.freeze(['ts', 'kind', 'repo', 'pr', 'issue', 'decision', 'reason_code', 'guard']);

// Vocabulario CERRADO de `reason_code`. Un charset permisivo no alcanza: un
// token de GitHub (`ghp_` + 36 alfanuméricos) pasaría un filtro de "letras,
// números y guión bajo" sin despeinarse. Las tres fuentes legítimas son los
// enums de este módulo, los de #4966 y los códigos del rewind de #4967.
const KNOWN_REASON_CODES = Object.freeze(new Set([
  ...Object.values(REASONS),
  ...Object.values(TICK_REASONS),
  ...Object.values(watcher.REASONS),
  'REWIND_THREW',
  'REWIND_FAILED',
]));

// Los `code` de #4967 no están exportados como enum, pero son SCREAMING_SNAKE
// por convención del módulo (`PR_SHA_CHANGED`, `DEDUPE_HIT`, `LOCK_FAILED`...).
// Aceptar esa FORMA —sin minúsculas, sin puntos, sin espacios, acotada— deja
// entrar códigos nuevos del rewind sin tener que espejar su lista acá, y sigue
// dejando afuera tokens, JWTs, URLs y mensajes remotos.
const REWIND_CODE_RE = /^[A-Z][A-Z0-9_]{2,39}$/;

/** ¿Es un código interno legítimo? Deny-by-default. */
function isKnownReasonCode(v) {
  if (typeof v !== 'string' || v.length === 0 || v.length > 40) return false;
  return KNOWN_REASON_CODES.has(v) || REWIND_CODE_RE.test(v);
}

/**
 * Construye el registro de decisión DEL BRAZO. Esquema cerrado: sólo enums,
 * enteros y el repo ya validado contra allowlist. Nada remoto — ni títulos, ni
 * mensajes de `gh`, ni stack traces — puede entrar por acá (CA-6 / requisito 7
 * de security).
 *
 * El JSONL de OBSERVACIÓN lo sigue escribiendo #4966 con su propio esquema;
 * esto suma la capa "qué decidió el brazo", distinguible por `kind:'brazo'`.
 */
function buildBrazoAuditRecord({ now, repo, pr, issue, decision, reasonCode, guard } = {}) {
  const intOrNull = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const enumOrNull = (v, allowed) => (typeof v === 'string' && allowed.includes(v) ? v : null);
  return {
    ts: Number.isFinite(Number(now)) ? Number(now) : 0,
    kind: 'brazo',
    repo: typeof repo === 'string' && REPO_RE.test(repo) ? repo : null,
    pr: intOrNull(pr),
    issue: intOrNull(issue),
    decision: enumOrNull(decision, Object.values(DECISIONS)) || DECISIONS.NOOP,
    // Vocabulario cerrado y deny-by-default: lo que no es un código interno
    // conocido (o no tiene la forma de un código del rewind) se descarta. Un
    // mensaje remoto, un token o una URL con credenciales no pueden entrar.
    reason_code: isKnownReasonCode(reasonCode) ? reasonCode : null,
    guard: enumOrNull(guard, Object.values(GUARD_STATES)),
  };
}

/**
 * Writer por default: MISMO archivo y MISMO modo append que #4966
 * (`.pipeline/audit/pr-mergeability-events.jsonl`), reusando su resolución de
 * path y su guarda anti-symlink. Nunca `writeFileSync`: el archivo es
 * append-only.
 */
function defaultAppendBrazoAudit(pipelineRoot, record, fsImpl) {
  const _fs = fsImpl || fs;
  const file = watcher.eventsPath(pipelineRoot);
  watcher.assertNotSymlink(file, _fs);
  _fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}

// -----------------------------------------------------------------------------
// Adaptadores de I/O — el runner endurecido del Pulpo (H-A3)
// -----------------------------------------------------------------------------

/**
 * Adapta `deps.ghCall(args, timeoutMs) => Promise<{stdout, stderr}>` (contrato
 * del Pulpo, que RECHAZA en error) al `asyncRunner(bin, args, {timeoutMs}) =>
 * Promise<{status, stdout, stderr}>` que espera `pr-info-fetcher._runGhAsync`
 * (contrato tipo-spawnSync, que nunca rechaza).
 *
 * Traduce los códigos del runner a la forma que `_classifyGhFailure` sabe leer,
 * para que un timeout salga como `gh_timeout` y no como `spawn_error` genérico.
 */
function makeAsyncRunner({ ghCall, semaphore, onChildSpawn }) {
  const sem = semaphore || createSemaphore(1);
  return (bin, args, opts) => sem.run(async () => {
    try {
      const res = await ghCall(args, opts && opts.timeoutMs, onChildSpawn);
      return { status: 0, stdout: (res && res.stdout) || '', stderr: (res && res.stderr) || '' };
    } catch (e) {
      const code = e && e.code;
      if (code === 'GH_CALL_TIMEOUT') {
        return {
          status: null,
          error: Object.assign(new Error('gh-call-timeout'), { code: 'ETIMEDOUT' }),
          signal: 'SIGTERM',
        };
      }
      // Breaker abierto (#4612) o cualquier otro fallo: error TIPADO, sin
      // mensaje remoto (el `_redact` de #4966 lo trunca igual aguas abajo).
      return {
        status: null,
        error: Object.assign(new Error(String(code || 'gh_call_failed')), { code: code || 'GH_CALL_FAILED' }),
      };
    }
  });
}

/**
 * `revalidatePr` para #4967: vuelve a pedir el PR a GitHub y lo devuelve con el
 * shape que `revalidateMergeConflictPr` exige
 * (`{repo, number, state, baseRefName, headRefOid, headRefName, mergeable}`).
 *
 * Es una SEGUNDA lectura deliberada, dentro del lock del issue: es la que
 * detecta el TOCTOU (PR cerrado, SHA cambiado, conflicto resuelto) entre la
 * observación de #4966 y la mutación.
 */
function makeRevalidatePr({ cfg, asyncRunner, fetchPrDetail }) {
  const fetch = typeof fetchPrDetail === 'function'
    ? fetchPrDetail
    : (n, o) => prInfo.fetchPrMergeabilityAsync(n, o);
  return async ({ repo, pr }) => {
    const res = await fetch(pr, { repo, timeoutMs: cfg.ghTimeoutMs, asyncRunner });
    if (!res || res.ok !== true || !res.pr) return null; // => PR_REVALIDATION_FAILED
    return { repo, ...res.pr };
  };
}

// -----------------------------------------------------------------------------
// El tick
// -----------------------------------------------------------------------------

/**
 * Un tick del brazo: observar (#4966) -> revalidar -> rewind canónico (#4967).
 *
 * NUNCA lanza (CA-2): cualquier fallo sale como `{ok:false, reason}` y el tick
 * del Pulpo completa igual. No muta nada del filesystem del pipeline por su
 * cuenta: la única mutación posible pasa por `rewindFromMergeConflict`.
 *
 * @param {object} cfg Config YA normalizada por `normalizeWatcherConfig`.
 * @param {object} deps
 * @param {Function} deps.ghCall `(args, timeoutMs, onSpawn) => Promise<{stdout,stderr}>`
 * @param {Function} deps.getActiveWave `() => {number, issues:[{number}]}|null`
 * @param {string}   deps.pipelineRoot Path absoluto a `.pipeline/`.
 * @param {object}   deps.config Config del pipeline YA RESUELTO (skills_por_fase).
 * @param {Function} [deps.now] [deps.log] [deps.onChildSpawn]
 * @param {Function} [deps.runWatcherPoll] [deps.rewindFromMergeConflict]
 * @param {Function} [deps.fetchCandidates] [deps.fetchPrDetail]
 * @param {Function} [deps.appendAudit] `(record) => void`
 * @returns {Promise<object>} `{ok, observed, rewound, blocked, reason?}`
 */
async function runTick(cfg, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const rewound = [];
  const blocked = [];

  const appendAudit = typeof deps.appendAudit === 'function'
    ? deps.appendAudit
    : (rec) => defaultAppendBrazoAudit(deps.pipelineRoot, rec, deps.fsImpl);
  // La auditoría es best-effort: un JSONL que no se puede escribir no puede
  // impedir un rewind legítimo ni tumbar el tick.
  const audit = (rec) => {
    try { appendAudit(buildBrazoAuditRecord({ now: now(), ...rec })); }
    catch { /* best-effort */ }
  };

  try {
    // --- ola activa: universo observado (limitación declarada, CA-9) ---------
    let wave = null;
    try { wave = deps.getActiveWave && deps.getActiveWave(); } catch { wave = null; }
    if (!wave || !Array.isArray(wave.issues) || wave.issues.length === 0) {
      audit({ decision: DECISIONS.NOOP, reasonCode: TICK_REASONS.NO_ACTIVE_WAVE });
      return { ok: true, skipped: TICK_REASONS.NO_ACTIVE_WAVE, observed: 0, rewound, blocked };
    }

    // --- I/O endurecido: un solo semáforo para todas las lecturas del tick ---
    const semaphore = createSemaphore(cfg.maxConcurrency);
    const asyncRunner = makeAsyncRunner({
      ghCall: deps.ghCall,
      semaphore,
      onChildSpawn: deps.onChildSpawn,
    });

    const poll = typeof deps.runWatcherPoll === 'function'
      ? deps.runWatcherPoll
      : watcher.runWatcherPoll;

    // --- observación (#4966) -------------------------------------------------
    const res = await poll({
      config: cfg.raw,
      deps: {
        pipelineRoot: deps.pipelineRoot,
        getActiveWave: () => wave,
        now,
        fetchCandidates: typeof deps.fetchCandidates === 'function'
          ? deps.fetchCandidates
          : (o) => prInfo.fetchOpenPrCandidatesAsync({ ...o, asyncRunner }),
        fetchPrDetail: typeof deps.fetchPrDetail === 'function'
          ? deps.fetchPrDetail
          : (n, o) => prInfo.fetchPrMergeabilityAsync(n, { ...o, asyncRunner }),
      },
    });

    if (!res || res.ok !== true) {
      const reason = (res && res.reason) || TICK_REASONS.INTERNAL_ERROR;
      audit({ repo: cfg.repo, decision: DECISIONS.POLL_FAILED, reasonCode: reason });
      log(`[WARN] poll sin resultado (${reason}) — no bloqueante`);
      return { ok: false, reason, observed: 0, rewound, blocked, peakConcurrency: semaphore.peak() };
    }

    const eventos = Array.isArray(res.events) ? res.events : [];
    if (eventos.length === 0) {
      return {
        ok: true, skipped: TICK_REASONS.NO_EVENTS, observed: 0, rewound, blocked,
        peakConcurrency: semaphore.peak(),
      };
    }

    // --- acción: rewind canónico (#4967), SECUENCIAL ------------------------
    const rewind = typeof deps.rewindFromMergeConflict === 'function'
      ? deps.rewindFromMergeConflict
      : require('./pipeline-rewind').rewindFromMergeConflict;

    const revalidatePr = makeRevalidatePr({ cfg, asyncRunner, fetchPrDetail: deps.fetchPrDetail });

    for (const ev of eventos.slice(0, MAX_REWINDS_PER_TICK)) {
      let r;
      try {
        r = await rewind(ev, {
          config: deps.config,
          pipelineRoot: deps.pipelineRoot,
          revalidatePr,
          yaml: deps.yaml,
          fsImpl: deps.fsImpl,
          processCtrl: deps.processCtrl,
          activeProcesses: deps.activeProcesses,
          options: { now, revalidateTimeoutMs: cfg.ghTimeoutMs * 3 },
        });
      } catch (e) {
        // El rewind promete no lanzar, pero el aislamiento no se delega: un
        // evento que explota no puede llevarse los siguientes ni el tick.
        blocked.push({ issue: ev.issue, pr: ev.pr, code: 'REWIND_THREW' });
        audit({
          repo: ev.repo, pr: ev.pr, issue: ev.issue,
          decision: DECISIONS.REWIND_BLOCKED, reasonCode: 'REWIND_THREW',
        });
        log(`[WARN] rewind de #${ev.issue} lanzó excepción (no bloqueante): ${e && e.message}`);
        continue;
      }

      if (r && r.ok) {
        rewound.push({ issue: ev.issue, pr: ev.pr });
        audit({
          repo: ev.repo, pr: ev.pr, issue: ev.issue,
          decision: DECISIONS.REWOUND, reasonCode: 'confirmed_conflict',
        });
      } else {
        const code = (r && r.code) || 'REWIND_FAILED';
        blocked.push({ issue: ev.issue, pr: ev.pr, code });
        audit({
          repo: ev.repo, pr: ev.pr, issue: ev.issue,
          decision: DECISIONS.REWIND_BLOCKED, reasonCode: code,
        });
      }
    }

    return {
      ok: true, observed: eventos.length, rewound, blocked,
      peakConcurrency: semaphore.peak(),
    };
  } catch (e) {
    // Último cinturón (CA-2). Ni el motivo remoto ni el stack salen de acá.
    audit({ decision: DECISIONS.TICK_FAILED, reasonCode: TICK_REASONS.INTERNAL_ERROR });
    log(`[WARN] tick falló (no bloqueante): ${e && e.message}`);
    return { ok: false, reason: TICK_REASONS.INTERNAL_ERROR, observed: 0, rewound, blocked };
  }
}

module.exports = {
  // Config (pura)
  normalizeWatcherConfig,
  // Estado del brazo (reloj inyectado)
  createReentryGuard,
  createScheduler,
  createSemaphore,
  // Orquestación
  runTick,
  // Auditoría
  buildBrazoAuditRecord,
  defaultAppendBrazoAudit,
  // Adaptadores de I/O
  makeAsyncRunner,
  makeRevalidatePr,
  // Constantes
  REASONS,
  SILENT_REASONS,
  KNOWN_REASON_CODES,
  isKnownReasonCode,
  DECISIONS,
  TICK_REASONS,
  GUARD_STATES,
  AUDIT_FIELDS,
  DEFAULT_ALLOWED_REPOS,
  MIN_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
  DEFAULT_WEDGE_TIMEOUT_MS,
  MAX_REWINDS_PER_TICK,
};
