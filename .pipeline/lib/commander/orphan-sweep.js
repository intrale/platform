// =============================================================================
// orphan-sweep.js — Barrido de rescate de turnos HUÉRFANOS del Commander
// (#6459, Bloque B / mitad de detección del split de #6440).
//
// Un turno HUÉRFANO es un turno que **se ejecutó de verdad** (asentó la etapa
// `transcripción` en el canal estructurado de #6458) y que **nunca confirmó
// entrega** de su respuesta. Hoy ese turno es indistinguible de uno que nunca
// arrancó: el `.log` simplemente se corta. Después de este módulo, se lee como
// huérfano tanto en el audit encadenado como —vía la etapa `resultado`— en el
// dashboard.
//
// ESTE MÓDULO NO NOTIFICA A NADIE. El aviso al operador por Telegram es #6460,
// que llenará el parámetro `notified`. Acá `notified` ya existe y se respeta,
// aunque llegue vacío.
//
// -----------------------------------------------------------------------------
// Decisiones cerradas en la definición del padre (#6440) — NO se reabren:
//
//   D-1 · Ventana del barrido: 48 h. Los huérfanos más viejos quedan afuera a
//         propósito (el primer boot encola 1 aviso, no los 18 históricos).
//   D-2 · El discriminante NO es "no tiene etapa `envío`". Es:
//            transcripción presente ∧ resultado ausente ∧ entrega ≠ 'enviado'
//         y el veredicto de entrega sale SIEMPRE de `commanderOutboundStatus`
//         (inyectado por `deps.outboundStatus`), nunca del `.log`, nunca del
//         texto del modelo (#3951), nunca de la propia etapa `envío`.
//   B1  · La guarda de vida es por `boot_id`, no por PID ni por reloj.
//   A3  · Evento TERMINAL, nunca reescritura: se emite
//         `inflight_fallback_delivery_resolved`; el `inflight_fallback_completed`
//         ya asentado queda intacto y la hash-chain sigue verificando.
//
// -----------------------------------------------------------------------------
// Los DOS desenlaces terminales (CA-2 + CA-3, "Cambios requeridos" #4).
//
// El barrido NO es sólo un detector de huérfanos: es el que CIERRA el ciclo de
// vida de un `inflight_fallback_completed` que quedó en `delivery_pending`. Por
// eso emite el evento terminal en LOS DOS desenlaces, no en uno solo:
//
//   ┌─ B-13 entrega NO confirmada → HUERFANO  ⇒ { success:false,
//   │                                             delivery_state:'delivery_failed',
//   │                                             error_code:'delivered=false' }   (CA-2)
//   └─ B-12 entrega SÍ confirmada → SANO      ⇒ { success:true,
//                                                 delivery_state:'delivery_observed' } (CA-3)
//
// Si sólo se emitiera el desenlace fallido, un fallback que SÍ se entregó se
// quedaría en `delivery_pending` para siempre, indistinguible de una entrega sin
// resolver — que es exactamente el síntoma que #6440 elimina, pero del lado del
// éxito. Emitirlo también en el éxito es lo que hace que `delivery_pending`
// signifique "todavía no se sabe" en vez de "no se supo nunca".
//
// Qué NO emite, y por qué:
//   · B-09 `cerro_solo` — ese turno cerró in-process y su desenlace ya lo asentó
//     el `finally` del propio turno. El barrido de rescate no lo toca (CA-6).
//   · B-11 `correlacion_directa` / B-14 `correlacion_sin_rastro` — no hay hecho
//     observado que asentar; afirmar cualquiera de los dos desenlaces sería
//     afirmar algo no observado (SEC-0/B5).
//
// CA-10 sigue intacto: un turno sano produce cero MARCAS DE HUÉRFANO. El evento
// de éxito no es una marca de huérfano — es el cierre positivo del ciclo, y lleva
// `success: true` + `delivery_observed` justamente para no poder confundirse.
//
// CA-11 vale para AMBOS desenlaces por igual: los dos pasan por el mismo set
// `yaResueltos` (`readResolvedRefs` sobre el audit encadenado), así que es UN
// evento por `commander_req_id`, no uno por tick.
//
// -----------------------------------------------------------------------------
// Forma del módulo: NÚCLEO PURO + capa de I/O.
//
//   `detectOrphans(...)`  no lee disco, no mira el reloj, no requiere pulpo.js.
//   `runOrphanSweep(...)` enumera, filtra por ventana, lee, delega y emite.
//
// `outboundStatus` entra por `deps` (inyección) y NO por `require('../../pulpo.js')`:
// `pulpo.js` es el proceso, no una librería — requerirlo desde `lib/` crea un
// ciclo y arranca el mundo dentro de un test.
//
// -----------------------------------------------------------------------------
// Seguridad:
//   SEC-0 · El camino de decisión NUNCA abre el `.log` de texto plano (que es
//           falsificable: ahí se vuelca la salida cruda del LLM). Sólo el
//           `.stages.jsonl`.
//   SEC-1 · El `reqId` se deriva del nombre del archivo y se exige que
//           `stagesFileName(reqId) === nombre` (round-trip). Cualquier nombre
//           con `..`, separadores o caracteres fuera de `ID_SAFE_RE` NO
//           round-trippea ⇒ se DESCARTA (no se "corrige").
//   SEC-2 · Se enumera con `withFileTypes` y se exige `isFile()`: symlinks,
//           directorios y FIFOs quedan afuera con un solo syscall.
//   SEC-3 · Best-effort total: el barrido jamás propaga una excepción al tick
//           del pulpo. Pero un fallo DEJA RASTRO (CA-14), nunca degrada en
//           silencio al mismo estado que "todo sano".
//   SEC-4 · Al audit sólo va `buildAuditReqRef(reqId)` (seudonimizado) y el
//           `chat_id` hasheado por el propio `noteFallbackDeliveryResolved`.
//           NUNCA el `reqId` crudo (que contiene el chat id de Telegram).
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const {
  stagesFileName,
  readStages: readStagesReal,
  hasStage,
  buildAuditReqRef,
} = require('./request-log');

// -----------------------------------------------------------------------------
// Enum CERRADO de veredicto por turno. Congelado: no se muta en runtime.
// -----------------------------------------------------------------------------
const OrphanVerdict = Object.freeze({
  HUERFANO: 'huerfano',             // se ejecutó y su entrega no se confirmó
  SANO: 'sano',                     // cerró solo, o su entrega está confirmada
  NO_EVALUABLE: 'no_evaluable',     // boot vivo / fuera de ventana / ya resuelto
  NO_VERIFICABLE: 'no_verificable', // legacy sin canal / correlación imposible
});

// D-1 — ventana del barrido.
const ORPHAN_WINDOW_MS = 48 * 60 * 60 * 1000;

// B1 (parte legacy) — un turno SIN `boot_id` en su etapa `transcripción` viene
// de un pulpo pre-#6458. Ahí la única guarda posible es el reloj: por debajo de
// este margen puede seguir vivo ⇒ no se evalúa. A las 48 h del deploy el
// sustrato legacy sale solo de la ventana.
const LEGACY_LIVENESS_MS = 45 * 60 * 1000;

// Piso de plausibilidad del `epochms` de un reqId (2020-01-01T00:00:00Z). Se usa
// SÓLO para desambiguar el split del reqId, nunca como filtro de negocio.
const MIN_PLAUSIBLE_MS = 1577836800000;

// Nombre de archivo del canal estructurado. Se valida por round-trip contra
// `stagesFileName` (SEC-1), así que este prefijo/sufijo son la única dependencia
// textual con el naming.
const STAGES_PREFIX = 'commander-';
const STAGES_SUFFIX = '.stages.jsonl';

// Evento terminal que este barrido emite y que también consulta para deduplicar
// (CA-11). Es el mismo literal que escribe `noteFallbackDeliveryResolved`.
const RESOLVED_EVENT = 'inflight_fallback_delivery_resolved';

// Nombre del emisor, para que el audit distinga quién observó el desenlace.
const RESOLVED_BY = 'orphan_sweep';

// Razón del veredicto SANO que SÍ produce evento terminal (el desenlace EXITOSO
// de CA-3). Ver el bloque "Los DOS desenlaces terminales" más abajo: `cerro_solo`
// (B-09) queda deliberadamente afuera.
const REASON_ENTREGA_CONFIRMADA = 'entrega_confirmada';

// -----------------------------------------------------------------------------
// parseReqIdParts — descompone `<chatSeg>-<epochms>[-<suffix>]`.
//
// TRAMPA (documentada en la receta del arquitecto): el `chat_id` de grupos de
// Telegram es NEGATIVO y puede tener 13+ dígitos (`-1001234567890`), y el
// `suffix` puede ser puramente numérico. Ni un regex greedy ni uno lazy aciertan
// los dos casos a la vez:
//   - greedy  rompe con suffix numérico   (`123-<ms>-9876543210`)
//   - lazy    rompe con supergrupo largo  (`-1001234567890-<ms>`)
// Por eso enumeramos TODOS los splits posibles por `-` y elegimos el candidato
// PLAUSIBLE más a la derecha. Determinístico y sin reloj propio: el `nowMs`
// entra por parámetro.
//
// @returns {{chatSeg:string, epochms:number, suffix:string|null}|null}
// -----------------------------------------------------------------------------
function parseReqIdParts(reqId, nowMs) {
  const id = String(reqId == null ? '' : reqId);
  if (!id) return null;
  const maxMs = (Number.isFinite(nowMs) ? nowMs : 0) + 24 * 60 * 60 * 1000;
  const candidates = [];
  for (let i = 1; i < id.length - 1; i++) {
    if (id[i] !== '-') continue;
    const chatSeg = id.slice(0, i);
    const rest = id.slice(i + 1);
    const m = rest.match(/^(\d{10,})(?:-([a-zA-Z0-9]+))?$/);
    if (!m) continue;
    const epochms = Number(m[1]);
    if (!Number.isFinite(epochms)) continue;
    candidates.push({
      chatSeg,
      epochms,
      suffix: m[2] || null,
      plausible: epochms >= MIN_PLAUSIBLE_MS && epochms <= maxMs,
    });
  }
  if (candidates.length === 0) return null;
  const plausibles = candidates.filter((c) => c.plausible);
  const chosen = plausibles.length > 0
    ? plausibles[plausibles.length - 1]
    : candidates[candidates.length - 1];
  return { chatSeg: chosen.chatSeg, epochms: chosen.epochms, suffix: chosen.suffix };
}

// -----------------------------------------------------------------------------
// reqIdFromStagesFileName — deriva el `reqId` de un nombre de archivo del canal
// estructurado, con validación por ROUND-TRIP (SEC-1).
//
// No re-sanitizamos por afuera: `stagesFileName` ya aplica `ID_SAFE_RE`, y dos
// verdades es peor que una. Lo que hacemos es EXIGIR que el nombre observado sea
// exactamente el que `stagesFileName` produciría para el id derivado. Un nombre
// con `..`, `/`, `\` o cualquier carácter fuera del set seguro no round-trippea
// ⇒ devuelve `null` ⇒ se descarta.
//
// @returns {string|null}
// -----------------------------------------------------------------------------
function reqIdFromStagesFileName(name) {
  const n = String(name == null ? '' : name);
  if (!n.startsWith(STAGES_PREFIX) || !n.endsWith(STAGES_SUFFIX)) return null;
  const reqId = n.slice(STAGES_PREFIX.length, n.length - STAGES_SUFFIX.length);
  if (!reqId) return null;
  if (stagesFileName(reqId) !== n) return null; // SEC-1: round-trip o nada
  return reqId;
}

// -----------------------------------------------------------------------------
// correlationIdFromStages — EL PUNTO NO OBVIO DE TODO EL ISSUE (R-2).
//
// `commanderOutboundStatus(historyRaw, correlationId)` necesita un
// `correlationId`, y ese id vive ÚNICAMENTE en la etapa `envío`. Un huérfano
// real es, por definición, un turno SIN etapa `envío` ⇒ no hay `correlationId`
// que consultar. Eso no rompe D-2: lo completa.
//
// La etapa `envío` es PORTADORA del identificador, NUNCA del veredicto (CA-7).
// El veredicto lo sigue emitiendo `commanderOutboundStatus`.
//
// @returns {string|null} `null` = no hubo saliente encolado.
//                        `'DIRECTO'` = hubo saliente pero sin reconciliación
//                        posible (`correlation_id: 'directo'`).
// -----------------------------------------------------------------------------
function correlationIdFromStages(stages) {
  if (!Array.isArray(stages)) return null;
  const env = stages.find((e) => e && typeof e === 'object' && e.etapa === 'envío');
  if (!env) return null;
  const cid = env.correlation_id;
  if (!cid || cid === 'directo') return 'DIRECTO';
  return String(cid);
}

// -----------------------------------------------------------------------------
// bootIdFromStages — `boot_id` que la etapa `transcripción` ya lleva (#6458).
// -----------------------------------------------------------------------------
function bootIdFromStages(stages) {
  if (!Array.isArray(stages)) return null;
  const t = stages.find((e) => e && typeof e === 'object' && e.etapa === 'transcripción');
  if (!t) return null;
  const b = t.boot_id;
  return (b == null || b === '') ? null : String(b);
}

// -----------------------------------------------------------------------------
// chatIdFromStages — `chat_id` REAL del mensaje (no el del texto del modelo).
// Sólo se usa para que `noteFallbackDeliveryResolved` lo hashee: nunca se
// persiste crudo (SEC-4).
// -----------------------------------------------------------------------------
function chatIdFromStages(stages) {
  if (!Array.isArray(stages)) return null;
  const t = stages.find((e) => e && typeof e === 'object' && e.etapa === 'transcripción');
  if (!t) return null;
  const c = t.chat_id;
  return (c == null || c === '') ? null : String(c);
}

// -----------------------------------------------------------------------------
// classifyRequest — decisión PURA para UN turno.
//
// RAMAS DE DECISIÓN (enumeradas acá y espejadas 1:1 en el test — CA-15):
//   B-01 reqId no parseable ................. NO_EVALUABLE   / req_id_invalido
//   B-02 fuera de la ventana de 48 h ........ NO_EVALUABLE   / fuera_de_ventana
//   B-03 ya resuelto o ya notificado ........ NO_EVALUABLE   / ya_resuelto
//   B-04 canal vacío y turno reciente ....... NO_EVALUABLE   / sin_canal_reciente
//   B-05 canal vacío y turno viejo .......... NO_VERIFICABLE / sin_canal_estructurado
//   B-06 boot_id === boot actual (vivo) ..... NO_EVALUABLE   / boot_actual
//   B-07 sin boot_id y < 45 min (legacy) .... NO_EVALUABLE   / legacy_reciente
//   B-08 sin etapa `transcripción` .......... NO_EVALUABLE   / sin_transcripcion
//   B-09 con etapa `resultado` (cerró solo) . SANO           / cerro_solo
//   B-10 sin saliente encolado .............. HUERFANO       / sin_saliente
//   B-11 correlation_id === 'directo' ....... NO_VERIFICABLE / correlacion_directa
//   B-12 outboundStatus 'enviado' ........... SANO           / entrega_confirmada
//        ^ ÚNICO veredicto SANO que emite evento terminal, y lo emite EXITOSO
//          (`success:true` + `delivery_observed`) — CA-3. Cierra el
//          `delivery_pending` del lado del éxito.
//   B-13 outboundStatus 'fallido'/'encolado'. HUERFANO       / entrega_no_confirmada
//   B-14 outboundStatus 'unknown' u otro .... NO_VERIFICABLE / correlacion_sin_rastro
//
// B-14 resuelve la observación O-1 de `guru` y del PO: `commanderOutboundStatus`
// devuelve `'unknown'` cuando NO hay ninguna entry para ese correlation_id, o
// sea cuando el historial se perdió o se corrompió. Con un correlation_id REAL
// en mano, afirmar "no se entregó" a partir de la ausencia de rastro sería
// afirmar un hecho no observado — justo lo que SEC-0/B5 prohíben, y la vía
// directa al falso positivo que rompería CA-10. Se cuenta y se loguea; NO emite
// evento terminal.
// -----------------------------------------------------------------------------
function classifyRequest(entry, ctx) {
  const { reqId, stages } = entry;
  const { nowMs, currentBootId, windowMs, notified, outboundStatus, historyRaw } = ctx;

  const parts = parseReqIdParts(reqId, nowMs);
  if (!parts) return { verdict: OrphanVerdict.NO_EVALUABLE, reason: 'req_id_invalido' };
  const { epochms } = parts;

  // B-02 — defensa en profundidad: la capa de I/O ya filtró por ventana ANTES de
  // abrir nada (CA-8), pero el núcleo puro no confía en su caller.
  const win = Number.isFinite(windowMs) ? windowMs : ORPHAN_WINDOW_MS;
  if (nowMs - epochms > win) {
    return { verdict: OrphanVerdict.NO_EVALUABLE, reason: 'fuera_de_ventana', epochms };
  }

  // B-03 — CA-11: un mismo huérfano produce EXACTAMENTE UN evento terminal.
  // `notified` trae el set de `commander_req_id` (seudonimizados) que ya tienen
  // su evento asentado; hasta #6460 lo llena sólo el precheck del propio audit.
  const auditRef = buildAuditReqRef(reqId);
  if (auditRef && notified && typeof notified.has === 'function' && notified.has(auditRef)) {
    return { verdict: OrphanVerdict.NO_EVALUABLE, reason: 'ya_resuelto', epochms, auditRef };
  }

  const edadMs = nowMs - epochms;

  if (!Array.isArray(stages) || stages.length === 0) {
    // B-04 / B-05 — sin canal estructurado. B5: el `.log` es fuente de BAJA
    // confianza y acá directamente no se abre (SEC-0). Escala a no-verificable,
    // NUNCA suprime ni afirma entrega.
    if (edadMs < LEGACY_LIVENESS_MS) {
      return { verdict: OrphanVerdict.NO_EVALUABLE, reason: 'sin_canal_reciente', epochms, auditRef };
    }
    return { verdict: OrphanVerdict.NO_VERIFICABLE, reason: 'sin_canal_estructurado', epochms, auditRef };
  }

  // B-06 / B-07 — guarda de vida (B1). Comparación de STRING pura, no PID ni
  // reloj: un turno del boot actual lo cierra el `finally` in-process, así que
  // el barrido no lo evalúa NUNCA.
  const bootId = bootIdFromStages(stages);
  if (bootId && currentBootId && bootId === String(currentBootId)) {
    return { verdict: OrphanVerdict.NO_EVALUABLE, reason: 'boot_actual', epochms, auditRef };
  }
  if (!bootId && edadMs < LEGACY_LIVENESS_MS) {
    return { verdict: OrphanVerdict.NO_EVALUABLE, reason: 'legacy_reciente', epochms, auditRef };
  }

  // B-08 — sin `transcripción` el turno no llegó a ejecutarse: no hay nada que
  // rescatar (primera mitad del discriminante D-2).
  if (!hasStage(stages, 'transcripción')) {
    return { verdict: OrphanVerdict.NO_EVALUABLE, reason: 'sin_transcripcion', epochms, auditRef };
  }

  // B-09 — CA-6: el barrido NUNCA toca un turno que ya asentó `resultado`.
  // Un early-return CON `resultado` y SIN `envío` no es huérfano acá: ese caso
  // lo cubre el camino rápido in-process (R-3).
  if (hasStage(stages, 'resultado')) {
    return { verdict: OrphanVerdict.SANO, reason: 'cerro_solo', epochms, auditRef };
  }

  const chatId = chatIdFromStages(stages);
  const cid = correlationIdFromStages(stages);

  // B-10 — no hubo saliente encolado. No hay nada que reconciliar y el turno
  // corrió: es el huérfano canónico del episodio de #6440.
  if (cid === null) {
    return {
      verdict: OrphanVerdict.HUERFANO, reason: 'sin_saliente',
      epochms, auditRef, chatId, entrega: 'sin_saliente',
    };
  }

  // B-11 — hubo envío observable en el canal no falsificable, pero sin recibo
  // posible. Afirmar "no se entregó" sería afirmar un hecho no observado.
  if (cid === 'DIRECTO') {
    return {
      verdict: OrphanVerdict.NO_VERIFICABLE, reason: 'correlacion_directa',
      epochms, auditRef, chatId, entrega: 'no_verificable',
    };
  }

  // CA-7 — el veredicto de entrega sale de `commanderOutboundStatus`, nunca de
  // la etapa `envío`, del texto del modelo (#3951) ni de `clearFlag`.
  let estado = 'unknown';
  try {
    estado = typeof outboundStatus === 'function'
      ? String(outboundStatus(historyRaw, cid) || 'unknown')
      : 'unknown';
  } catch {
    estado = 'unknown';
  }

  if (estado === 'enviado') { // B-12
    return {
      verdict: OrphanVerdict.SANO, reason: 'entrega_confirmada',
      epochms, auditRef, chatId, entrega: estado,
    };
  }
  if (estado === 'fallido' || estado === 'encolado') { // B-13
    return {
      verdict: OrphanVerdict.HUERFANO, reason: 'entrega_no_confirmada',
      epochms, auditRef, chatId, entrega: estado,
    };
  }
  // B-14 — 'unknown' y cualquier valor inesperado: no observado ⇒ no se afirma.
  return {
    verdict: OrphanVerdict.NO_VERIFICABLE, reason: 'correlacion_sin_rastro',
    epochms, auditRef, chatId, entrega: estado,
  };
}

// Normaliza las tres formas aceptadas de `stagesByReq` a un array de entradas.
function normalizeStagesByReq(stagesByReq) {
  if (!stagesByReq) return [];
  if (Array.isArray(stagesByReq)) {
    return stagesByReq
      .filter((e) => e && typeof e === 'object' && typeof e.reqId === 'string')
      .map((e) => ({ reqId: e.reqId, stages: Array.isArray(e.stages) ? e.stages : [] }));
  }
  if (typeof stagesByReq.forEach === 'function' && typeof stagesByReq.get === 'function') {
    const out = [];
    stagesByReq.forEach((stages, reqId) => {
      out.push({ reqId: String(reqId), stages: Array.isArray(stages) ? stages : [] });
    });
    return out;
  }
  if (typeof stagesByReq === 'object') {
    // Objeto plano. `Object.keys` sobre un objeto de datos NO expone `__proto__`
    // como clave propia, así que no hay superficie CWE-1321 acá.
    return Object.keys(stagesByReq).map((reqId) => ({
      reqId,
      stages: Array.isArray(stagesByReq[reqId]) ? stagesByReq[reqId] : [],
    }));
  }
  return [];
}

// -----------------------------------------------------------------------------
// detectOrphans — NÚCLEO PURO.
//
// No lee disco, no mira el reloj del sistema, no requiere `pulpo.js`.
//
// @param {object} args
// @param {Array<{reqId:string, stages:Array<object>}>|object|Map} args.stagesByReq
//        Etapas por reqId. Acepta array de entradas, `Map` o objeto plano
//        `{ [reqId]: stages }`.
// @param {string} args.historyRaw      contenido crudo de `commander-history.jsonl`.
// @param {number} args.nowMs           reloj inyectado.
// @param {string} args.currentBootId   `PULPO_BOOT_ID` del proceso vivo.
// @param {number} [args.windowMs]      default `ORPHAN_WINDOW_MS`.
// @param {Set<string>} [args.notified] refs de audit ya resueltas/notificadas.
// @param {object} [args.deps]          `{ outboundStatus }`.
// @returns {{ resultados: Array<object>, huerfanos: Array<object>, resumen: object }}
// -----------------------------------------------------------------------------
function detectOrphans(args) {
  const {
    stagesByReq,
    historyRaw = '',
    nowMs,
    currentBootId = null,
    windowMs = ORPHAN_WINDOW_MS,
    notified = null,
    deps = {},
  } = (args && typeof args === 'object') ? args : {};

  const entries = normalizeStagesByReq(stagesByReq);
  const ctx = {
    nowMs: Number.isFinite(nowMs) ? nowMs : 0,
    currentBootId,
    windowMs,
    notified: (notified && typeof notified.has === 'function') ? notified : new Set(),
    outboundStatus: typeof deps.outboundStatus === 'function' ? deps.outboundStatus : null,
    historyRaw: typeof historyRaw === 'string' ? historyRaw : '',
  };

  const resultados = [];
  const resumen = { evaluados: 0, huerfanos: 0, sanos: 0, no_evaluables: 0, no_verificables: 0 };
  for (const entry of entries) {
    const r = classifyRequest(entry, ctx);
    r.reqId = entry.reqId;
    resultados.push(r);
    resumen.evaluados += 1;
    if (r.verdict === OrphanVerdict.HUERFANO) resumen.huerfanos += 1;
    else if (r.verdict === OrphanVerdict.SANO) resumen.sanos += 1;
    else if (r.verdict === OrphanVerdict.NO_VERIFICABLE) resumen.no_verificables += 1;
    else resumen.no_evaluables += 1;
  }

  return {
    resultados,
    huerfanos: resultados.filter((r) => r.verdict === OrphanVerdict.HUERFANO),
    // CA-3 — el desenlace EXITOSO. SANO por `entrega_confirmada` (B-12) y NADA
    // más: `cerro_solo` (B-09) cerró in-process y no lo toca el barrido.
    entregados: resultados.filter((r) => r.verdict === OrphanVerdict.SANO
      && r.reason === REASON_ENTREGA_CONFIRMADA),
    resumen,
  };
}

// -----------------------------------------------------------------------------
// auditDayFiles — los archivos de audit encadenado que cubren la ventana.
//
// `commander-dispatch-YYYY-MM-DD.jsonl` rota por día UTC
// (`inflight-fallback.js#auditFile`). Una ventana de 48 h toca a lo sumo 3 días.
// -----------------------------------------------------------------------------
function auditDayFiles(pipelineDir, nowMs, windowMs) {
  const win = Number.isFinite(windowMs) ? windowMs : ORPHAN_WINDOW_MS;
  const dias = Math.floor(win / (24 * 60 * 60 * 1000)) + 1;
  const out = [];
  for (let i = 0; i < dias; i++) {
    const d = new Date(nowMs - i * 24 * 60 * 60 * 1000);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    out.push(path.join(pipelineDir || '.', 'logs', `commander-dispatch-${yyyy}-${mm}-${dd}.jsonl`));
  }
  return out;
}

// -----------------------------------------------------------------------------
// readResolvedRefs — precheck de idempotencia (CA-11 / R-4).
//
// `noteFallbackDeliveryResolved` es un APPENDER PURO sin deduplicación: cada
// llamada asienta una entrada nueva. Con el barrido corriendo en bucle sobre una
// ventana de 48 h, sin este precheck el huérfano del episodio emitiría un evento
// por tick durante dos días.
//
// La fuente de verdad es el propio audit encadenado — no agregamos estado nuevo,
// y es EXACTAMENTE el set que #6460 va a poblar cuando llene `notified`.
// FAIL-OPEN acotado: si un archivo no se puede leer, se saltea (el peor caso es
// un evento duplicado, nunca un huérfano perdido).
// -----------------------------------------------------------------------------
function readResolvedRefs({ pipelineDir, nowMs, windowMs, fsImpl }) {
  const _fs = fsImpl || fs;
  const refs = new Set();
  if (!pipelineDir) return refs;
  for (const file of auditDayFiles(pipelineDir, nowMs, windowMs)) {
    let raw;
    try {
      if (typeof _fs.existsSync === 'function' && !_fs.existsSync(file)) continue;
      raw = _fs.readFileSync(file, 'utf8');
    } catch { continue; }
    for (const linea of String(raw).split('\n')) {
      const t = linea.trim();
      if (!t) continue;
      if (t.indexOf(RESOLVED_EVENT) === -1) continue; // filtro barato antes de parsear
      let e;
      try { e = JSON.parse(t); } catch { continue; }
      if (!e || typeof e !== 'object') continue;
      // `appendChained` envuelve el entry (`{ entry, hash, ... }`); aceptamos las
      // dos formas para no acoplarnos al envoltorio.
      const entry = (e.entry && typeof e.entry === 'object') ? e.entry : e;
      if (entry.event !== RESOLVED_EVENT) continue;
      if (entry.commander_req_id) refs.add(String(entry.commander_req_id));
    }
  }
  return refs;
}

// -----------------------------------------------------------------------------
// runOrphanSweep — CAPA DE I/O.
//
// Enumera el canal estructurado, filtra por ventana ANTES de abrir nada (CA-8),
// lee, delega en el núcleo puro y emite el evento terminal por cada huérfano.
//
// NUNCA tira (SEC-3), pero SIEMPRE deja rastro del fallo (CA-14): un barrido que
// falla no puede leerse igual que "no hay huérfanos".
//
// @returns {{ok:boolean, error?:string, resumen:object, emitidos:Array<string>}}
// -----------------------------------------------------------------------------
function runOrphanSweep(opts) {
  const {
    logDir,
    pipelineDir,
    nowMs = Date.now(),
    currentBootId = null,
    windowMs = ORPHAN_WINDOW_MS,
    notified = null,
    deps = {},
  } = (opts && typeof opts === 'object') ? opts : {};

  const _fs = deps.fsImpl || fs;
  const _readStages = typeof deps.readStages === 'function' ? deps.readStages : readStagesReal;
  const _log = typeof deps.log === 'function' ? deps.log : () => {};
  const resumenVacio = { evaluados: 0, huerfanos: 0, sanos: 0, no_evaluables: 0, no_verificables: 0 };

  if (!logDir) {
    _log('[orphan-sweep] sin logDir — barrido no ejecutado');
    return { ok: false, error: 'sin logDir', resumen: resumenVacio, emitidos: [], emitidosOk: [], emitidosFallidos: [] };
  }

  // 1 · Enumerar. SEC-2: un solo syscall con `withFileTypes`.
  let dirents;
  try {
    dirents = _fs.readdirSync(logDir, { withFileTypes: true });
  } catch (e) {
    // CA-14 — rastro observable con la causa. NO degrada a "todo sano".
    _log(`[orphan-sweep] no pude enumerar ${logDir}: ${e.message}`);
    return { ok: false, error: e.message, resumen: resumenVacio, emitidos: [], emitidosOk: [], emitidosFallidos: [] };
  }

  // 2 · Filtrar por ventana con el `epochms` del NOMBRE, antes de abrir nada.
  const candidatos = [];
  let descartados = 0;
  for (const d of dirents) {
    // SEC-2: symlink / dir / FIFO afuera. Un `dirent` sin `isFile` (fs fake
    // pobre) ⇒ fail-closed, se saltea.
    if (!d || typeof d.isFile !== 'function' || !d.isFile()) { descartados += 1; continue; }
    const reqId = reqIdFromStagesFileName(d.name); // SEC-1: round-trip o null
    if (!reqId) { descartados += 1; continue; }
    const parts = parseReqIdParts(reqId, nowMs);
    if (!parts) { descartados += 1; continue; }
    if (nowMs - parts.epochms > windowMs) { descartados += 1; continue; } // CA-8
    candidatos.push({ reqId });
  }

  // 3 · Contexto de lectura. Cada I/O es best-effort e independiente: que falle
  //     el historial no puede impedir el barrido (degrada a 'unknown', o sea
  //     NO_VERIFICABLE — conservador, nunca falso positivo).
  let historyRaw = '';
  if (pipelineDir) {
    try { historyRaw = _fs.readFileSync(path.join(pipelineDir, 'commander-history.jsonl'), 'utf8'); }
    catch (e) { _log(`[orphan-sweep] historial ilegible (degrado a no-verificable): ${e.message}`); }
  }

  // CA-11 — set de idempotencia: lo ya resuelto en el audit + lo que aporte el
  // caller (`notified`, que llena #6460).
  const yaResueltos = readResolvedRefs({ pipelineDir, nowMs, windowMs, fsImpl: _fs });
  if (notified && typeof notified.forEach === 'function') {
    notified.forEach((ref) => { if (ref) yaResueltos.add(String(ref)); });
  }

  // 4 · Leer SÓLO los candidatos dentro de ventana (CA-8).
  for (const c of candidatos) {
    try { c.stages = _readStages(logDir, c.reqId); }
    catch (e) {
      c.stages = [];
      _log(`[orphan-sweep] etapas ilegibles para un turno de la ventana: ${e.message}`);
    }
  }

  // 5 · Núcleo puro.
  const { resultados, huerfanos, entregados, resumen } = detectOrphans({
    stagesByReq: candidatos,
    historyRaw,
    nowMs,
    currentBootId,
    windowMs,
    notified: yaResueltos,
    deps: { outboundStatus: deps.outboundStatus },
  });

  // 6 · Emitir el evento TERMINAL en LOS DOS desenlaces (A3 + CA-2 + CA-3:
  //     evento nuevo, jamás reescritura del `inflight_fallback_completed` ya
  //     asentado). Ver el bloque "Los DOS desenlaces terminales" en la cabecera:
  //     sin la rama de éxito, un fallback que SÍ se entregó queda en
  //     `delivery_pending` para siempre.
  //
  //     Los dos comparten el MISMO `yaResueltos`, así que CA-11 (un evento por
  //     `commander_req_id`, no uno por tick) vale para ambos por construcción.
  const terminales = [
    // CA-2 — entrega no confirmada.
    ...huerfanos.map((r) => ({
      r,
      etiqueta: 'huérfano',
      payload: { deliveryState: 'delivery_failed', success: false, errorCode: 'delivered=false' },
    })),
    // CA-3 — entrega confirmada. `errorCode` ausente a propósito: el appender lo
    // normaliza a null y un cierre exitoso no tiene código de error.
    ...entregados.map((r) => ({
      r,
      etiqueta: 'entrega confirmada',
      payload: { deliveryState: 'delivery_observed', success: true },
    })),
  ];

  const emitidos = [];
  const emitidosOk = [];
  const emitidosFallidos = [];
  const emit = typeof deps.noteFallbackDeliveryResolved === 'function'
    ? deps.noteFallbackDeliveryResolved
    : null;
  if (emit) {
    for (const t of terminales) {
      const h = t.r;
      if (!h.auditRef) {
        _log(`[orphan-sweep] turno (${t.etiqueta}) sin ref de audit derivable — no se emite evento`);
        continue;
      }
      if (yaResueltos.has(h.auditRef)) continue; // CA-11, defensa dentro del run
      try {
        emit({
          pipelineDir,
          commanderReqId: h.auditRef,      // SEUDONIMIZADO (SEC-4)
          chatId: h.chatId || 'unknown',   // hashFor() internamente
          ...t.payload,
          resolvedBy: RESOLVED_BY,
          now: nowMs,
        });
        yaResueltos.add(h.auditRef);
        emitidos.push(h.auditRef);
        (t.payload.success === true ? emitidosOk : emitidosFallidos).push(h.auditRef);
      } catch (e) {
        _log(`[orphan-sweep] no pude asentar el evento terminal (${t.etiqueta}): ${e.message}`);
      }
    }
  }

  // CA-14 — el barrido deja rastro cuando hay algo que contar. Un barrido que
  // emitió eventos SIEMPRE lo loguea, incluso si no hubo ningún huérfano: si no,
  // el cierre exitoso sería invisible y se leería igual que "no pasó nada".
  if (resumen.huerfanos > 0 || resumen.no_verificables > 0 || emitidos.length > 0) {
    _log(`[orphan-sweep] ventana ${Math.round(windowMs / 3600000)}h: `
      + `${resumen.evaluados} evaluados, ${resumen.huerfanos} huérfano(s) `
      + `(${emitidos.length} evento(s) nuevo(s): ${emitidosFallidos.length} sin entrega, `
      + `${emitidosOk.length} con entrega confirmada), `
      + `${resumen.no_verificables} no verificable(s), `
      + `${resumen.sanos} sano(s), ${descartados} fuera de alcance`);
  }

  return { ok: true, resumen, emitidos, emitidosOk, emitidosFallidos, resultados, descartados };
}

module.exports = {
  detectOrphans,
  runOrphanSweep,
  OrphanVerdict,
  ORPHAN_WINDOW_MS,
  LEGACY_LIVENESS_MS,
  RESOLVED_EVENT,
  RESOLVED_BY,
  REASON_ENTREGA_CONFIRMADA,
  // exportados para tests / reuso acotado
  correlationIdFromStages,
  reqIdFromStagesFileName,
  parseReqIdParts,
  auditDayFiles,
  readResolvedRefs,
};
