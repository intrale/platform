// =============================================================================
// request-log.js — Log por petición atendida del Commander (#3949 / EP7-H2).
//
// Un archivo `logs/commander-<id>.log` por turno consolidado del Commander, con
// el mismo esquema de seguimiento que los logs de agentes de issue
// (`logs/<issue>-<skill>.log`). Registra las 4 etapas del flujo del Commander:
//   1. transcripción (con eco STT)
//   2. dispatch/provider
//   3. Sherlock (veredicto)
//   4. envío
//
// Requisitos de seguridad incorporados (security — fase análisis EP7-H2):
//   SEC-1: la escritura del `.log` SIEMPRE pasa por `createLogFileWriter`
//          (stream sanitizado). NUNCA `fs.appendFileSync` crudo — saltearía la
//          redacción de secretos heredada del sanitizer (#2333/#2334).
//          EXCEPCIÓN ACOTADA (#6458 / D1): el canal estructurado de etapas
//          (`commander-<reqId>.stages.jsonl`) SÍ usa `fs.appendFileSync`, con
//          la condición INEXCUSABLE de aplicar `sanitize()` POR VALOR y ANTES
//          de `JSON.stringify`. El motivo es de durabilidad: el stream
//          sanitizado retiene >=256 B en su ventana deslizante y sólo vuelca en
//          `flush()`/`close()`, así que un turno que muere sin `close()` dejaba
//          el archivo en 0 bytes — justo el escenario huérfano que la evidencia
//          tiene que cubrir. El `.log` sigue 100% por stream.
//   SEC-2: el eco STT / texto del comando se escribe vía el `writable`
//          sanitizado, igual que `appendCommanderHistory` redacta in/out.
//   SEC-3: la etapa dispatch NUNCA serializa el objeto de config de providers
//          (API keys). Sólo strings: intent_class + nombre de provider + modelo.
//   SEC-4: el `<id>` se restringe a `[a-zA-Z0-9-]` para que la whitelist
//          anti-traversal del viewer (`dashboard.js`) no lo deforme y el match
//          archivo↔link se mantenga.
//
// El módulo es determinístico y testeable: `pulpo.js` no se puede unit-testear
// levantando el proceso, así que toda la lógica de naming + apertura + cabeceras
// + cierre vive acá (patrón de los otros módulos de `lib/commander/`).
// =============================================================================
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createLogFileWriter } = require('../sanitize-log-stream');
// #6458 — redacción POR VALOR del canal estructurado de etapas (REQ-SEC-3).
const { sanitize } = require('../../sanitizer');

// SEC-4: caracteres permitidos en el `<id>`. El chat_id de grupos de Telegram es
// negativo, así que el '-' está explícitamente permitido. Cualquier otro
// carácter se elimina (no se sustituye) para no inflar el id ni introducir
// colisiones por mapeo a un mismo placeholder.
const ID_SAFE_RE = /[^a-zA-Z0-9-]/g;

// =============================================================================
// #6458 — Canal estructurado de etapas (`commander-<reqId>.stages.jsonl`).
//
// El `.log` de texto plano es FALSIFICABLE: `stage()` escribe cabeceras
// `--- etapa:<n> req:<id> <iso> ---` en el MISMO canal donde `line()` vuelca el
// mensaje entrante y la salida CRUDA del LLM. Un texto del modelo que contenga
// un delimitador forjado es indistinguible de una etapa real (SEC-1 del épico).
//
// La solución es de CONSTRUCCIÓN, no de disciplina: el único lugar que conoce
// el path del `.stages.jsonl` es el closure de `stage()` dentro de
// `openRequestLog`. `line()` no recibe handle ni path, así que no puede
// escribirlo aunque quiera, y el objeto de retorno no lo expone (REQ-SEC-4).
// =============================================================================

// CWE-1321 — claves que jamás se copian a un objeto plano (ni al escribir ni al
// leer). Se descartan en escritura y descalifican la entrada entera en lectura.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Las claves de metadata de una etapa son identificadores acotados. Cualquier
// otra cosa (claves con puntos, espacios, unicode) se descarta: el canal es
// evidencia forense, no un almacén genérico.
const STAGE_KEY_RE = /^[a-z_][a-z0-9_]*$/i;

/**
 * Nombre de archivo (sin directorio) del canal estructurado de etapas.
 *
 * REQ-SEC-5: usa EXACTAMENTE el mismo `ID_SAFE_RE` que `metaFileName`, así que
 * `stagesFileName('../../etc/x')` no puede contener `/` ni `..`. El path se
 * arma SIEMPRE vía esta función, nunca concatenando el reqId crudo.
 *
 * Comparte el prefijo `commander-<reqId>.` con el `.log` y el `.meta.json` para
 * que la poda de logs viejos barra los tres juntos.
 *
 * @param {string} reqId
 * @returns {string}
 */
function stagesFileName(reqId) {
  const safeId = String(reqId == null ? '' : reqId).replace(ID_SAFE_RE, '');
  return `commander-${safeId}.stages.jsonl`;
}

/**
 * Construye un `<id>` filename-safe para el log de una petición.
 *
 * Formato: `<chat_id>-<epochms>`. Un único id por turno consolidado (no por
 * mensaje individual) evita generar N archivos para un mismo turno. El `epochms`
 * desambigua turnos concurrentes del mismo chat.
 *
 * @param {string|number} chatId  chat_id de Telegram (puede ser negativo).
 * @param {number} nowMs          timestamp epoch en ms (inyectado para testear).
 * @param {string} [suffix]       sufijo opcional (ej. turnId hex) para romper
 *                                empates si dos turnos del mismo chat caen en el
 *                                mismo ms.
 * @returns {string} id que matchea `^[a-zA-Z0-9-]+$`.
 */
function buildRequestId(chatId, nowMs, suffix) {
  const safeChat = String(chatId == null ? 'unknown' : chatId).replace(ID_SAFE_RE, '');
  const safeMs = String(nowMs == null ? 0 : nowMs).replace(ID_SAFE_RE, '');
  const base = `${safeChat || 'unknown'}-${safeMs}`;
  if (suffix) {
    const safeSuffix = String(suffix).replace(ID_SAFE_RE, '');
    if (safeSuffix) return `${base}-${safeSuffix}`;
  }
  return base;
}

/**
 * Devuelve el nombre de archivo (sin directorio) para un reqId dado.
 * @param {string} reqId
 * @returns {string}
 */
function logFileName(reqId) {
  return `commander-${reqId}.log`;
}

/**
 * Abre el log de una petición. Hereda la redacción del stream sanitizado
 * (SEC-1): toda escritura va por el `writable` del `createLogFileWriter`.
 *
 * @param {string} logDir  directorio de logs (ej. `.pipeline/logs`).
 * @param {string} reqId   id ya construido con `buildRequestId`.
 * @param {object} [opts]  opciones passthrough a `createLogFileWriter`
 *                         (ej. `{ silentFs: true }` en tests).
 * @returns {{
 *   reqId: string,
 *   fileName: string,
 *   path: string,
 *   writable: NodeJS.WritableStream,
 *   stage: (name: string, meta?: object) => void,
 *   line: (text: string) => void,
 *   close: () => Promise<void>,
 * }}
 */
function openRequestLog(logDir, reqId, opts) {
  const fileName = logFileName(reqId);
  const logPath = path.join(logDir, fileName);
  const { writable, close } = createLogFileWriter(logPath, opts);

  // #6458 — canal estructurado. `stagesPath` y `appendStage` viven en ESTE
  // closure y no salen de acá: `line()` no los recibe y el objeto de retorno no
  // los expone (REQ-SEC-4). SEC-1 pasa a ser verdadero por construcción.
  const stagesPath = path.join(logDir, stagesFileName(reqId));
  const appendStage = (name, meta, iso) => {
    // REQ-SEC-3: `sanitize()` se aplica POR VALOR y ANTES de `JSON.stringify`.
    // Al revés (sanitizar la línea ya serializada) rompería el escapado del
    // JSON y podría partir la entrada.
    const rec = { ts: String(iso || ''), req_id: String(reqId == null ? '' : reqId), etapa: sanitize(String(name == null ? '' : name)) };
    if (meta && typeof meta === 'object') {
      for (const k of Object.keys(meta)) {
        if (k === 'iso' || UNSAFE_KEYS.has(k) || !STAGE_KEY_RE.test(k)) continue;
        const v = meta[k];
        rec[k] = v == null ? '' : sanitize(String(v));
      }
    }
    // `JSON.stringify` escapa el salto de linea \n ⇒ una entrada NUNCA puede partirse en dos
    // líneas (SEC-3). `appendFileSync` ⇒ la entrada está en disco al volver de
    // `stage()`, aunque el turno muera sin `close()` (REQ-SEC-2 / D1).
    try {
      fs.appendFileSync(stagesPath, JSON.stringify(rec) + '\n');
    } catch { /* best-effort: el canal de evidencia jamás tira el turno */ }
  };

  // Cabecera de sección por etapa. Mismo estilo que la cabecera de los agentes
  // de issue (`--- skill:#issue fase:... ---`). El ISO timestamp se inyecta como
  // string ya formateado para mantener el helper determinístico/testeable.
  const stage = (name, meta) => {
    const iso = (meta && meta.iso) || new Date().toISOString();
    let header = `\n--- etapa:${name} req:${reqId} ${iso} ---\n`;
    if (meta) {
      for (const [k, v] of Object.entries(meta)) {
        if (k === 'iso') continue;
        // SEC-3: el caller es responsable de pasar SOLO strings/números, nunca
        // objetos de config. Acá serializamos defensivamente a string plano.
        header += `${k}: ${v == null ? '' : String(v)}\n`;
      }
    }
    try { writable.write(header); } catch { /* best-effort, no tira el turno */ }
    // #6458 — misma etapa, canal no falsificable. Va DESPUÉS de la cabecera
    // para no alterar el orden observable del `.log`.
    appendStage(name, meta, iso);
  };

  // Escritura de una línea de contenido dentro de una etapa. Pasa por el stream
  // sanitizado (SEC-1/SEC-2).
  //
  // #6458 — NO recibe `stagesPath` ni `appendStage`: acá se vuelca el mensaje
  // entrante y la salida CRUDA del LLM, así que un delimitador de etapa forjado
  // en ese texto no tiene forma de llegar al canal estructurado. PROHIBIDO
  // extender el canal estructurado a `line()` (volumen sin cota + falsificable).
  const line = (text) => {
    if (text == null) return;
    try { writable.write(`${String(text)}\n`); } catch { /* best-effort */ }
  };

  return { reqId, fileName, path: logPath, writable, stage, line, close };
}

// =============================================================================
// #3951 EP7-H4 — Sidecar de metadata por petición.
//
// Un `commander-<reqId>.meta.json` por turno, hermano del `.log`. Es la fuente
// que lee el render del dashboard SIN tener que parsear el cuerpo del log. El
// shape es ACOTADO a strings/booleans del enum clasificado (resultado/provider/
// flags de verificación) — NUNCA el objeto de config de providers (SEC-3,
// heredado de este módulo). El `<reqId>` reutiliza `ID_SAFE_RE` para el nombre.
// =============================================================================

/**
 * Devuelve el nombre de archivo (sin directorio) del sidecar de metadata para
 * un reqId dado. Mismo prefijo `commander-` que el `.log` para que el cleanup
 * de logs viejos lo barra junto con su par.
 * @param {string} reqId
 * @returns {string}
 */
function metaFileName(reqId) {
  const safeId = String(reqId == null ? '' : reqId).replace(ID_SAFE_RE, '');
  return `commander-${safeId}.meta.json`;
}

/**
 * Persiste el sidecar de metadata clasificada de una petición. Idempotente
 * (sobreescribe). Best-effort: NUNCA tira (el cierre del turno no puede morir
 * por un fallo de escritura de metadata).
 *
 * SEC: el shape se acota explícitamente a un subconjunto de campos del enum
 * clasificado. NO se serializa el objeto recibido tal cual — se reconstruye un
 * objeto plano con sólo los campos esperados, coaccionados a string/boolean.
 * Así un caller equivocado no puede filtrar config de providers ni secretos.
 *
 * `sameProviderVerification` es TRI-ESTADO: se persiste SÓLO si es un boolean
 * real; `null`/ausente (no hubo verificación efectiva de Sherlock) ⇒ el campo
 * se OMITE para que el render no emita chip cross/same (CA-3).
 *
 * @param {string} logDir  directorio de logs (ej. `.pipeline/logs`).
 * @param {string} reqId   id ya construido con `buildRequestId`.
 * @param {object} meta    `{ resultado, provider, sameProviderVerification, crossProviderDispatch }`.
 * @returns {string|null}  path del sidecar escrito, o `null` si falló.
 */
function writeRequestMeta(logDir, reqId, meta) {
  try {
    const m = (meta && typeof meta === 'object') ? meta : {};
    const safe = {
      resultado: typeof m.resultado === 'string' ? m.resultado : '',
      provider: typeof m.provider === 'string' ? m.provider : '',
      crossProviderDispatch: m.crossProviderDispatch === true,
    };
    // #3951 rebote — TRI-ESTADO de la verificación de Sherlock. SÓLO se persiste
    // `sameProviderVerification` cuando es un boolean real (hubo verificación
    // efectiva: same=true / cross=false). Si llega `null`/ausente/no-boolean
    // (no hubo verificación), el campo se OMITE del sidecar para que el render
    // (`result-badge.js`) caiga en su camino "sin chip" y no invente un estado
    // cross/same-provider (CA-3 / guideline UX). Coaccionar a `false` —como hacía
    // antes— pintaba "cross-provider" en peticiones sin verificación (el defecto).
    if (typeof m.sameProviderVerification === 'boolean') {
      safe.sameProviderVerification = m.sameProviderVerification;
    }
    const filePath = path.join(logDir, metaFileName(reqId));
    fs.writeFileSync(filePath, JSON.stringify(safe), 'utf8');
    return filePath;
  } catch {
    return null;
  }
}

/**
 * #6460 — Actualización MERGE-AWARE del sidecar de metadata.
 *
 * `writeRequestMeta` SOBREESCRIBE el sidecar entero: usarla para estampar un
 * campo suelto borra `resultado`/`provider` y con ellos el badge que el
 * dashboard ya renderiza (el de #6459, entre otros). Esta función lee lo que
 * hay, mergea DENTRO DEL MISMO SHAPE CERRADO y reescribe.
 *
 * Precedencia de `resultado` (CA-1 de #6459): un `resultado` ya asentado NUNCA
 * se pisa. El del patch sólo se usa cuando el sidecar no existe o lo tiene
 * vacío — el caso típico del huérfano, que murió antes de cerrar el turno y por
 * eso no llegó a escribir sidecar. Así `error` le gana a `huerfano` y el orden
 * de las pasadas no cambia lo que ve el operador.
 *
 * `aviso_entregado` es TRI-ESTADO, igual que `sameProviderVerification`:
 *   · `false`   ⇒ el aviso de respuesta perdida NO se pudo entregar (dead-letter
 *                 visible: `result-badge.js` pinta el chip).
 *   · `true`    ⇒ se entregó. Sin chip: el camino feliz no es una novedad.
 *   · ausente / no-boolean ⇒ el campo se OMITE. No hubo aviso o no se sabe, y
 *                 inventar `true` o `false` sería afirmar un hecho no observado.
 *
 * Best-effort: NUNCA tira.
 *
 * SEC: mismo criterio que `writeRequestMeta` — el objeto se RECONSTRUYE campo a
 * campo con coerción explícita. Ni el sidecar leído (que es un archivo del
 * filesystem, o sea input) ni el patch pueden inyectar claves nuevas, y
 * `__proto__` nunca se asigna porque no está en la lista.
 *
 * @param {string} logDir
 * @param {string} reqId
 * @param {object} patch  `{ resultado?, provider?, sameProviderVerification?,
 *                           crossProviderDispatch?, aviso_entregado? }`
 * @returns {string|null} path del sidecar escrito, o `null` si falló.
 */
function updateRequestMeta(logDir, reqId, patch) {
  try {
    const p = (patch && typeof patch === 'object') ? patch : {};
    const filePath = path.join(logDir, metaFileName(reqId));

    // Lectura defensiva: sidecar ausente/ilegible/corrupto ⇒ se parte de vacío,
    // nunca se aborta (el aviso al operador no puede depender de esto).
    let actual = {};
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) actual = parsed;
    } catch { actual = {}; }

    const leer = (obj, k) => (Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : undefined);

    const resultadoActual = leer(actual, 'resultado');
    const resultadoPatch = leer(p, 'resultado');
    const providerActual = leer(actual, 'provider');
    const providerPatch = leer(p, 'provider');

    const safe = {
      // El valor ya asentado gana. El patch sólo rellena el hueco.
      resultado: (typeof resultadoActual === 'string' && resultadoActual !== '')
        ? resultadoActual
        : (typeof resultadoPatch === 'string' ? resultadoPatch : ''),
      provider: (typeof providerActual === 'string' && providerActual !== '')
        ? providerActual
        : (typeof providerPatch === 'string' ? providerPatch : ''),
      crossProviderDispatch: (leer(p, 'crossProviderDispatch') === true)
        || (leer(actual, 'crossProviderDispatch') === true),
    };

    // Tri-estados: el patch pisa al actual SÓLO si trae un boolean real.
    for (const campo of ['sameProviderVerification', 'aviso_entregado']) {
      const desdePatch = leer(p, campo);
      const desdeActual = leer(actual, campo);
      if (typeof desdePatch === 'boolean') safe[campo] = desdePatch;
      else if (typeof desdeActual === 'boolean') safe[campo] = desdeActual;
    }

    fs.writeFileSync(filePath, JSON.stringify(safe), 'utf8');
    return filePath;
  } catch {
    return null;
  }
}

// =============================================================================
// #6458 — Lectores del canal estructurado + puente hacia el audit.
// =============================================================================

/**
 * Lee las etapas asentadas de una petición.
 *
 * FAIL-CLOSED (REQ-SEC-6): una línea que no parsea, que no es objeto plano, o
 * que trae claves de prototype pollution (`__proto__`/`constructor`/
 * `prototype`) se DESCARTA — nunca aborta la lectura ni contamina el prototipo.
 * Devuelve SIEMPRE un array (jamás un objeto indexado por nombre de etapa: un
 * índice por clave es exactamente la forma que reabre CWE-1321).
 *
 * REQ-SEC-5: el path se arma SÓLO vía `stagesFileName`, nunca concatenando el
 * reqId recibido, así que un `reqId` con `../..` no puede salir de `logDir`.
 *
 * @param {string} logDir
 * @param {string} reqId
 * @returns {Array<object>} etapas en orden de escritura; `[]` si no hay archivo.
 */
function readStages(logDir, reqId) {
  const file = path.join(logDir, stagesFileName(reqId));
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const linea of String(raw).split("\n")) {
    const t = linea.trim();
    if (!t) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    if (Object.keys(obj).some(k => UNSAFE_KEYS.has(k))) continue;
    out.push(obj);
  }
  return out;
}

/**
 * ¿La petición asentó una etapa con este nombre?
 *
 * Compara contra el campo `etapa` PARSEADO de cada entrada, nunca
 * `stages[nombre]` (eso volvería a hacer lookup por clave sobre datos de
 * archivo — CWE-1321).
 *
 * @param {Array<object>} stages  salida de `readStages`.
 * @param {string} nombre
 * @returns {boolean}
 */
function hasStage(stages, nombre) {
  return Array.isArray(stages) && stages.some(e => e && typeof e === 'object' && e.etapa === nombre);
}

/**
 * Puente audit ↔ etapas SIN chat id crudo (REQ-SEC-1 / D2).
 *
 * El `reqId` ES `<chatId crudo>-<ms>[-<suffix>]`. Emitirlo tal cual al audit
 * revertiría la seudonimización de esa cadena (que hoy sólo lleva
 * `chat_id_hash`) y encima el dashboard la sirve por `/logs/`.
 *
 * Esta función devuelve `<chat_id_hash>-<ms>[-<suffix>]`, donde el primer
 * segmento es IDÉNTICO al `chat_id_hash` que la propia entrada de audit ya
 * trae ⇒ la correlación es verificable sin agregar ningún identificador nuevo.
 *
 * Procedimiento para ubicar el `.log` hermano desde una entrada de audit
 * (documentado acá para que quien construya la detección de huérfanos no lo
 * reinvente mal): buscar `commander-*-<ms>.log` en el directorio de logs y
 * confirmar el candidato hasheando su segmento de chat y comparándolo contra
 * el `chat_id_hash` de la entrada. NUNCA se persiste el reqId crudo.
 *
 * @param {string} reqId
 * @returns {string|null} `null` si el reqId no tiene la forma esperada.
 */
function buildAuditReqRef(reqId) {
  const safe = String(reqId == null ? '' : reqId).replace(ID_SAFE_RE, '');
  const m = safe.match(/^(.*)-(\d+)(?:-([a-zA-Z0-9]+))?$/);
  if (!m) return null;
  const chatSeg = m[1];
  const ms = m[2];
  const suffix = m[3];
  // Mismo algoritmo que `hashFor()` de multi-provider.js / inflight-fallback.js
  // (sha256 hex, 12 chars). Si cambia allá, tiene que cambiar acá.
  const h = crypto.createHash('sha256')
    .update(String(chatSeg || 'unknown'), 'utf8').digest('hex').slice(0, 12);
  return suffix ? `${h}-${ms}-${suffix}` : `${h}-${ms}`;
}

module.exports = {
  buildRequestId,
  logFileName,
  openRequestLog,
  metaFileName,
  writeRequestMeta,
  // #6460 — merge-aware; NO reemplaza a `writeRequestMeta` (que sigue siendo el
  // camino de cierre de turno, donde sobreescribir es lo correcto).
  updateRequestMeta,
  ID_SAFE_RE,
  // #6458 — canal estructurado de etapas (aditivo, al final).
  stagesFileName,
  readStages,
  hasStage,
  buildAuditReqRef,
};
