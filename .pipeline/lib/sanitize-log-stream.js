// =============================================================================
// sanitize-log-stream.js — WriteStream sanitizador para `.pipeline/logs/*`
// Issue #2334 (CA6). Depende de `.pipeline/sanitizer.js` (#2333).
//
// Garantía: NUNCA se escribe el input original a disco, ni siquiera
// transitoriamente. El buffer interno del Transform vive sólo en memoria
// hasta que se lo flushea sanitizado.
//
// Uso típico desde pulpo.js:
//
//     const { createLogFileWriter } = require('./lib/sanitize-log-stream');
//     const { writable, fd } = createLogFileWriter(agentLogPath);
//     // 'writable' es un Writable público; 'fd' viene de la cadena interna.
//     child.stdout.pipe(writable);
//     child.stderr.pipe(writable);
//
// Para `fs.appendFileSync` puntuales, preferir invocar `sanitize()` del
// módulo core directamente sobre el string antes de llamar a appendFileSync
// (pass-through ergonómico, sin overhead de streams).
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { createSanitizeStream } = require('../sanitizer');

/**
 * Crea un Writable que:
 *   1) recibe chunks crudos (stdout/stderr del child, o cualquier otra fuente),
 *   2) los pasa por createSanitizeStream (Transform con ventana deslizante),
 *   3) los appendea al archivo `logPath`.
 *
 * Los errores del stream file-write se capturan y se imprimen a `stderr`
 * del proceso para que no tiren el pipeline; el flag `silentFs` permite
 * apagarlo en tests.
 *
 * @param {string} logPath
 * @param {{ minBufferBytes?: number, maxBufferBytes?: number, silentFs?: boolean }} [opts]
 * @returns {{ writable: NodeJS.WritableStream, close: () => Promise<void> }}
 */
function createLogFileWriter(logPath, opts) {
    const options = opts || {};
    // Asegurar que el directorio existe (defensa).
    try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
    } catch { /* no-op */ }

    const sanitizeStream = createSanitizeStream({
        minBufferBytes: options.minBufferBytes,
        maxBufferBytes: options.maxBufferBytes,
    });

    const fileStream = fs.createWriteStream(logPath, { flags: 'a' });
    fileStream.on('error', (err) => {
        if (options.silentFs) return;
        // Evitar que un fallo de disco mate el proceso.
        try { process.stderr.write(`[sanitize-log-stream] write error on ${logPath}: ${err.message}\n`); } catch {}
    });

    // Pipe sanitize → file. `end: false` para poder recibir múltiples fuentes
    // (stdout + stderr) sin que la primera que termine cierre el archivo.
    sanitizeStream.pipe(fileStream, { end: false });
    sanitizeStream.on('error', (err) => {
        if (options.silentFs) return;
        try { process.stderr.write(`[sanitize-log-stream] sanitize error on ${logPath}: ${err.message}\n`); } catch {}
    });

    async function close() {
        return new Promise((resolve) => {
            sanitizeStream.end(() => {
                fileStream.end(() => resolve());
            });
        });
    }

    return { writable: sanitizeStream, close };
}

module.exports = { createLogFileWriter };
