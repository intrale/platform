// =============================================================================
// sherlock/request-log.js — Log por corrida de verificación de Sherlock (#4335).
//
// Espejo de `lib/commander/request-log.js`. Sherlock corre in-process para
// validar cada turno del Commander y hasta ahora NO dejaba un `.log` bajo
// `.pipeline/logs/` — solo audit JSONL fuera del path servido por el dashboard.
// Este módulo abre un `logs/sherlock-<id>.log` por corrida para que el dashboard
// pueda exponer sus logs por el MISMO mecanismo genérico (`/logs/*`) que el
// resto de los agentes.
//
// Requisitos de seguridad (heredados de commander/request-log.js):
//   SEC-1: la escritura SIEMPRE pasa por `createLogFileWriter` (stream
//          sanitizado). NUNCA `fs.appendFileSync` crudo — saltearía la
//          redacción de secretos heredada del sanitizer (#2333/#2334).
//   SEC-3: las etapas NUNCA serializan el objeto de config de providers
//          (API keys) ni `process.env`. Solo strings/números (provider, modelo,
//          veredicto, conteo de inconsistencias).
//   SEC-4: el `<id>` se restringe a `[a-zA-Z0-9-]` para que la whitelist
//          anti-traversal del viewer (`dashboard.js`) no lo deforme y el match
//          archivo↔link se mantenga.
//
// El módulo es determinístico y testeable (a diferencia de `pulpo.js` / el
// verifier levantado en vivo): naming + apertura + etapas + cierre viven acá.
// =============================================================================
'use strict';

const path = require('path');
const { createLogFileWriter } = require('../sanitize-log-stream');

// SEC-4: caracteres permitidos en el `<id>`. Cualquier otro carácter se elimina
// (no se sustituye) para no inflar el id ni introducir colisiones por mapeo a un
// mismo placeholder. El reqId del Commander (que puede incluir un chat_id
// negativo) ya viene saneado con esta misma clase; re-aplicarla es idempotente.
const ID_SAFE_RE = /[^a-zA-Z0-9-]/g;

/**
 * Construye un `<id>` filename-safe para el log de una corrida de Sherlock.
 * Reutiliza el reqId del turno del Commander (correlación 1:1 turno↔verificación)
 * con un sufijo opcional para distinguir 1ra/2da pasada de la cascada.
 *
 * @param {string|number} reqId   id del turno (ej. el `commanderReqId`).
 * @param {string} [suffix]       sufijo opcional (ej. 'sherlock' o 'sherlock-2').
 * @returns {string} id que matchea `^[a-zA-Z0-9-]+$`.
 */
function buildRequestId(reqId, suffix) {
  const safe = String(reqId == null ? 'unknown' : reqId).replace(ID_SAFE_RE, '') || 'unknown';
  if (suffix) {
    const safeSuffix = String(suffix).replace(ID_SAFE_RE, '');
    if (safeSuffix) return `${safe}-${safeSuffix}`;
  }
  return safe;
}

/**
 * Devuelve el nombre de archivo (sin directorio) para un reqId dado.
 * @param {string} reqId
 * @returns {string}
 */
function logFileName(reqId) {
  const safe = String(reqId == null ? '' : reqId).replace(ID_SAFE_RE, '');
  return `sherlock-${safe}.log`;
}

/**
 * Abre el log de una corrida de Sherlock. Hereda la redacción del stream
 * sanitizado (SEC-1): toda escritura va por el `writable` del
 * `createLogFileWriter`.
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

  // Cabecera de sección por etapa. Mismo estilo que el request-log del Commander.
  const stage = (name, meta) => {
    const iso = (meta && meta.iso) || new Date().toISOString();
    let header = `\n--- etapa:${name} req:${reqId} ${iso} ---\n`;
    if (meta) {
      for (const [k, v] of Object.entries(meta)) {
        if (k === 'iso') continue;
        // SEC-3: el caller pasa SOLO strings/números, nunca objetos de config.
        // Serializamos defensivamente a string plano.
        header += `${k}: ${v == null ? '' : String(v)}\n`;
      }
    }
    try { writable.write(header); } catch { /* best-effort, no tira el turno */ }
  };

  const line = (text) => {
    if (text == null) return;
    try { writable.write(`${String(text)}\n`); } catch { /* best-effort */ }
  };

  return { reqId, fileName, path: logPath, writable, stage, line, close };
}

module.exports = {
  buildRequestId,
  logFileName,
  openRequestLog,
  ID_SAFE_RE,
};
