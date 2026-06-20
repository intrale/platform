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
//   SEC-1: la escritura SIEMPRE pasa por `createLogFileWriter` (stream
//          sanitizado). NUNCA `fs.appendFileSync` crudo — saltearía la
//          redacción de secretos heredada del sanitizer (#2333/#2334).
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
const { createLogFileWriter } = require('../sanitize-log-stream');

// SEC-4: caracteres permitidos en el `<id>`. El chat_id de grupos de Telegram es
// negativo, así que el '-' está explícitamente permitido. Cualquier otro
// carácter se elimina (no se sustituye) para no inflar el id ni introducir
// colisiones por mapeo a un mismo placeholder.
const ID_SAFE_RE = /[^a-zA-Z0-9-]/g;

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
  };

  // Escritura de una línea de contenido dentro de una etapa. Pasa por el stream
  // sanitizado (SEC-1/SEC-2).
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
 * objeto plano con sólo los 4 campos esperados, coaccionados a string/boolean.
 * Así un caller equivocado no puede filtrar config de providers ni secretos.
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
      sameProviderVerification: m.sameProviderVerification === true,
      crossProviderDispatch: m.crossProviderDispatch === true,
    };
    const filePath = path.join(logDir, metaFileName(reqId));
    fs.writeFileSync(filePath, JSON.stringify(safe), 'utf8');
    return filePath;
  } catch {
    return null;
  }
}

module.exports = {
  buildRequestId,
  logFileName,
  openRequestLog,
  metaFileName,
  writeRequestMeta,
  ID_SAFE_RE,
};
