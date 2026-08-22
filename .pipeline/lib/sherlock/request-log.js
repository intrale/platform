// =============================================================================
// request-log.js — Log por corrida del Sherlock (#4335).
//
// Un archivo `logs/sherlock-<reqId>.log` por verificación del Sherlock, con el
// mismo esquema de seguimiento que los logs del Commander
// (`logs/commander-<reqId>.log`) y de los agentes de issue
// (`logs/<issue>-<skill>.log`). El objetivo es que la corrida del Sherlock sea
// accesible desde la vista de logs genérica del dashboard
// (`/logs/view/<file>`, `/logs/stream/<file>`), igual que cualquier otro agente.
//
// Requisitos de seguridad (heredados de `lib/commander/request-log.js`):
//   SEC-1: la escritura SIEMPRE pasa por `createLogFileWriter` (stream
//          sanitizado). NUNCA `fs.appendFileSync` crudo — saltearía la
//          redacción de secretos heredada del sanitizer (#2333/#2334).
//   SEC-3: las etapas NUNCA serializan el objeto de config de providers ni
//          `process.env`. El caller pasa SOLO strings/números/booleans.
//   SEC-4: el `<reqId>` se restringe a `[a-zA-Z0-9-]` para que la whitelist
//          anti-traversal del viewer (`dashboard.js`) no lo deforme y el match
//          archivo↔link se mantenga.
//
// El módulo es determinístico y testeable en aislamiento (a diferencia de
// `pulpo.js`, que no se puede unit-testear levantando el proceso). Espejo
// deliberado de `lib/commander/request-log.js` para reutilizar el patrón ya
// endurecido.
// =============================================================================
'use strict';

const path = require('path');
const { createLogFileWriter } = require('../sanitize-log-stream');

// SEC-4: caracteres permitidos en el `<reqId>`. Igual que el Commander: el '-'
// está permitido (el reqId del Commander deriva de un chat_id que puede ser
// negativo). Cualquier otro carácter se elimina (no se sustituye) para no
// inflar el id ni introducir colisiones por mapeo a un mismo placeholder.
const ID_SAFE_RE = /[^a-zA-Z0-9-]/g;

/**
 * Construye un `<reqId>` filename-safe para el log de una corrida de Sherlock.
 *
 * Normalmente se reutiliza el `commanderReqId` del turno con un sufijo
 * `-sherlock` para correlacionar ambos logs, pero el helper es genérico.
 *
 * @param {string|number} baseId  id base (ej. el reqId del Commander).
 * @param {string} [suffix]       sufijo opcional (ej. 'sherlock').
 * @returns {string} reqId que matchea `^[a-zA-Z0-9-]+$`.
 */
function buildRequestId(baseId, suffix) {
  const safeBase = String(baseId == null ? 'unknown' : baseId).replace(ID_SAFE_RE, '');
  const base = safeBase || 'unknown';
  if (suffix) {
    const safeSuffix = String(suffix).replace(ID_SAFE_RE, '');
    if (safeSuffix) return `${base}-${safeSuffix}`;
  }
  return base;
}

/**
 * Devuelve el nombre de archivo (sin directorio) para un reqId dado.
 * Prefijo `sherlock-` para que el cleanup de logs viejos lo barra por patrón.
 * @param {string} reqId
 * @returns {string}
 */
function logFileName(reqId) {
  const safeId = String(reqId == null ? '' : reqId).replace(ID_SAFE_RE, '');
  return `sherlock-${safeId}.log`;
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

  // Cabecera de sección por etapa. Mismo estilo que el Commander
  // (`--- etapa:... req:... <iso> ---`). El ISO timestamp se inyecta como string
  // ya formateado para mantener el helper determinístico/testeable.
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
  // sanitizado (SEC-1).
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
