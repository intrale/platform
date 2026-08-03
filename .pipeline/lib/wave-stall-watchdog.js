// =============================================================================
// wave-stall-watchdog.js — Dead-man's switch de la ola (#4708)
//
// Por qué este módulo existe
// --------------------------
// El 2026-07-14 la Ola Puente quedó con trabajo abierto/habilitado y 0 agentes
// despachando durante un largo rato sin que saltara ninguna alarma. No existía
// un dead-man's switch que dijera "esta ola lleva N minutos sin mover una ficha
// y sin causa declarada". Combinado con el corte silencioso del circuit breaker,
// el sistema se quedó ciego (incidente raíz #4700).
//
// Este módulo aporta la lógica de decisión PURA (`decide(facts)`) modelada 1:1
// sobre `watchdog-supervisor.js::decide` (fail-closed, cap/cooldown/dedup por
// ventana, parse de umbral con clamp). El brazo del Pulpo (pulpo.js) recolecta
// los hechos del filesystem y llama `decide`; ante `alert`/`escalate` dispara
// Telegram + estado de ola `stalled` + escalada `needs-human`.
//
// Defensas de seguridad incorporadas (de la fase de criterios, #4708):
//   SEC-1  Integridad de la 'causa declarada' (fail-closed): causa ausente,
//          ilegible, corrupta o EXPIRADA => tratar como *sin causa* => disparar.
//          Nunca asumir "hay causa, callar".
//   SEC-2  El mensaje sólo lleva waveKey + motivo. Prohibido paths absolutos,
//          tokens o dumps de estado (validado por buildAlertMessage + test).
//   SEC-3  stall_minutes desde config validada: 0, negativo, no-numérico o
//          gigante => default seguro. NUNCA "nunca stall" ni deshabilitar de
//          facto (clamp con MAX_STALL_MINUTES).
//   SEC-4  Anti-flooding: dedup por ventana (lastAlertTs por ola) — una alerta
//          + escalado por episodio, cooldown entre re-alertas. Un episodio nuevo
//          (la ola movió ficha y volvió a estancarse) SÍ re-alerta.
//
// Cero dependencias npm. `decide` es una función PURA: NO lee del filesystem
// (las señales entran como `facts`), y devuelve el `nextState` a persistir.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_STALL_MINUTES = 20;
// Cota superior de seguridad (SEC-3): un N gigante equivaldría a "nunca stall".
// 1440 min = 24h. Un umbral mayor a esto se trata como inválido → default.
const MAX_STALL_MINUTES = 1440;
const DEFAULT_COOLDOWN_MINUTES = 30;
const DEFAULT_WINDOW_MINUTES = 60;

// #5400 — Antigüedad a partir de la cual una causa declarada DEJA de silenciar
// la alarma. Es el corazón del issue: el 2026-08-02 una pausa preservada por un
// restart calló al watchdog 1h33 porque `isCauseValid` cortaba incondicionalmente.
// Una causa declarada explica un rato de no-despacho; no lo explica para siempre.
// Deliberadamente MAYOR que stall_minutes: primero se agota el margen normal.
const DEFAULT_DECLARED_CAUSE_ESCALATE_MINUTES = 45;

// #5400 — Nombres legibles de la causa para el mensaje (CA-2: "el aviso nombra
// la causa concreta, no un mensaje genérico"). Las claves son los `kind` que
// emite `readDeclaredCauseForWave` en pulpo.js.
const CAUSE_LABELS = Object.freeze({
  'human-halt': 'pausa total declarada por el operador',
  'partial-pause': 'pausa parcial / allowlist acotada',
  'wave-empty': 'allowlist vacía (desync fail-closed, sin ola vigente)',
  'night-window': 'ventana de reposo',
  'priority-window': 'ventana de prioridad ocupando el turno',
  'concurrency-limit': 'límite de concurrencia (todos los slots ocupados)',
  quota: 'cuota de proveedor agotada',
  'resource-pressure': 'presión de recursos',
  'waiting-operator': 'ola retenida esperando al operador',
  cooldown: 'cooldown entre lanzamientos',
  'blocked-dependencies': 'issues bloqueados por dependencia',
  deadlock: 'deadlock del gate predictivo',
  'cb-infra': 'circuit breaker de infraestructura abierto',
  declared: 'causa declarada sin clasificar',
});

/**
 * Nombre legible de un `kind` de causa. Un kind desconocido se devuelve tal
 * cual (acotado y sin metacaracteres de Markdown) en vez de un genérico: es
 * preferible un slug crudo a "causa desconocida" cuando hay que diagnosticar.
 */
function describeCause(kind) {
  if (kind == null) return 'sin causa declarada';
  const k = String(kind);
  if (CAUSE_LABELS[k]) return CAUSE_LABELS[k];
  return k.replace(/[^A-Za-z0-9_.:\- ]/g, '').slice(0, 48) || 'sin causa declarada';
}

/**
 * Duración legible en español, determinística y sin dependencias.
 * Se usa para "hace N sin despachar" y para la duración total de la detención.
 */
function formatDurationEs(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  if (total < 60) return `${total} s`;
  const mins = Math.floor(total / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h} h ${m} min` : `${h} h`;
}

/**
 * Valida el umbral de estancamiento en minutos (SEC-3).
 * Debe ser entero en [1, MAX_STALL_MINUTES]. Un valor no numérico / 0 /
 * negativo / absurdamente grande NO debe degradar el chequeo a "nunca stall":
 * cae al default seguro.
 *
 * @param {*} raw            valor crudo (string de env o number de config)
 * @param {number} fallback  default si raw es inválido
 * @returns {number} entero positivo acotado
 */
function parseStallMinutes(raw, fallback = DEFAULT_STALL_MINUTES) {
  const safeFallback =
    Number.isInteger(fallback) && fallback >= 1 && fallback <= MAX_STALL_MINUTES
      ? fallback
      : DEFAULT_STALL_MINUTES;
  const inRange = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_STALL_MINUTES;
  if (typeof raw === 'number') {
    return inRange(raw) ? raw : safeFallback;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^[0-9]+$/.test(trimmed)) {
      const n = parseInt(trimmed, 10);
      if (inRange(n)) return n;
    }
  }
  return safeFallback;
}

/**
 * Valida un entero positivo genérico (cooldown, window).
 */
function parsePositiveInt(raw, fallback) {
  const safeFallback = Number.isInteger(fallback) && fallback >= 1 ? fallback : 1;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) return raw;
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw.trim())) {
    const n = parseInt(raw.trim(), 10);
    if (n >= 1) return n;
  }
  return safeFallback;
}

// #5400 — `causeKind` / `causeSinceTs` son ADITIVOS. Un archivo de estado escrito
// por la versión #4708 (sin esos campos) carga igual: `normalizeState` los
// completa con su default y el primer tick los estampa. No hay migración que
// hacer ni versión que bumpear — el schema sólo crece con campos opcionales.
const DEFAULT_STATE = Object.freeze({
  lastMovementTs: 0,
  lastSignature: null,
  lastAlertTs: 0,
  alertCount: 0,
  causeKind: null,
  causeSinceTs: 0,
});

/**
 * Normaliza el estado persistido del watchdog. Tolerante: campos ausentes o de
 * tipo inválido caen a su default. NO propaga basura al resto de la lógica.
 */
function normalizeState(obj) {
  const out = {
    lastMovementTs: 0,
    lastSignature: null,
    lastAlertTs: 0,
    alertCount: 0,
    causeKind: null,
    causeSinceTs: 0,
  };
  if (!obj || typeof obj !== 'object') return out;
  if (Number.isFinite(obj.lastMovementTs) && obj.lastMovementTs > 0) {
    out.lastMovementTs = obj.lastMovementTs;
  }
  if (typeof obj.lastSignature === 'string') {
    out.lastSignature = obj.lastSignature;
  }
  if (Number.isFinite(obj.lastAlertTs) && obj.lastAlertTs > 0) {
    out.lastAlertTs = obj.lastAlertTs;
  }
  if (Number.isInteger(obj.alertCount) && obj.alertCount >= 0) {
    out.alertCount = obj.alertCount;
  }
  // #5400 — reloj propio de la causa declarada (para la escalada por antigüedad).
  if (typeof obj.causeKind === 'string' && obj.causeKind.length > 0) {
    out.causeKind = obj.causeKind;
  }
  if (Number.isFinite(obj.causeSinceTs) && obj.causeSinceTs > 0) {
    out.causeSinceTs = obj.causeSinceTs;
  }
  return out;
}

/**
 * Carga el estado del watchdog. Fail-soft: archivo ausente o corrupto =>
 * estado vacío (NO bloquea la vigilancia).
 */
function loadState(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeState(parsed);
  } catch (_) {
    return { ...DEFAULT_STATE };
  }
}

/**
 * Escritura atómica del estado (tmp + rename).
 */
function saveStateAtomic(file, state) {
  const tmp = `${file}.tmp`;
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    /* fail-soft */
  }
  fs.writeFileSync(tmp, JSON.stringify(normalizeState(state), null, 2));
  fs.renameSync(tmp, file);
}

/**
 * ¿La causa declarada es válida para suprimir la alarma? (SEC-1, fail-closed).
 *
 * Una causa sólo suprime la alarma si:
 *   - existe (no null / no undefined),
 *   - es legible (readable !== false: corrupta/ilegible => NO suprime),
 *   - está declarada (declared === true),
 *   - NO está expirada (si trae expiresAt finito, now <= expiresAt).
 *
 * Ante CUALQUIER ambigüedad (ausente, ilegible, expirada) => NO válida => la
 * alarma se dispara. Nunca "hay causa, callar".
 *
 * @param {object|null} cause  { declared, kind?, expiresAt?, readable? }
 * @param {number} now         timestamp actual (ms)
 * @returns {boolean}
 */
function isCauseValid(cause, now) {
  if (!cause || typeof cause !== 'object') return false;     // ausente
  if (cause.readable === false) return false;                // corrupta/ilegible
  if (cause.declared !== true) return false;                 // sin causa real
  // Expiración (anti "causa zombi"): si trae expiresAt finito y ya venció → inválida.
  if (cause.expiresAt != null) {
    const exp = Number(cause.expiresAt);
    if (!Number.isFinite(exp)) return false;                 // expiración ilegible → fail-closed
    if (Number.isFinite(now) && now > exp) return false;     // expirada
  }
  return true;
}

/**
 * Firma de movimiento de la ola: combina el conteo de despacho (`trabajando/`
 * de todas las fases) con el último `avancePct`. La ola "movió una ficha" si
 * cambia CUALQUIERA de los dos (definición del PO, CA). Evita el falso
 * estancamiento por trabajo intra-fase (agente trabajando sin promover ficha).
 */
function movementSignature(dispatching, progressSeries, lastDispatchTs) {
  const d = Number.isFinite(dispatching) ? dispatching : 0;
  let avance = 'na';
  if (Array.isArray(progressSeries) && progressSeries.length > 0) {
    const last = progressSeries[progressSeries.length - 1];
    if (last && Number.isFinite(last.avancePct)) avance = String(last.avancePct);
  }
  // #5400 — la estampa de despacho efectivo es la señal PRIMARIA de movimiento.
  // Se agrega como TERCER segmento y sólo cuando existe, para no romper la firma
  // legacy de dos segmentos (#4708) en instalaciones que todavía no la estampan.
  if (Number.isFinite(lastDispatchTs) && lastDispatchTs > 0) {
    return `${d}:${avance}:${lastDispatchTs}`;
  }
  return `${d}:${avance}`;
}

/**
 * Construye el mensaje de alerta (SEC-2 / CA-5 / guidelines UX).
 * SÓLO waveKey + motivo + contexto operativo mínimo. Prohibido paths absolutos,
 * tokens, secrets o dumps de estado. Determinístico y testeable.
 *
 * @param {{waveKey:*, stallMinutes:number, enabledCount:number}} p
 * @returns {string}
 */
function buildAlertMessage(p) {
  const o = p || {};
  const mins = Number.isFinite(o.stallMinutes) ? o.stallMinutes : DEFAULT_STALL_MINUTES;
  const enabled = Number.isInteger(o.enabledCount) && o.enabledCount >= 0 ? o.enabledCount : 0;

  // #5400 — sin ola activa el watchdog igual vigila: el alcance es el PIPELINE.
  // Con ola, se conserva el encabezado histórico "Ola N estancada" (#4708).
  const conOla = o.waveKey != null;
  const sujeto = conOla ? `Ola ${String(o.waveKey)} estancada` : 'Pipeline sin despachar';

  // Duración real si el caller la conoce; si no, el umbral configurado.
  const duracion = Number.isFinite(o.stalledMs) && o.stalledMs > 0
    ? formatDurationEs(o.stalledMs)
    : `${mins} min`;

  // CA-2 — nombrar la causa concreta.
  const causa = describeCause(o.causeKind != null ? o.causeKind : null);

  // SEC-2 — la autoría es SIEMPRE "declarada" (dato display-only, no verificado:
  // el gate de autorización corre en GRACE MODE y `getPipelineMode()` devuelve
  // `source: null` para la pausa total). Sin dato NO se atribuye a nadie:
  // inventar un responsable es peor que admitir que no consta.
  const autorRaw = o.authorDeclared != null ? String(o.authorDeclared).trim() : '';
  const autoria = autorRaw.length > 0
    ? `autoría declarada: ${autorRaw.replace(/[^A-Za-z0-9_.@:\- ]/g, '').slice(0, 48)}`
    : 'autoría no registrada';

  return (
    `${sujeto} — 0 despacho hace ${duracion}. ` +
    `Causa: ${causa} (${autoria}). ` +
    `${enabled} issue(s) habilitado(s) esperando; marcado needs_attention.`
  );
}

/**
 * Mensaje de RECUPERACIÓN (CA-5): el despacho se reanudó tras un episodio que ya
 * había alertado. Lleva la duración TOTAL de la detención — el dato que el
 * operador necesita para dimensionar el impacto sin ir a buscar logs.
 *
 * @param {{waveKey:*, outageMs:number}} p
 * @returns {string}
 */
function buildRecoveryMessage(p) {
  const o = p || {};
  const sujeto = o.waveKey != null ? `Ola ${String(o.waveKey)}` : 'Pipeline';
  return (
    `${sujeto}: despacho reanudado. ` +
    `La detención duró ${formatDurationEs(o.outageMs)}.`
  );
}

/**
 * Decide qué hacer dada la foto de la ola. Función PURA: no lee FS, no muta el
 * input; devuelve la decisión y el `nextState` a persistir por el caller.
 *
 * @param {object} facts
 * @param {number} facts.now                  timestamp actual (ms)
 * @param {*}      facts.waveKey              identificador de la ola activa
 * @param {number} facts.enabledCount         # issues habilitados (no completados, sin bloqueo)
 * @param {number} facts.dispatching          # archivos en trabajando/ de todas las fases
 * @param {Array}  [facts.progressSeries]     serie {ts, waveKey, avancePct} de wave-progress
 * @param {object|null} [facts.cause]         causa declarada normalizada (ver isCauseValid)
 * @param {object} [facts.state]              estado persistido del watchdog
 * @param {*}      [facts.stallMinutes]
 * @param {*}      [facts.cooldownMinutes]
 * @param {*}      [facts.windowMinutes]
 * @returns {{action:'skip'|'alert'|'escalate', reason:string, level:'info'|'warn'|'error',
 *            stalledMs:number, message:string|null, waveKey:*, enabledCount:number,
 *            stallMinutes:number, nextState:object}}
 */
function decide(facts) {
  const stallMinutes = parseStallMinutes(facts.stallMinutes, DEFAULT_STALL_MINUTES);
  const cooldownMinutes = parsePositiveInt(facts.cooldownMinutes, DEFAULT_COOLDOWN_MINUTES);
  // #5400 — mismo parser (y por lo tanto el mismo clamp [1,1440] de SEC-3/SEC-4)
  // que `stall_minutes`: un umbral 0/negativo/gigante NO puede desactivar de
  // facto la escalada. Cae al default seguro.
  const escalateMinutes = parseStallMinutes(
    facts.declaredCauseEscalateMinutes,
    DEFAULT_DECLARED_CAUSE_ESCALATE_MINUTES
  );
  parsePositiveInt(facts.windowMinutes, DEFAULT_WINDOW_MINUTES); // validado (reservado para poda futura)

  const now = Number.isFinite(facts.now) ? facts.now : 0;
  const stallMs = stallMinutes * 60 * 1000;
  const cooldownMs = cooldownMinutes * 60 * 1000;
  const escalateMs = escalateMinutes * 60 * 1000;

  const state = normalizeState(facts.state);
  const enabledCount = Number.isInteger(facts.enabledCount) && facts.enabledCount > 0 ? facts.enabledCount : 0;
  const dispatching = Number.isInteger(facts.dispatching) && facts.dispatching > 0 ? facts.dispatching : 0;

  // #5400 — Estampa del último despacho EFECTIVO (`state/last-dispatch.json`).
  // Una estampa en el futuro (reloj corrido / clock skew) se acota a `now`: si no,
  // bastaría un timestamp adelantado para silenciar el watchdog indefinidamente.
  const rawLd = Number.isFinite(facts.lastDispatchTs) && facts.lastDispatchTs > 0
    ? facts.lastDispatchTs
    : null;
  const lastDispatchTs = rawLd == null ? null : (now > 0 ? Math.min(rawLd, now) : rawLd);

  // --- 1. Detección de "ficha movida" -----------------------------------
  // CON estampa: movió ficha === salió un agente nuevo. Es la señal honesta.
  //   Ojo: NO se puede usar la firma acá, porque la firma incluye el conteo de
  //   `trabajando/` y ese conteo baja solo a medida que los agentes terminan —
  //   interpretarlo como movimiento reiniciaría el reloj y emitiría una
  //   "recuperación" falsa sin que se haya despachado nada.
  // SIN estampa: se conserva la proxy legacy de #4708 (conteo + avancePct).
  const signature = movementSignature(dispatching, facts.progressSeries, lastDispatchTs);
  const signatureChanged = state.lastSignature == null || state.lastSignature !== signature;
  const movedFicha = lastDispatchTs != null
    ? state.lastMovementTs !== lastDispatchTs
    : signatureChanged;

  const nextState = { ...state, lastSignature: signature };

  // --- 1b. Reloj propio de la causa declarada ---------------------------
  // La causa arranca a contar cuando APARECE o CAMBIA de tipo. Esto le da al
  // watchdog una antigüedad propia y confiable incluso cuando la fuente no
  // registra `createdAt` (es el caso de la pausa TOTAL: `getPipelineMode()`
  // devuelve `createdAt: null`, que es justamente el caso del incidente).
  const causeValida = isCauseValid(facts.cause, now);
  const causeKind = causeValida
    ? ((facts.cause && facts.cause.kind) ? String(facts.cause.kind) : 'declared')
    : null;
  const causeChanged = causeKind !== state.causeKind;
  const causeSinceTs = causeKind == null
    ? 0
    : ((causeChanged || !(state.causeSinceTs > 0)) ? now : state.causeSinceTs);
  nextState.causeKind = causeKind;
  nextState.causeSinceTs = causeSinceTs;

  // --- 1c. Recuperación del despacho (CA-5) -----------------------------
  // Sólo si el episodio anterior LLEGÓ A ALERTAR: reanudar tras un silencio que
  // nadie notificó no es una "recuperación" que valga un mensaje.
  const recovering = movedFicha && state.alertCount > 0 && state.lastMovementTs > 0;
  const recovery = recovering
    ? (() => {
      // Duración total = desde el último despacho previo hasta el que reanuda.
      const fin = lastDispatchTs != null ? lastDispatchTs : now;
      const outageMs = Math.max(0, fin - state.lastMovementTs);
      return {
        outageMs,
        alertCount: state.alertCount,
        message: buildRecoveryMessage({ waveKey: facts.waveKey, outageMs }),
      };
    })()
    : null;

  if (lastDispatchTs != null) {
    nextState.lastMovementTs = lastDispatchTs;
  } else if (movedFicha) {
    nextState.lastMovementTs = now;
  }
  if (movedFicha) {
    nextState.lastAlertTs = 0;
    nextState.alertCount = 0;
  }
  const lastMovementTs = nextState.lastMovementTs > 0 ? nextState.lastMovementTs : now;

  const base = (action, reason, level) => ({
    action,
    reason,
    level,
    stalledMs: Math.max(0, now - lastMovementTs),
    message: null,
    waveKey: facts.waveKey != null ? facts.waveKey : null,
    enabledCount,
    stallMinutes,
    nextState,
    // #5400 — contexto para el brazo y el dashboard.
    causeKind,
    causeSinceTs,
    lastDispatchTs,
    recovery,
  });

  // --- 2. Sin trabajo habilitado => nada que vigilar (CA-3) -------------
  // Una cola legítimamente vacía NO alerta. Criterio ya acordado: la ociosidad
  // sólo se avisa por recursos o deadlock humano.
  if (enabledCount <= 0) return base('skip', 'no-enabled-work', 'info');

  // --- 3. Hay despacho actual -------------------------------------------
  // SIN estampa el conteo de `trabajando/` es la única proxy disponible → se
  // mantiene el skip legacy (#4708). CON estampa deja de ser un skip: un agente
  // clavado mantiene el conteo en 1 y congelaba la vigilancia para siempre (G-3).
  if (dispatching > 0 && lastDispatchTs == null) return base('skip', 'dispatching', 'info');

  // --- 4. ¿Cuánto lleva sin despachar? ----------------------------------
  const stalledMs = Math.max(0, now - lastMovementTs);
  if (stalledMs < stallMs) return base('skip', 'within-threshold', 'info');

  // --- 5. Causa declarada vigente (CA-2 / SEC-1) ------------------------
  // Fail-closed: causa ausente/ilegible/expirada NO es válida => seguimos.
  // #5400 — la novedad es el RELOJ: una causa declarada silencia mientras es
  // reciente, pero pasada `escalateMinutes` con trabajo elegible esperando deja
  // de ser una explicación y pasa a ser el problema. La escalada es
  // ESTRICTAMENTE ADITIVA (umbral alto Y elegibles > 0): por debajo del umbral
  // el comportamiento es idéntico al de #4708/#4751 — modo ola sigue mudo.
  let reason = 'unexplained-stall';
  if (causeValida) {
    // `sinceTs` explícito del caller (ej. `created_at` de la pausa parcial) gana:
    // sobrevive a un restart del Pulpo. Si no viene, el reloj propio del watchdog.
    const causeAgeMs = Number.isFinite(facts.cause.sinceTs) && facts.cause.sinceTs > 0
      ? Math.max(0, now - facts.cause.sinceTs)
      : Math.max(0, now - causeSinceTs);
    if (!(causeAgeMs >= escalateMs && enabledCount > 0)) {
      return base('skip', `declared-cause:${causeKind}`, 'info');
    }
    reason = `stale-declared-cause:${causeKind}`;
  }

  // --- 6. Anti-flooding: dedup por cooldown dentro del episodio (SEC-4) -
  if (state.lastAlertTs > 0 && now - state.lastAlertTs < cooldownMs) {
    return base('skip', 'cooldown', 'info');
  }

  // --- 7. Estancamiento confirmado: disparar ----------------------------
  const prevAlerts = state.alertCount || 0;
  const action = prevAlerts === 0 ? 'alert' : 'escalate';
  nextState.lastAlertTs = now;
  nextState.alertCount = prevAlerts + 1;

  const decision = base(action, reason, action === 'alert' ? 'warn' : 'error');
  decision.stalledMs = stalledMs;
  decision.message = buildAlertMessage({
    waveKey: facts.waveKey,
    stallMinutes,
    enabledCount,
    stalledMs,
    causeKind,
    authorDeclared: facts.authorDeclared,
  });
  return decision;
}

module.exports = {
  decide,
  isCauseValid,
  buildAlertMessage,
  buildRecoveryMessage,
  describeCause,
  formatDurationEs,
  movementSignature,
  parseStallMinutes,
  parsePositiveInt,
  normalizeState,
  loadState,
  saveStateAtomic,
  CAUSE_LABELS,
  DEFAULT_STALL_MINUTES,
  MAX_STALL_MINUTES,
  DEFAULT_COOLDOWN_MINUTES,
  DEFAULT_WINDOW_MINUTES,
  DEFAULT_DECLARED_CAUSE_ESCALATE_MINUTES,
};
