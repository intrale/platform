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
const { writeJsonAtomic } = require('./atomic-json');

const DEFAULT_STALL_MINUTES = 20;
// Cota superior de seguridad (SEC-3): un N gigante equivaldría a "nunca stall".
// 1440 min = 24h. Un umbral mayor a esto se trata como inválido → default.
const MAX_STALL_MINUTES = 1440;
const DEFAULT_COOLDOWN_MINUTES = 30;

// #5400 (rev-7) — Período del brazo, en MILISEGUNDOS. Vive acá y no en
// `pulpo.js` para que el default y su validación no puedan divergir del helper
// que los aplica. OJO con la unidad: estas constantes son ms y NO deben
// mezclarse con `MAX_STALL_MINUTES` (minutos) — esa mezcla fue el bug de rev-6.
const DEFAULT_TICK_MS = 60 * 1000;        // 1 min
const MIN_TICK_MS = 1000;                 // 1 s: piso anti-saturación del event loop
const MAX_TICK_MS = 60 * 60 * 1000;       // 1 h: techo anti-"control apagado"
// rev-6 (S5) — `window_minutes` FUE ELIMINADA. Se parseaba, se exponía en la
// decisión y se inyectaba desde pulpo.js, pero NINGUNA decisión la leía: era
// superficie de configuración que prometía un control inexistente (el
// anti-flooding lo gobierna el backoff exponencial, no una ventana). Se sacó
// también la clave de `config.yaml`. Un config viejo que todavía la traiga se
// ignora sin error.

// #5400 (rev-3, CA-4) — Tope del backoff exponencial entre re-alertas del MISMO
// episodio. Con el cooldown default (30 min) el tope de 16 significa esperar
// hasta 8 h antes de repetir: una detención de 14 h cuesta ~6 mensajes en vez de
// los ~27 que producía el cooldown fijo de rev-2. No se apaga nunca — el aviso
// sigue llegando, sólo que espaciado.
const MAX_ALERT_BACKOFF_FACTOR = 16;

// #5400 — Inactividad de despacho a partir de la cual una causa declarada DEJA
// de silenciar la alarma. Es el corazón del issue: el 2026-08-02 una pausa
// preservada por un restart calló al watchdog 1h33 porque `isCauseValid` cortaba
// incondicionalmente. Una causa declarada explica un rato de no-despacho; no lo
// explica para siempre. Deliberadamente MAYOR que stall_minutes: primero se
// agota el margen normal.
//
// OJO (rev-1, B1): se mide contra la INACTIVIDAD DE DESPACHO (`now -
// lastMovementTs`), NUNCA contra la antigüedad de la causa. Medirlo contra la
// causa dejaba al watchdog mudo para siempre cuando las causas ALTERNAN — y
// alternan de verdad en operación (ventanas de prioridad autoexcluyentes,
// presión de recursos oscilando en los umbrales, cooldown entre lanzamientos).
// Con causas rotando cada 30 min el reloj de la causa se reiniciaba en cada
// transición y jamás alcanzaba el umbral, con 3 h sin despachar y 5 elegibles
// esperando. El `kind` de la causa ahora sólo sirve para NOMBRARLA en el aviso.
const DEFAULT_DECLARED_CAUSE_ESCALATE_MINUTES = 45;

// #5400 (rev-1, B4 + falso positivo de saturación) — Gracia extra mientras HAY
// agentes corriendo (`trabajando/` > 0). Antes `dispatching > 0` era un skip
// incondicional: un agente clavado congelaba la vigilancia para siempre (G-3).
// Ignorarlo por completo era el extremo opuesto: 3 agentes sanos ocupando los
// slots con causa `concurrency-limit` producían un aviso de "estancamiento" que
// no era tal. La gracia es el punto medio que pedía la receta del architect:
// atenuante, nunca skip. Con agentes en curso el pipeline tiene que estar MUCHO
// más tiempo sin despachar para que se lo declare detenido.
const DEFAULT_BUSY_GRACE_MINUTES = 60;

// #5400 (rev-1, B2) — Tolerancia de adelanto de la estampa. Escritor y lector
// son el mismo host, así que un adelanto real es clock skew (NTP, resume de VM),
// no granularidad. Por encima de esto la estampa se considera INVÁLIDA — antes
// se acotaba con `Math.min(rawLd, now)`, lo que fijaba `stalledMs = 0` en cada
// tick y apagaba el watchdog por horas: exactamente el silencio que decía evitar.
const FUTURE_STAMP_TOLERANCE_MS = 5000;

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
 * Valida un entero positivo expresado en MINUTOS (cooldown).
 *
 * #5400 (rev-5, secundario 7) — Con COTA SUPERIOR. Sin ella,
 * `alert_cooldown_minutes: 999999` apagaba el control por completo (reproducido:
 * 30 días sin despachar y 5 elegibles daba `skip cooldown`, mientras que con 30
 * daba `escalate`) — un control apagado indistinguible de "todo OK", que es el
 * meta-bug de este mismo issue. El backoff exponencial nuevo lo amplifica hasta
 * `MAX_ALERT_BACKOFF_FACTOR` (16x). Mismo criterio fail-closed y mismo tope que
 * `parseStallMinutes`: fuera de rango cae al default, jamás desactiva.
 *
 * #5400 (rev-7, BLOQUEANTE) — Se llamaba `parsePositiveInt`, un nombre SIN
 * UNIDAD, y por eso `pulpo.js` lo usó para parsear `tick_ms`, que está en
 * MILISEGUNDOS: `parsePositiveInt(60000, 60000)` caía fuera de [1, 1440] tanto
 * en el valor como en el fallback y devolvía `1`, con lo que el `setInterval`
 * del brazo pasaba de 60 s a 1 ms (log: "iniciado: cada 0s"). Como el cuerpo
 * del tick (relee y valida config.yaml, hace readdir de las colas y escribe 2
 * archivos de estado) tarda más que el intervalo, el callback se re-encolaba
 * sin pausa dentro del proceso del Pulpo. El nombre ahora dice la unidad para
 * que el choque no pueda repetirse en silencio; para milisegundos existe
 * `parseTickMs`.
 */
function parsePositiveMinutes(raw, fallback) {
  const inRange = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_STALL_MINUTES;
  const safeFallback = inRange(fallback) ? fallback : 1;
  if (typeof raw === 'number' && inRange(raw)) return raw;
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw.trim())) {
    const n = parseInt(raw.trim(), 10);
    if (inRange(n)) return n;
  }
  return safeFallback;
}

/**
 * Valida el período del brazo en MILISEGUNDOS (`wave_watchdog.tick_ms`).
 *
 * #5400 (rev-7, BLOQUEANTE) — Helper propio, con rango en la unidad correcta:
 * NO comparte el tope de `MAX_STALL_MINUTES`, que es de minutos y convertía
 * cualquier valor en ms legítimo en el mínimo absoluto.
 *
 * Mismo criterio fail-closed que el resto del módulo, pero acotado por ambos
 * lados y por motivos distintos:
 *  - Piso `MIN_TICK_MS` (1 s): por debajo de eso el tick no alcanza a terminar
 *    su propio cuerpo antes del siguiente disparo y ocupa el event loop del
 *    Pulpo de forma continua. Es exactamente el modo de falla de rev-6.
 *  - Techo `MAX_TICK_MS` (1 h): un período mayor deja el dead-man's switch de
 *    facto apagado — el control existiría pero no miraría, que es el meta-bug
 *    del issue.
 * Fuera de rango cae al default seguro; nunca desactiva ni satura.
 */
function parseTickMs(raw, fallback = DEFAULT_TICK_MS) {
  const inRange = (n) => Number.isInteger(n) && n >= MIN_TICK_MS && n <= MAX_TICK_MS;
  const safeFallback = inRange(fallback) ? fallback : DEFAULT_TICK_MS;
  if (typeof raw === 'number' && inRange(raw)) return raw;
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw.trim())) {
    const n = parseInt(raw.trim(), 10);
    if (inRange(n)) return n;
  }
  return safeFallback;
}

// #5400 — `lastStampTs` es ADITIVO. Un archivo de estado escrito por la versión
// #4708 (sin ese campo) carga igual: `normalizeState` lo completa con su default
// y el primer tick lo estampa. No hay migración que hacer ni versión que bumpear
// — el schema sólo crece con campos opcionales.
//
// rev-1 (B1): `causeKind` / `causeSinceTs` FUERON ELIMINADOS. Eran el reloj de
// la causa declarada, y medir la escalada contra ellos dejaba al watchdog mudo
// ante causas que alternan. Un estado viejo que todavía los traiga se carga sin
// error: `normalizeState` simplemente los descarta (no están en la allowlist).
//
// rev-6 (BLOQUEANTE rev-1): `lastDispatching` / `lastAvancePct` son ADITIVOS y
// existen por una sola razón — en modo `never` hay que distinguir un AUMENTO del
// conteo (despachó) de una BAJA (los agentes terminaron). La firma no alcanza:
// es igualdad de string y trata ambos como "movimiento". Ver el bloque 1b.
const DEFAULT_STATE = Object.freeze({
  lastMovementTs: 0,
  lastSignature: null,
  lastAlertTs: 0,
  alertCount: 0,
  lastStampTs: 0,
  lastDispatching: null,
  lastAvancePct: null,
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
    lastStampTs: 0,
    lastDispatching: null,
    lastAvancePct: null,
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
  // #5400 (rev-1, B3) — última estampa de despacho OBSERVADA. Es lo que permite
  // distinguir "nunca hubo estampa" (instalación legacy → proxy de #4708) de
  // "había estampa y desapareció" (archivo borrado/corrupto → NO es movimiento,
  // es degradación). Sin este campo, perder la estampa durante un episodio ya
  // alertado emitía un aviso de "despacho reanudado" sin que saliera un solo
  // agente, y encima reiniciaba el reloj de la detención.
  if (Number.isFinite(obj.lastStampTs) && obj.lastStampTs > 0) {
    out.lastStampTs = obj.lastStampTs;
  }
  // rev-6 — Últimos valores OBSERVADOS del conteo de despacho y del avance.
  // `null` = todavía no observado: en ese caso NO se puede afirmar que hubo un
  // aumento, así que el default es "no hubo movimiento" (fail-closed: el reloj
  // sigue corriendo). Un estado escrito por una versión anterior cae acá y se
  // comporta igual de conservador.
  if (Number.isInteger(obj.lastDispatching) && obj.lastDispatching >= 0) {
    out.lastDispatching = obj.lastDispatching;
  }
  if (Number.isFinite(obj.lastAvancePct)) {
    out.lastAvancePct = obj.lastAvancePct;
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
 * Escritura atómica del estado. Delega en el writer compartido
 * (`lib/atomic-json.js`) en vez de reimplementar `tmp + rename`.
 *
 * @returns {boolean} true si quedó persistido. El caller DEBE mirarlo: un
 *   estado que no se persiste hace que el watchdog re-alerte en cada tick.
 */
function saveStateAtomic(file, state) {
  return writeJsonAtomic(file, normalizeState(state), { indent: 2 });
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
function avanceActual(progressSeries) {
  if (!Array.isArray(progressSeries) || progressSeries.length === 0) return null;
  const last = progressSeries[progressSeries.length - 1];
  if (last && Number.isFinite(last.avancePct)) return last.avancePct;
  return null;
}

function movementSignature(dispatching, progressSeries, lastDispatchTs) {
  const d = Number.isFinite(dispatching) ? dispatching : 0;
  const pct = avanceActual(progressSeries);
  const avance = pct == null ? 'na' : String(pct);
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

  // #5400 (rev-1) — contexto honesto de saturación: si hay agentes corriendo, el
  // operador tiene que verlo en el aviso (cambia el diagnóstico por completo).
  const enCurso = Number.isInteger(o.dispatching) && o.dispatching > 0
    ? ` ${o.dispatching} agente(s) en curso;`
    : '';

  // #5400 (rev-1) — el cierre decía SIEMPRE "marcado needs_attention", pero la
  // marca de ola sólo se aplica si hay ola activa — justo el caso que este issue
  // habilitó (vigilancia sin ola). Prometer una acción que no ocurre es peor que
  // no prometer nada.
  const cierre = conOla
    ? 'marcado needs_attention.'
    : 'sin ola activa: este aviso ES la escalada.';

  // #5400 (rev-1, SEC-5) — si el reloj de despacho está degradado (estampa
  // ausente o corrida), se dice. Un aviso que no aclara con qué reloj mide
  // induce a discutir el número en vez del problema.
  const reloj = o.stampDegraded === true
    ? ' Reloj de despacho degradado (estampa ausente o inválida): la duración es la mínima conocida.'
    : '';

  // rev-6 (B4) — Con el alcance CIEGO no se puede afirmar cuántos issues están
  // habilitados: sin ola vigente ni allowlist no hay con qué acotar la cola. Se
  // dice lo único que consta (el tamaño crudo) y se nombra la ceguera, en vez de
  // reportar "0 esperando", que se lee como "no hay nada que hacer".
  const espera = o.scopeBlind === true
    ? `alcance de despacho no determinable (sin ola vigente): ${
      Number.isInteger(o.queuedTotal) && o.queuedTotal > 0 ? o.queuedTotal : 0
    } workfile(s) en cola sin poder acotarse;`
    : `${enabled} issue(s) habilitado(s) esperando;`;

  return (
    `${sujeto} — 0 despacho hace ${duracion}. ` +
    `Causa: ${causa} (${autoria}). ` +
    `${espera}${enCurso} ${cierre}${reloj}`
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
 * @param {boolean} [facts.scopeBlind]        true = no se pudo determinar qué es despachable (B4)
 * @param {number} [facts.queuedTotal]        # total crudo de workfiles en cola
 * @param {Array}  [facts.progressSeries]     serie {ts, waveKey, avancePct} de wave-progress
 * @param {object|null} [facts.cause]         causa declarada normalizada (ver isCauseValid)
 * @param {object} [facts.state]              estado persistido del watchdog
 * @param {number|null} [facts.lastDispatchTs]  estampa del último despacho efectivo
 * @param {*}      [facts.stallMinutes]
 * @param {*}      [facts.cooldownMinutes]
 * @param {*}      [facts.declaredCauseEscalateMinutes]
 * @param {*}      [facts.busyGraceMinutes]     gracia extra con agentes en curso
 * @returns {{action:'skip'|'alert'|'escalate', reason:string, level:'info'|'warn'|'error',
 *            stalledMs:number, message:string|null, waveKey:*, enabledCount:number,
 *            stallMinutes:number, nextState:object}}
 */
function decide(facts) {
  const stallMinutes = parseStallMinutes(facts.stallMinutes, DEFAULT_STALL_MINUTES);
  const cooldownMinutes = parsePositiveMinutes(facts.cooldownMinutes, DEFAULT_COOLDOWN_MINUTES);
  // #5400 — mismo parser (y por lo tanto el mismo clamp [1,1440] de SEC-3/SEC-4)
  // que `stall_minutes`: un umbral 0/negativo/gigante NO puede desactivar de
  // facto la escalada. Cae al default seguro.
  const escalateMinutes = parseStallMinutes(
    facts.declaredCauseEscalateMinutes,
    DEFAULT_DECLARED_CAUSE_ESCALATE_MINUTES
  );
  const busyGraceMinutes = parseStallMinutes(facts.busyGraceMinutes, DEFAULT_BUSY_GRACE_MINUTES);

  const now = Number.isFinite(facts.now) ? facts.now : 0;
  const cooldownMs = cooldownMinutes * 60 * 1000;

  const state = normalizeState(facts.state);
  const enabledCount = Number.isInteger(facts.enabledCount) && facts.enabledCount > 0 ? facts.enabledCount : 0;
  const dispatching = Number.isInteger(facts.dispatching) && facts.dispatching > 0 ? facts.dispatching : 0;
  // rev-6 (B4) — "No hay trabajo" y "no puedo VER el trabajo" son cosas
  // distintas y hasta acá colapsaban en el mismo skip mudo. Con el pipeline en
  // pausa total sin allowlist preservada y sin ola activa, el recolector sale por
  // `fail-closed-sin-ola` con `elegibles: 0` y el paso 2 salía por
  // `no-enabled-work`: silencio total con la cola llena y el despacho trabado.
  // CA-3 (cola vacía no alerta) se comía a CA-1 (avisar cuando no despacha).
  // Con el alcance CIEGO la vigilancia sigue: manda la causa declarada, que en
  // ese estado es `wave-empty` y por lo tanto calla el rato normal y después
  // escala. `queuedTotal` es lo único afirmable del tamaño de la cola.
  const scopeBlind = facts.scopeBlind === true;
  const queuedTotal = Number.isInteger(facts.queuedTotal) && facts.queuedTotal > 0
    ? facts.queuedTotal
    : 0;

  // #5400 (rev-1) — `dispatching` es ATENUANTE, no skip ni dato ignorado: con
  // agentes en curso el pipeline tolera mucho más tiempo sin despachar antes de
  // declararse detenido. Se suma a AMBOS umbrales para que la relación entre
  // ellos (primero el margen normal, después la escalada) se mantenga.
  const busyGraceMs = dispatching > 0 ? busyGraceMinutes * 60 * 1000 : 0;
  const stallMs = stallMinutes * 60 * 1000 + busyGraceMs;
  // rev-6 (S4) — Invariante `escalate >= stall` hecho EXPLÍCITO. Las dos claves
  // de config son independientes y nada impide `declared_cause_escalate_minutes`
  // menor que `stall_minutes` (con la config vigente, 20/45, se cumple por
  // casualidad).
  //
  // Honestidad sobre el alcance: hoy esto NO cambia ningún comportamiento
  // observable, porque el paso 3 ya corta con `stalledMs < stallMs` antes de que
  // se evalúe `escalateMs` — o sea que el invariante estaba garantizado de forma
  // IMPLÍCITA, por el orden de los pasos. Se escribe igual porque esa garantía
  // es frágil: cualquier refactor que mueva el chequeo de causa por encima del
  // umbral normal reabriría la regresión de #4751 en silencio. Verificado por
  // barrido de inactividad con escalate(5) < stall(30): idéntico con y sin
  // `Math.max`. Es una red, no un fix.
  const escalateMs = Math.max(escalateMinutes * 60 * 1000 + busyGraceMs, stallMs);

  // --- 1. Validez de la estampa de despacho efectivo --------------------
  // `state/last-dispatch.json`. Tres estados posibles, y distinguirlos es lo que
  // separa "sé que no despacha" de "no sé nada":
  //   ok      → estampa presente y creíble: es el reloj honesto.
  //   future  → adelantada más allá de la tolerancia (clock skew): INVÁLIDA.
  //             Acotarla a `now` (rev-0) fijaba stalledMs=0 en cada tick y
  //             apagaba el watchdog por horas — el bug B2.
  //   missing → ausente/corrupta. Si ANTES hubo estampa, es degradación (no
  //             movimiento). Si nunca hubo, es una instalación legacy y se cae
  //             a la proxy de #4708.
  const rawLd = Number.isFinite(facts.lastDispatchTs) && facts.lastDispatchTs > 0
    ? facts.lastDispatchTs
    : null;
  const stampFuture = rawLd != null && now > 0 && rawLd > now + FUTURE_STAMP_TOLERANCE_MS;
  const lastDispatchTs = (rawLd == null || stampFuture)
    ? null
    : (now > 0 ? Math.min(rawLd, now) : rawLd);
  const stampEverSeen = state.lastStampTs > 0;
  const stampState = stampFuture
    ? 'future'
    : (rawLd == null ? (stampEverSeen ? 'missing' : 'never') : 'ok');
  // "Degradado" = teníamos (o deberíamos tener) un reloj honesto y no lo tenemos.
  const stampDegraded = stampState === 'future' || stampState === 'missing';

  // --- 1b. Detección de "ficha movida" ----------------------------------
  // CON estampa: movió ficha === salió un agente nuevo. Es la señal honesta.
  //   Ojo: NO se puede usar la firma acá, porque la firma incluye el conteo de
  //   `trabajando/` y ese conteo baja solo a medida que los agentes terminan —
  //   interpretarlo como movimiento reiniciaría el reloj y emitiría una
  //   "recuperación" falsa sin que se haya despachado nada.
  // SIN estampa NUNCA vista: proxy legacy de #4708 (conteo + avancePct), pero
  //   SÓLO en la dirección que puede significar un despacho — ver abajo.
  // SIN estampa habiéndola visto antes (B3): NO hay movimiento. Perder el
  //   archivo no es despachar; el reloj sigue corriendo desde donde estaba.
  const signature = movementSignature(dispatching, facts.progressSeries, lastDispatchTs);
  const avancePct = avanceActual(facts.progressSeries);
  let movedFicha;
  if (lastDispatchTs != null) {
    movedFicha = stampEverSeen
      ? lastDispatchTs !== state.lastStampTs
      // Primera estampa que vemos: sólo cuenta como movimiento si es POSTERIOR
      // al reloj que veníamos usando (o sea, despachó de verdad después de que
      // empezamos a contar). Si es anterior, es la foto de un despacho viejo.
      : state.lastMovementTs > 0 && lastDispatchTs > state.lastMovementTs;
  } else if (stampEverSeen) {
    movedFicha = false;
  } else {
    // rev-6 (BLOQUEANTE rev-1) — Proxy legacy SIN estampa. Antes acá se usaba
    // `signatureChanged`, o sea igualdad de string sobre `${dispatching}:${avance}`.
    // Eso contradecía textualmente el invariante escrito 20 líneas más arriba: la
    // firma cambia TAMBIÉN cuando el conteo BAJA, y el conteo baja solo a medida
    // que los agentes viejos terminan. Reproducido contra este mismo módulo, modo
    // `never`, CERO despachos, agentes drenando 3 → 2 → 1 → 0:
    //
    //   t=100min disp=3 → alert/unexplained-stall, stalled=99min
    //   t=101min disp=2 → skip/within-threshold,   stalled=0min,  recovery=SÍ
    //   t=201min disp=1 → skip/within-threshold,   stalled=0min
    //
    // Cada muerte de un agente clavado reiniciaba el reloj y se reportaba como
    // "despacho reanudado" (que en pulpo.js borra `needs_attention`). Con el
    // conteo OSCILANDO entre fases el umbral no se alcanzaba NUNCA: 400 min de
    // detención real sin una sola alerta — la negación exacta de CA-1.
    //
    // Un despacho sólo puede AGREGAR trabajo o AVANZAR la ola, así que acá sólo
    // podría contar el AUMENTO, jamás la baja. Sin observación previa (`null`,
    // arranque en frío o estado de una versión anterior) no se puede afirmar que
    // hubo aumento ⇒ no hay movimiento: el reloj arranca y corre.
    //
    // Y el AUMENTO DE `dispatching` tampoco cuenta, por un argumento que sólo
    // vale en esta rama: `never` significa que NUNCA se vio una estampa. La
    // estampa la escribe pulpo.js en el punto del spawn real (con guarda de PID)
    // y tiene espejo en memoria si el FS falla, así que un despacho de verdad
    // habría sacado al watchdog de `never` en el tick siguiente. Si seguimos en
    // `never`, ese aumento NO vino de un despacho: vino de una ficha promovida
    // entre fases (el conteo es global a todas). Aceptarlo dejaba al watchdog
    // MUDO con el conteo oscilando 2↔3 sin un solo despacho — el reloj se
    // reiniciaba en cada subida y jamás alcanzaba el umbral.
    //
    // Queda `avancePct`: progreso real y monótono de la ola, señal independiente
    // del conteo y la que el PO definió como "mover una ficha" en #4708.
    movedFicha = state.lastAvancePct != null && avancePct != null
      && avancePct > state.lastAvancePct;
  }

  const nextState = {
    ...state,
    lastSignature: signature,
    lastDispatching: dispatching,
    // Un avance ilegible NO pisa el último valor bueno: si se pierde la serie,
    // olvidarlo permitiría que el siguiente valor cuente como "aumento" desde
    // cero y reiniciara el reloj sin haber despachado.
    lastAvancePct: avancePct != null ? avancePct : state.lastAvancePct,
  };

  // Causa declarada: sólo se usa para NOMBRAR el motivo en el aviso y para
  // decidir cuál de los dos umbrales aplica. Ya NO tiene reloj propio (B1).
  const causeValida = isCauseValid(facts.cause, now);
  const causeKind = causeValida
    ? ((facts.cause && facts.cause.kind) ? String(facts.cause.kind) : 'declared')
    : null;

  // --- 1c. Recuperación del despacho (CA-5) -----------------------------
  // Sólo si el episodio anterior LLEGÓ A ALERTAR: reanudar tras un silencio que
  // nadie notificó no es una "recuperación" que valga un mensaje.
  //
  // rev-6 — Además, SÓLO con el reloj honesto (`stampState === 'ok'`). El mensaje
  // de recuperación afirma una duración exacta ("la detención duró N"), y sin
  // estampa creíble esa duración sale de la proxy legacy, que no puede
  // sostenerla. Anunciar una reanudación que no consta es peor que callar: en
  // pulpo.js `decision.recovery` dispara `clearWaveStalled()` y borra la marca
  // `needs_attention` — o sea que una recuperación falsa apaga la señal de
  // atención en plena detención real.
  const recovering = movedFicha && state.alertCount > 0 && state.lastMovementTs > 0
    && stampState === 'ok';
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
    nextState.lastStampTs = lastDispatchTs;
    nextState.lastMovementTs = lastDispatchTs;
  } else if (movedFicha) {
    nextState.lastMovementTs = now;
  } else if (!(state.lastMovementTs > 0)) {
    // #5400 (rev-1, B4) — arranque en frío SIN estampa: el reloj arranca ahora.
    // Antes esta rama no existía y, con agentes en `trabajando/`, el brazo salía
    // por `skip: dispatching` en cada tick: 33 h de silencio con
    // `degraded: false`, justo en el escenario que motiva el módulo.
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
    scopeBlind,
    queuedTotal,
    // #5400 — contexto para el brazo y el dashboard.
    causeKind,
    dispatching,
    lastDispatchTs,
    stampState,
    stampDegraded,
    recovery,
  });

  // --- 2. Sin trabajo habilitado => nada que vigilar (CA-3) -------------
  // Una cola legítimamente vacía NO alerta. Criterio ya acordado: la ociosidad
  // sólo se avisa por recursos o deadlock humano.
  //
  // rev-6 (B4) — salvo que el alcance esté CIEGO: ahí `elegibles: 0` no significa
  // "no hay trabajo" sino "no puedo saber cuál es despachable", y callar sería
  // apagar el control justo en un estado de pipeline trabado.
  //
  // rev-6 (B2) — una cola legítimamente vacía CIERRA el episodio: se resetea
  // también el backoff. Antes el reset colgaba sólo de `movedFicha`, así que el
  // primer aviso del episodio siguiente heredaba el cooldown acumulado del
  // anterior (hasta 16× = 8 h de mordaza) sin que nada lo justificara.
  if (enabledCount <= 0 && !scopeBlind) {
    nextState.lastAlertTs = 0;
    nextState.alertCount = 0;
    return base('skip', 'no-enabled-work', 'info');
  }

  // --- 3. ¿Cuánto lleva sin despachar? ----------------------------------
  // Este es EL reloj del módulo: inactividad de despacho. Es inmune al flapeo de
  // causas, a que un agente quede clavado y a que la estampa se pierda.
  const stalledMs = Math.max(0, now - lastMovementTs);
  if (stalledMs < stallMs) return base('skip', 'within-threshold', 'info');

  // --- 4. Causa declarada vigente (CA-2 / SEC-1) ------------------------
  // Fail-closed: causa ausente/ilegible/expirada NO es válida => seguimos.
  // La causa declarada silencia mientras la inactividad es corta, pero pasado
  // `escalateMinutes` SIN DESPACHAR y con trabajo elegible esperando deja de ser
  // una explicación y pasa a ser el problema. La escalada es ESTRICTAMENTE
  // ADITIVA (umbral alto Y elegibles > 0 — garantizado por el paso 2): por
  // debajo del umbral el comportamiento es idéntico al de #4708/#4751, o sea que
  // el modo ola sigue mudo.
  //
  // rev-1 (B1): se mide `stalledMs`, NO la antigüedad de la causa. Con el reloj
  // de la causa, un pipeline que rota entre cooldown y concurrency-limit cada
  // 30 min nunca llegaba al umbral y callaba para siempre.
  let reason = 'unexplained-stall';
  if (causeValida) {
    if (stalledMs < escalateMs) {
      return base('skip', `declared-cause:${causeKind}`, 'info');
    }
    reason = `stale-declared-cause:${causeKind}`;
  }

  // --- 5. Anti-flooding: BACKOFF EXPONENCIAL dentro del episodio (SEC-4/CA-4)
  // rev-2 usaba un cooldown FIJO: una detención larga (las hay de 8-14 h en el
  // histórico de 7 días) producía una re-alerta cada 30 min, o sea decenas de
  // mensajes idénticos por episodio. Un canal así deja de leerse, que es lo
  // contrario del objetivo del issue. El backoff duplica la espera en cada
  // re-alerta (30 → 60 → 120 → …) hasta el tope: el primer aviso llega igual de
  // rápido y el episodio largo cuesta ~5 mensajes en vez de ~27.
  const backoffFactor = Math.min(
    2 ** Math.max(0, (state.alertCount || 0) - 1),
    MAX_ALERT_BACKOFF_FACTOR
  );
  const cooldownEfectivoMs = cooldownMs * backoffFactor;
  if (state.lastAlertTs > 0 && now - state.lastAlertTs < cooldownEfectivoMs) {
    return base('skip', 'cooldown', 'info');
  }

  // --- 6. Estancamiento confirmado: disparar ----------------------------
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
    dispatching,
    stampDegraded,
    scopeBlind,
    queuedTotal,
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
  avanceActual,
  parseStallMinutes,
  // #5400 (rev-7) — `parsePositiveInt` NO se exporta más, ni siquiera como
  // alias: era un nombre sin unidad y su única razón de existir hoy sería
  // dejar viva la trampa que rompió el tick. Quien parsea minutos usa
  // `parsePositiveMinutes`; quien parsea el período del brazo, `parseTickMs`.
  parsePositiveMinutes,
  parseTickMs,
  normalizeState,
  loadState,
  saveStateAtomic,
  CAUSE_LABELS,
  DEFAULT_STALL_MINUTES,
  MAX_STALL_MINUTES,
  DEFAULT_COOLDOWN_MINUTES,
  DEFAULT_TICK_MS,
  MIN_TICK_MS,
  MAX_TICK_MS,
  MAX_ALERT_BACKOFF_FACTOR,
  DEFAULT_DECLARED_CAUSE_ESCALATE_MINUTES,
  DEFAULT_BUSY_GRACE_MINUTES,
  FUTURE_STAMP_TOLERANCE_MS,
};
