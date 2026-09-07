// =============================================================================
// orphan-notify.js — Aviso al operador de que un pedido suyo se ejecutó y su
// respuesta se perdió (#6460, Bloque B / mitad de aviso del split de #6440).
//
// #6459 detecta el huérfano y lo pinta en el dashboard. Nadie se lo cuenta a
// quien estaba esperando la respuesta. Este módulo es esa mitad: convierte un
// veredicto HUERFANO en un mensaje que el operador recibe EN EL MOMENTO.
//
// El episodio que lo motiva (2026-08-24): el operador esperó 70 minutos creyendo
// que su pedido no se había ejecutado, cuando en realidad se había ejecutado
// entero (19 acciones sobre el repo, incluido un restart del pipeline). Por eso
// el aviso NO dice "falló": dice "ya está hecho, fijate cómo quedó antes de
// repetirlo". Un aviso que no advierte eso resuelve la mitad del problema.
//
// -----------------------------------------------------------------------------
// EL TEXTO NO SE ESCRIBE ACÁ (UX-4).
//
// Se requiere `../../assets/copy/orphan-turn/render` como FUENTE ÚNICA del texto
// visible. Producción sólo produce el `payload`. Si el texto que emite este
// módulo difiere del que emite ese renderer, el que está mal es este módulo.
//
// -----------------------------------------------------------------------------
// LA TRAMPA DEL ANCLA — el modo de falla que reintroduce el bug de #6440.
//
// `servicio-telegram.js` pasa `data.chat_id` por `resolvePrivateChatId`
// (`lib/notify-telegram.js`), y el servicio hace `renameSync(trabajando →
// listo/)` + `continue` cuando esa función dice `ok:false`: archiva el dropfile
// como procesado SIN llamar a Telegram y SIN escribir recibo.
//
// La tabla REAL de esa función (verificada en `lib/notify-telegram.js:110-119`,
// y ojo con el orden de los early-returns, que es donde está la sutileza):
//
//   requested == null ..................... {ok:true, chatId:null}   SIEMPRE.
//        El chequeo del ancla está DESPUÉS de este return, así que la rama sin
//        `chat_id` sobrevive incluso con `TELEGRAM_LEO_OPERATOR_CHAT_ID` vacío.
//        Es el único camino que el ancla no puede rechazar.
//   ancla vacía/ausente ................... {ok:false, 'no_operator_chat_id'}
//   ancla no canónica ..................... {ok:false, 'invalid_operator_chat_id'}
//   requested !== ancla ................... {ok:false, 'unauthorized_chat_id'}
//   requested === ancla ................... {ok:true}
//
// O sea: estampar `chat_id` siempre es un DESCARTE SILENCIOSO DISFRAZADO DE
// ENVÍO. El operador queda exactamente igual de callado que en el episodio que
// este aviso viene a cerrar. Por eso hay dos ramas y el destino nunca se
// infiere (ver `decidirPayload`), y por eso un destino que el ancla rechaza se
// DESCARTA Y SE REGISTRA en vez de encolarse.
//
// -----------------------------------------------------------------------------
// RAMAS DE DECISIÓN (enumeradas acá y espejadas 1:1 en el test — igual que
// B-01..B-14 de #6459):
//
//   Destino — `resolveNoticeTarget`
//     N-01 hay correlation_id y resuelve ............ ok  / correlacion
//     N-02 sin correlation_id ⇒ etapa transcripción . ok  / etapa
//     N-03 correlation_id 'DIRECTO' ⇒ se ignora ..... ok  / etapa
//     N-04 destino nulo / vacío / basura ............ NO  / destino_no_resoluble
//     N-05 la correlación apunta a otra conversación  NO  / destino_ajeno (UX-8)
//
//   Payload — `decidirPayload`
//     N-06 destino === chat por default ............. rama SIN chat_id (default)
//     N-07 destino distinto y el ancla lo acepta .... rama CON chat_id (dirigido)
//     N-08 el ancla rechaza el destino .............. descarta + registra
//     N-09 ancla VACÍA + destino ≠ default .......... descarta + registra
//          (ancla vacía + destino === default ⇒ N-06: sale de verdad)
//     N-10 `anchorAccepts` no inyectado ............. descarta (fail-closed)
//
//   Plan — `planNotices`
//     N-11 una conversación con 1 huérfano .......... H1_respuesta_perdida
//     N-12 una conversación con ≥2 huérfanos ........ H3_varias_respuestas_perdidas
//     N-13 tope de conversaciones excedido .......... diferido (ni ledger ni cola)
//     N-16 el renderer tira ......................... descarta + registra
//
//   I/O — `emitOrphanNotices` / `reconcileNoticeDelivery`
//     N-14 el ledger no se puede escribir ........... NO se encola (fail-closed)
//     N-15 el ref ya está en el ledger .............. 0 avisos (idempotencia)
//     N-17 el saliente quedó 'fallido' .............. aviso_entregado:false
//     N-18 'enviado'/'encolado'/'unknown' ........... no se toca el sidecar
//
// -----------------------------------------------------------------------------
// Forma del módulo: NÚCLEO PURO + capa de I/O (mismo patrón que orphan-sweep).
//
//   `resolveNoticeTarget` / `decidirPayload` / `planNotices`
//        no leen disco, no miran el reloj, no tocan `process.env`, no conocen
//        secretos. Todo lo que huele a proceso entra por `deps`.
//
//   `readNotifiedRefs` / `appendNotifiedRefs` / `emitOrphanNotices` /
//   `reconcileNoticeDelivery`  hacen I/O, y son best-effort: NUNCA tiran.
//
// `resolveChatIdForCorrelation`, `anchorAccepts`, `outboundStatus`,
// `enqueueOrphanNotice` y `newCorrelationId` entran INYECTADOS. Requerir
// `pulpo.js` desde `lib/` es un ciclo y arranca el mundo adentro de un test;
// además `resolveChatIdForCorrelation` sólo se exporta bajo
// `PULPO_NO_AUTOSTART=1`, así que ni siquiera sería alcanzable.
//
// -----------------------------------------------------------------------------
// Seguridad:
//   SEC-A · El destino NUNCA sale del nombre del archivo de log. Sale de la
//           correlación o de la etapa `transcripción` del canal estructurado
//           (no falsificable), y siempre pasa por `canonicalChatId`.
//   SEC-B · El ledger NO guarda el `reqId` crudo (que contiene el chat id) ni
//           el `chat_id` crudo. Sólo el ref seudonimizado `buildAuditReqRef`.
//   SEC-C · El identificador VISIBLE sí es el `reqId` crudo (D-1): es el único
//           puntero que un humano puede usar. Lo compensa la guarda UX-8 (N-05):
//           el único receptor posible es la conversación cuyo chat id ya está
//           adentro de ese string.
//   SEC-D · Fail-closed en cadena: sin ancla, sin ledger, sin destino o sin
//           renderer ⇒ NO se encola. Un aviso que no se puede mandar bien es
//           mejor no mandarlo que mandarlo al lugar equivocado.
//   SEC-E · Tope por pasada: un burst no puede convertir el canal del operador
//           en un self-DoS con un mensaje que dice "no lo repitas".
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

// UX-4 — fuente única del texto visible. Path resuelto desde `lib/commander/`.
const render = require('../../assets/copy/orphan-turn/render');

const { buildAuditReqRef, updateRequestMeta: updateRequestMetaReal } = require('./request-log');

// -----------------------------------------------------------------------------
// Constantes.
// -----------------------------------------------------------------------------

// Ledger append-only de idempotencia. Vive en `.pipeline/audit/` (ya ignorado
// por `.gitignore:347`) y NO en un directorio nuevo: `.pipeline/estado/` no
// existe, no está ignorado y se commitearía.
const LEDGER_DIR = 'audit';
const LEDGER_FILE = 'commander-orphan-notified.jsonl';

// SEC-E / D-3 — tope por pasada, medido en CONVERSACIONES (no en huérfanos).
// Excedido el tope las conversaciones sobrantes NO se notifican y NO se escriben
// al ledger ⇒ salen en la pasada siguiente (~5 min). Es DIFERIMIENTO, no
// resumen: juntar pedidos de varias conversaciones en un mismo mensaje viola
// UX-8 (le contás a un operador el pedido de otro) y es peor que la demora.
const ORPHAN_NOTICE_MAX_PER_SWEEP = 5;

const AVISO_SIMPLE = 'H1_respuesta_perdida';
const AVISO_CONSOLIDADO = 'H3_varias_respuestas_perdidas';

// Prefijo del correlation_id de los avisos, para distinguirlos de los salientes
// normales del Commander (`cmd-`) en el historial y en los recibos.
const NOTICE_CORRELATION_PREFIX = 'orph';

// Texto que va al historial en lugar del aviso. El historial se inyecta verbatim
// al contexto del Commander: meter ahí el texto del aviso haría que el modelo lo
// lea como si fuera parte de la conversación.
const NOTICE_HISTORY_TEXT = '[aviso de respuesta perdida]';

// -----------------------------------------------------------------------------
// canonicalChatId — MISMA regla que `lib/notify-telegram.js:104`.
//
// Se reimplementa (3 líneas) en vez de requerir ese módulo porque el núcleo de
// acá es PURO y `notify-telegram.js` lee `process.env` al cargarse. La regla es
// la del transporte de Telegram (entero, sin ceros a la izquierda, negativo para
// grupos) y no tiene por qué cambiar; si cambiara allá, el test la ancla.
//
// @returns {string|null} `null` = no es un chat id (fail-closed).
// -----------------------------------------------------------------------------
function canonicalChatId(value) {
  if (typeof value !== 'string' || !/^-?[1-9]\d*$/.test(value)) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? String(numeric) : null;
}

// -----------------------------------------------------------------------------
// resolveNoticeTarget — A QUÉ CONVERSACIÓN VA EL AVISO (N-01..N-05).
//
// Dos pasos, en este orden, y NUNCA el nombre del archivo:
//   1. si el turno llegó a tener `correlation_id` ⇒ `resolveChatIdForCorrelation`
//      sobre el historial (la entry `out` es la única que lleva el chat id);
//   2. si no —el caso TÍPICO del huérfano, que murió antes del envío— ⇒ el
//      `chat_id` de la etapa `transcripción` del canal estructurado.
//
// `parseReqIdParts(reqId).chatSeg` está implementado y exportado en
// `orphan-sweep.js`, devuelve algo con pinta de chat id válido y es el atajo que
// parece razonable. NO se usa: el nombre del archivo es un dato de presentación,
// no una fuente de verdad, y basta con renombrar un `.log` para redirigir el
// aviso de un operador a la conversación de otro.
//
// @param {object} args
// @param {object} args.result       veredicto de `classifyRequest` (`chatId`, `reqId`, …).
// @param {string|null} args.cid     correlation_id del turno, o `null`/'DIRECTO'.
// @param {string} args.historyRaw   `commander-history.jsonl` crudo.
// @param {object} args.deps         `{ resolveChatIdForCorrelation }`.
// @returns {{ok:boolean, chatId:string|null, via:string|null, motivo:string|null}}
// -----------------------------------------------------------------------------
function resolveNoticeTarget(args) {
  const { result, cid, historyRaw, deps } = (args && typeof args === 'object') ? args : {};
  const r = (result && typeof result === 'object') ? result : {};
  const d = (deps && typeof deps === 'object') ? deps : {};

  // Paso 1 — correlación. 'DIRECTO' es el centinela de `correlationIdFromStages`
  // para "hubo saliente pero sin reconciliación posible": NO es un correlation_id
  // real y consultarlo devolvería basura (N-03).
  let crudo = null;
  let via = null;
  if (cid && cid !== 'DIRECTO' && typeof d.resolveChatIdForCorrelation === 'function') {
    try {
      const v = d.resolveChatIdForCorrelation(historyRaw || '', cid);
      // El historial guarda el chat id CRUDO tal como vino del JSONL: puede ser
      // número, string, o cualquier cosa si la línea está corrupta.
      if (v != null && (typeof v === 'string' || typeof v === 'number')) {
        crudo = String(v);
        via = 'correlacion';
      }
    } catch { /* best-effort: degradamos al paso 2 */ }
  }

  // Paso 2 — etapa `transcripción` (N-02).
  if (crudo == null && r.chatId != null && r.chatId !== '') {
    crudo = String(r.chatId);
    via = 'etapa';
  }

  const destino = canonicalChatId(crudo == null ? null : String(crudo));
  // N-04 — sin destino canónico no se adivina: se descarta y se registra.
  if (!destino) return { ok: false, chatId: null, via: null, motivo: 'destino_no_resoluble' };

  // N-05 / UX-8 — GUARDA NEGATIVA. Si la correlación resolvió a una conversación
  // distinta de la del pedido, el aviso NO sale. Un aviso "por las dudas" le
  // cuenta a un operador el pedido de otro, y el identificador de sesión que
  // lleva adentro ES el chat id del dueño real.
  //
  // Ojo con el caso `r.chatId` basura: `canonicalChatId` devuelve `null`, la
  // comparación falla y se descarta. Es lo correcto — con la etapa corrupta no
  // hay forma de afirmar que el destino resuelto es el dueño del pedido, y el
  // fallback tentador (el `chatSeg` del nombre del archivo) es justo el que
  // SEC-A prohíbe.
  if (r.chatId != null && r.chatId !== '') {
    const delPedido = canonicalChatId(String(r.chatId));
    if (delPedido !== destino) {
      return { ok: false, chatId: null, via, motivo: 'destino_ajeno' };
    }
  }

  return { ok: true, chatId: destino, via, motivo: null };
}

// -----------------------------------------------------------------------------
// decidirPayload — LAS DOS RAMAS DEL DROPFILE (N-06..N-10).
//
// Ver "LA TRAMPA DEL ANCLA" en la cabecera. En una frase: `buildDropfile` estampa
// `chat_id` siempre que se lo pasen, y un `chat_id` que el ancla rechaza muere
// archivado en `listo/` sin envío y sin recibo.
//
// La igualdad se compara contra `getTelegramChatId()` (el chat id EFECTIVO del
// store de credenciales, que es el que `servicio-telegram.js:282` usa para armar
// `body = { chat_id: CHAT_ID, ...params }`), NO contra la env var del ancla. Son
// dos cosas distintas y confundirlas manda el aviso al chat equivocado.
//
// @param {object} args `{ destino, texto, defaultChatId, deps:{anchorAccepts} }`
// @returns {{ok:true, payload:object, modo:string}|{ok:false, motivo:string}}
// -----------------------------------------------------------------------------
function decidirPayload(args) {
  const { destino, texto, defaultChatId, deps } = (args && typeof args === 'object') ? args : {};
  const d = (deps && typeof deps === 'object') ? deps : {};

  // N-10 — sin el predicado real del ancla no se puede saber si el dropfile va a
  // sobrevivir. Fail-closed: no se encola (SEC-D).
  if (typeof d.anchorAccepts !== 'function') {
    return { ok: false, motivo: 'anchor_no_disponible' };
  }
  const acepta = (x) => { try { return d.anchorAccepts(x) === true; } catch { return false; } };

  const porDefecto = canonicalChatId(String(defaultChatId == null ? '' : defaultChatId));

  try {
    // N-06 — el destino ES el chat por default ⇒ dropfile SIN `chat_id`.
    // `resolvePrivateChatId(null)` devuelve `{ok:true, chatId:null}`: es el único
    // camino que el ancla no puede rechazar. El `null` va EXPLÍCITO — omitir el
    // argumento tira a propósito, porque caer al default por descuido es adivinar
    // un destino.
    if (porDefecto && destino === porDefecto && acepta(null)) {
      return { ok: true, payload: render.buildDropfile(texto, null), modo: 'default' };
    }
    // N-07 — otra conversación (o no se pudo comprobar la igualdad) ⇒ viaja el
    // campo y lo valida el ancla, que es el MISMO predicado que va a aplicar
    // `servicio-telegram.js`. Se reusa la función, no se reimplementa la regla.
    if (acepta(destino)) {
      return { ok: true, payload: render.buildDropfile(texto, destino), modo: 'dirigido' };
    }
  } catch (e) {
    // `buildDropfile` es fail-closed con destinos inválidos: tira en vez de
    // inventar. Acá eso se traduce en descarte, nunca en un encolado a ciegas.
    return { ok: false, motivo: `dropfile_invalido:${(e && e.message) || 'desconocido'}` };
  }

  // N-08 / N-09 — el ancla rechaza el destino. NUNCA se encola: se archivaría en
  // `listo/` como si se hubiera enviado, que es el bug de #6440 por otra puerta.
  //
  // Con `TELEGRAM_LEO_OPERATOR_CHAT_ID` VACÍO este es el caso de todo destino
  // que no sea el chat por default (ese se fue por N-06, que no pasa por el
  // ancla). O sea: sin ancla configurada, el aviso llega al operador del canal
  // de salida y NADIE MÁS. Fail-closed y correcto — la alternativa sería
  // encolar un dropfile que muere archivado sin recibo.
  return { ok: false, motivo: 'destino_rechazado_por_anchor' };
}

// -----------------------------------------------------------------------------
// planNotices — NÚCLEO PURO del plan de avisos (N-11..N-13, N-16).
//
// Agrupa los huérfanos de la pasada POR DESTINO (UX-6: un aviso por pasada y por
// conversación), aplica el tope y renderiza el texto con el renderer de UX.
//
// @param {object} args
// @param {Array<object>} args.huerfanos    veredictos HUERFANO de `detectOrphans`.
// @param {Map<string,object>} args.targets reqId → salida de `resolveNoticeTarget`.
// @param {number} args.nowMs               reloj inyectado (el renderer es puro).
// @param {string} args.defaultChatId       `getTelegramChatId()`, inyectado.
// @param {number} [args.tope]              default `ORPHAN_NOTICE_MAX_PER_SWEEP`.
// @param {object} [args.deps]              `{ anchorAccepts }`.
// @returns {{avisos:Array<object>, descartados:Array<object>, diferidos:Array<object>}}
// -----------------------------------------------------------------------------
function planNotices(args) {
  const {
    huerfanos,
    targets,
    nowMs,
    defaultChatId,
    tope = ORPHAN_NOTICE_MAX_PER_SWEEP,
    deps = {},
  } = (args && typeof args === 'object') ? args : {};

  const avisos = [];
  const descartados = [];
  const diferidos = [];

  const lista = Array.isArray(huerfanos) ? huerfanos : [];
  const mapa = (targets && typeof targets.get === 'function') ? targets : new Map();

  // 1 · Agrupar por destino, en orden de primera aparición (determinístico: el
  //     barrido enumera el directorio en orden estable y el núcleo lo respeta).
  const grupos = new Map();
  for (const r of lista) {
    if (!r || typeof r !== 'object') continue;
    const ref = r.auditRef || buildAuditReqRef(r.reqId);
    // Sin ref no hay clave de idempotencia posible ⇒ el aviso se re-emitiría en
    // cada pasada. Se descarta y se registra (SEC-D).
    if (!ref) { descartados.push({ ref: null, reqId: null, motivo: 'sin_ref_de_audit' }); continue; }

    const t = mapa.get(r.reqId);
    if (!t || !t.ok) {
      descartados.push({ ref, reqId: r.reqId, motivo: (t && t.motivo) || 'destino_no_resoluble' });
      continue;
    }
    if (!grupos.has(t.chatId)) grupos.set(t.chatId, []);
    grupos.get(t.chatId).push({ r, ref });
  }

  // 2 · Tope por pasada (N-13). Diferimiento, NO resumen: lo que no entra sale
  //     en la pasada siguiente porque no se escribe al ledger.
  const limite = (Number.isFinite(tope) && tope > 0) ? Math.floor(tope) : ORPHAN_NOTICE_MAX_PER_SWEEP;
  let i = 0;
  for (const [destino, miembros] of grupos) {
    i += 1;
    if (i > limite) {
      diferidos.push({ destino, refs: miembros.map((m) => m.ref), motivo: 'tope_por_pasada' });
      continue;
    }

    // 3 · Consolidación (N-11 / N-12). El texto sale SIEMPRE de `renderAviso`,
    //     nunca de literales en producción (UX-4).
    //     Los pedidos se listan del más reciente al más viejo: el renderer sólo
    //     muestra los primeros 3 y resume el resto, así que el orden decide qué
    //     ve el operador.
    const pedidos = miembros
      .map((m) => ({ sesion: String(m.r.reqId), iniciadoEn: Number(m.r.epochms) }))
      .sort((a, b) => b.iniciadoEn - a.iniciadoEn);

    const aviso = pedidos.length >= 2 ? AVISO_CONSOLIDADO : AVISO_SIMPLE;
    const datos = pedidos.length >= 2 ? { pedidos } : pedidos[0];

    let texto;
    try {
      // N-16 — el renderer es fail-closed: un identificador que no matchea
      // `SESION_RE`, un `iniciadoEn` inválido o un aviso desconocido TIRAN en
      // vez de degradar a un texto genérico. Un aviso mudo es mejor que un
      // aviso equivocado, y un identificador inventado manda al operador a
      // buscar un registro que no existe.
      texto = render.renderAviso(aviso, datos, { now: Number(nowMs) });
    } catch (e) {
      for (const m of miembros) {
        descartados.push({
          ref: m.ref,
          reqId: m.r.reqId,
          motivo: `render_fallido:${(e && e.message) || 'desconocido'}`,
        });
      }
      continue;
    }

    const decision = decidirPayload({ destino, texto, defaultChatId, deps });
    if (!decision.ok) {
      for (const m of miembros) {
        descartados.push({ ref: m.ref, reqId: m.r.reqId, motivo: decision.motivo });
      }
      continue;
    }

    avisos.push({
      aviso,
      destino,
      modo: decision.modo,
      payload: decision.payload,
      texto,
      refs: miembros.map((m) => m.ref),
      reqIds: miembros.map((m) => m.r.reqId),
    });
  }

  return { avisos, descartados, diferidos };
}

// =============================================================================
// CAPA DE I/O — best-effort, NUNCA tira.
// =============================================================================

function ledgerPath(pipelineDir) {
  return path.join(pipelineDir || '.', LEDGER_DIR, LEDGER_FILE);
}

// -----------------------------------------------------------------------------
// readLedgerEntries — entradas del ledger, opcionalmente acotadas por ventana.
//
// FAIL-CLOSED para idempotencia: si el archivo existe y NO se puede leer,
// devolvemos `{ok:false}` y el caller NO emite nada. Fail-open acá sería
// re-notificar en cada pasada — una tormenta de mensajes que dicen "no lo
// repitas" justo cuando el canal está en problemas.
//
// El archivo ausente NO es un fallo: es el primer arranque.
// -----------------------------------------------------------------------------
function readLedgerEntries({ pipelineDir, nowMs, windowMs, fsImpl } = {}) {
  const _fs = fsImpl || fs;
  if (!pipelineDir) return { ok: true, entries: [] };
  const file = ledgerPath(pipelineDir);
  let raw;
  try {
    if (typeof _fs.existsSync === 'function' && !_fs.existsSync(file)) return { ok: true, entries: [] };
    raw = _fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, entries: [], error: (e && e.message) || 'ilegible' };
  }
  const entries = [];
  const acotar = Number.isFinite(nowMs) && Number.isFinite(windowMs);
  for (const linea of String(raw).split('\n')) {
    const t = linea.trim();
    if (!t) continue;
    let e;
    try { e = JSON.parse(t); } catch { continue; }
    if (!e || typeof e !== 'object' || !e.ref) continue;
    if (acotar && Number.isFinite(e.timestamp) && (nowMs - e.timestamp) > windowMs) continue;
    entries.push(e);
  }
  return { ok: true, entries };
}

// -----------------------------------------------------------------------------
// readNotifiedRefs — el `notified` que `detectOrphans` ya acepta desde #6459.
//
// A propósito SIN filtro de ventana: la clave de idempotencia tiene que vivir al
// menos tanto como la ventana del barrido, y una entrada de más sólo cuesta un
// aviso no repetido. El archivo lleva UNA línea por huérfano avisado — un evento
// excepcional por definición.
//
// @returns {Set<string>} refs SEUDONIMIZADAS ya avisadas. Vacío si falló la
//          lectura; el caller consulta `readLedgerEntries().ok` para decidir.
// -----------------------------------------------------------------------------
function readNotifiedRefs({ pipelineDir, fsImpl } = {}) {
  const { entries } = readLedgerEntries({ pipelineDir, fsImpl });
  const refs = new Set();
  for (const e of entries) refs.add(String(e.ref));
  return refs;
}

// -----------------------------------------------------------------------------
// appendNotifiedRefs — marca de idempotencia, ANTES de encolar (R1 / REQ-SEC-C).
//
// El orden importa y no es negociable: si el proceso muere entre el append y el
// encolado, el peor caso es UN aviso perdido. Al revés (encolar primero) el peor
// caso es una TORMENTA: cada pasada re-notifica hasta que el ledger se escriba.
//
// El aviso consolidado appendea UNA LÍNEA POR REF antes del único dropfile: si
// el proceso muere en el medio se duplica un aviso, nunca se pierde uno.
//
// SEC-B — acá NO va el `reqId` crudo (que contiene el chat id de Telegram) ni el
// `chat_id`. Sólo el ref seudonimizado. Es la superficie persistente y el vector
// real de A02.
//
// @returns {boolean} `false` ⇒ el caller NO encola (fail-closed, REQ-SEC-E).
// -----------------------------------------------------------------------------
function appendNotifiedRefs({ pipelineDir, entries, fsImpl } = {}) {
  const _fs = fsImpl || fs;
  if (!pipelineDir) return false;
  const lista = Array.isArray(entries) ? entries : [];
  if (lista.length === 0) return true;
  const file = ledgerPath(pipelineDir);
  try {
    // `.pipeline/audit/` puede no existir todavía (primer arranque). `recursive`
    // hace esto idempotente y no tira si ya está.
    _fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = lista.map((e) => JSON.stringify({
      timestamp: Number(e.timestamp) || 0,
      ref: String(e.ref),
      aviso: String(e.aviso || ''),
      correlation_id: String(e.correlationId || ''),
      modo: String(e.modo || ''),
    })).join('\n') + '\n';
    _fs.appendFileSync(file, payload, 'utf8');
    return true;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// emitOrphanNotices — resuelve destinos, planifica, persiste y encola.
//
// Se llama SÓLO si el wiring inyectó `enqueueOrphanNotice`. Sin wiring el barrido
// se comporta exactamente como en #6459.
//
// @param {object} args
// @param {string} args.pipelineDir
// @param {Array<object>} args.huerfanos   veredictos HUERFANO de la pasada.
// @param {Map<string,string|null>} args.cidPorReq  reqId → correlation_id.
// @param {string} args.historyRaw
// @param {number} args.nowMs
// @param {object} args.deps  `{ resolveChatIdForCorrelation, anchorAccepts,
//                              enqueueOrphanNotice, newCorrelationId, defaultChatId,
//                              log, fsImpl, tope }`
// @returns {{emitidos:number, refs:Array<string>, descartados:Array<object>, diferidos:number}}
// -----------------------------------------------------------------------------
function emitOrphanNotices(args) {
  const {
    pipelineDir, huerfanos, cidPorReq, historyRaw, nowMs, deps = {},
  } = (args && typeof args === 'object') ? args : {};

  const _log = typeof deps.log === 'function' ? deps.log : () => {};
  const _fs = deps.fsImpl || fs;
  const vacio = { emitidos: 0, refs: [], descartados: [], diferidos: 0 };

  if (typeof deps.enqueueOrphanNotice !== 'function') return vacio;
  if (typeof deps.newCorrelationId !== 'function') {
    _log('[orphan-notify] sin generador de correlación inyectado — no se emite ningún aviso');
    return vacio;
  }

  const lista = Array.isArray(huerfanos) ? huerfanos : [];
  if (lista.length === 0) return vacio;

  // Idempotencia (N-15). FAIL-CLOSED: un ledger ilegible NO habilita avisos.
  const ledger = readLedgerEntries({ pipelineDir, fsImpl: _fs });
  if (!ledger.ok) {
    _log(`[orphan-notify] ledger de idempotencia ilegible (${ledger.error}) — no se emite ningún aviso`);
    return vacio;
  }
  const yaAvisados = new Set(ledger.entries.map((e) => String(e.ref)));

  const pendientes = lista.filter((r) => {
    const ref = r && (r.auditRef || buildAuditReqRef(r.reqId));
    return ref ? !yaAvisados.has(ref) : true;
  });
  if (pendientes.length === 0) return vacio;

  // Destinos (N-01..N-05).
  const targets = new Map();
  const mapaCid = (cidPorReq && typeof cidPorReq.get === 'function') ? cidPorReq : new Map();
  for (const r of pendientes) {
    targets.set(r.reqId, resolveNoticeTarget({
      result: r,
      cid: mapaCid.get(r.reqId) || null,
      historyRaw,
      deps: { resolveChatIdForCorrelation: deps.resolveChatIdForCorrelation },
    }));
  }

  const plan = planNotices({
    huerfanos: pendientes,
    targets,
    nowMs,
    defaultChatId: deps.defaultChatId,
    tope: deps.tope,
    deps: { anchorAccepts: deps.anchorAccepts },
  });

  // Un descarte NUNCA es silencioso (CA "se descarta y se registra"). Se loguea
  // el ref SEUDONIMIZADO, no el reqId crudo (SEC-B).
  for (const d of plan.descartados) {
    _log(`[orphan-notify] aviso descartado (${d.motivo}) para ${d.ref || 'turno sin ref'} — no se envió a ningún destino`);
  }
  for (const d of plan.diferidos) {
    _log(`[orphan-notify] ${d.refs.length} aviso(s) diferidos a la pasada siguiente por tope (${d.motivo})`);
  }

  const refs = [];
  let emitidos = 0;
  for (const a of plan.avisos) {
    let correlationId = '';
    try { correlationId = String(deps.newCorrelationId(NOTICE_CORRELATION_PREFIX) || ''); }
    catch { correlationId = ''; }
    if (!correlationId) {
      _log(`[orphan-notify] sin correlación para el aviso de ${a.refs.length} pedido(s) — no se encola (no habría cómo cerrarlo)`);
      continue;
    }

    // ANTES de encolar (N-14). Si el ledger no se puede escribir, NO se encola.
    const ok = appendNotifiedRefs({
      pipelineDir,
      fsImpl: _fs,
      entries: a.refs.map((ref) => ({
        timestamp: Number(nowMs) || 0, ref, aviso: a.aviso, correlationId, modo: a.modo,
      })),
    });
    if (!ok) {
      _log('[orphan-notify] no pude escribir el ledger de idempotencia — el aviso NO se encola (evita re-notificar en bucle)');
      continue;
    }

    try {
      deps.enqueueOrphanNotice(a.payload, { correlationId, chatId: a.destino });
      emitidos += 1;
      refs.push(...a.refs);
    } catch (e) {
      // El ledger ya está escrito: este aviso no se reintenta. Es el trade-off
      // elegido (silencio acotado > tormenta) y queda registrado.
      _log(`[orphan-notify] no pude encolar el aviso: ${(e && e.message) || 'desconocido'}`);
    }
  }

  return { emitidos, refs, descartados: plan.descartados, diferidos: plan.diferidos.length };
}

// -----------------------------------------------------------------------------
// reconcileNoticeDelivery — DEAD-LETTER VISIBLE (pasada N+1).
//
// El aviso se encoló con un `correlation_id` y su entry `out` en el historial. El
// `reconcileTelegramReceipts` que YA corre en el loop lo cierra a
// `enviado`|`fallido` con el recibo de `svc-telegram` (el veredicto sale del
// canal de salida, nunca del texto del modelo — #3951). Esta pasada lee ese
// estado y, si es `fallido`, lo hace VISIBLE en la fila del pedido.
//
// Cero mecanismos nuevos: reusa el ledger, el historial y el reconcile existentes.
//
// El mapeo `ref → reqId` se rearma EN MEMORIA con los reqIds de la ventana (los
// que el barrido ya enumeró). El reqId crudo NUNCA se persiste (SEC-B).
//
// @returns {{marcados:number}}
// -----------------------------------------------------------------------------
function reconcileNoticeDelivery(args) {
  const {
    pipelineDir, logDir, historyRaw, nowMs, windowMs, reqIdsEnVentana, deps = {},
  } = (args && typeof args === 'object') ? args : {};

  const _log = typeof deps.log === 'function' ? deps.log : () => {};
  const _fs = deps.fsImpl || fs;
  const _update = typeof deps.updateRequestMeta === 'function'
    ? deps.updateRequestMeta : updateRequestMetaReal;
  const outbound = typeof deps.outboundStatus === 'function' ? deps.outboundStatus : null;
  if (!outbound || !logDir) return { marcados: 0 };

  const { ok, entries } = readLedgerEntries({ pipelineDir, nowMs, windowMs, fsImpl: _fs });
  if (!ok || entries.length === 0) return { marcados: 0 };

  // ref → reqId, en memoria y sólo para los turnos que el barrido ya vio.
  const refToReq = new Map();
  for (const reqId of (Array.isArray(reqIdsEnVentana) ? reqIdsEnVentana : [])) {
    const ref = buildAuditReqRef(reqId);
    if (ref && !refToReq.has(ref)) refToReq.set(ref, reqId);
  }

  let marcados = 0;
  for (const e of entries) {
    if (!e.correlation_id) continue;
    let estado = 'unknown';
    try { estado = String(outbound(historyRaw || '', e.correlation_id) || 'unknown'); } catch { continue; }
    // N-18 — 'enviado' (llegó), 'encolado' (todavía no se sabe) y 'unknown' (sin
    // rastro) NO tocan el sidecar: afirmar la no-entrega desde la ausencia de
    // rastro es afirmar un hecho no observado (SEC-0/B5 de #6459).
    if (estado !== 'fallido') continue;

    const reqId = refToReq.get(String(e.ref));
    if (!reqId) continue; // el turno salió de la ventana: nada que pintar.
    // N-17 — merge-aware: `writeRequestMeta` sobreescribiría el sidecar entero y
    // borraría el `resultado`/`provider` que dejó #6459 (adiós al badge huérfano).
    // Si el sidecar no existe —el caso típico, porque el proceso murió antes de
    // cerrar el turno— se crea con `resultado: 'huerfano'`; si ya existe con un
    // `resultado`, ese valor NO se pisa (precedencia de #6459 CA-1).
    const escrito = _update(logDir, reqId, { resultado: 'huerfano', aviso_entregado: false });
    if (escrito) marcados += 1;
  }

  if (marcados > 0) {
    _log(`[orphan-notify] ${marcados} aviso(s) no entregado(s) marcados en el panel para que el operador los vea`);
  }
  return { marcados };
}

module.exports = {
  // núcleo puro
  resolveNoticeTarget,
  decidirPayload,
  planNotices,
  canonicalChatId,
  // capa de I/O
  readLedgerEntries,
  readNotifiedRefs,
  appendNotifiedRefs,
  emitOrphanNotices,
  reconcileNoticeDelivery,
  ledgerPath,
  // constantes
  ORPHAN_NOTICE_MAX_PER_SWEEP,
  AVISO_SIMPLE,
  AVISO_CONSOLIDADO,
  NOTICE_CORRELATION_PREFIX,
  NOTICE_HISTORY_TEXT,
  LEDGER_FILE,
};
