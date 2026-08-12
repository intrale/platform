'use strict';

// =============================================================================
// atomic-json.js — Write atómico de JSON de estado (#5400, rev-1).
//
// Por qué este módulo existe
// --------------------------
// El patrón `tmp + renameSync` estaba copiado y pegado en, por lo menos, cuatro
// lugares distintos del pipeline (heartbeat del Pulpo, estado del watchdog,
// estampa de despacho, status del watchdog), cada uno con su propia variante de
// nombre de temporal y de manejo de error. Copias divergentes de una primitiva
// de integridad son la forma más barata de tener un bug que sólo aparece en el
// caso raro: el día que una de ellas se olvida el `mkdir`, o deja el `.tmp`
// colgado, o escribe sin `try` y tumba el loop.
//
// Contrato
// --------
//   - ATÓMICO: se escribe a un temporal PROPIO DEL PID y se renombra encima.
//     Un lector concurrente ve el archivo viejo o el nuevo, nunca uno a medias.
//   - FAIL-SOFT: devuelve `false` en vez de lanzar. La regla #1 del rol es que
//     el pipeline no puede morir por un fallo de FS en algo observacional.
//     El caller decide si eso amerita degradar (y DEBE mirar el valor de
//     retorno: descartar el `false` es cómo un control se apaga en silencio).
//   - Cero dependencias npm.
// =============================================================================

const fs = require('fs');
const path = require('path');

/**
 * Escribe `obj` como JSON de forma atómica.
 *
 * @param {string} file       destino absoluto.
 * @param {*} obj             valor serializable.
 * @param {object} [opts]
 * @param {number} [opts.indent]  espacios de indentación (default 0 = compacto).
 * @returns {boolean} true si quedó persistido; false si falló (nunca lanza).
 */
function writeJsonAtomic(file, obj, opts) {
    const indent = opts && Number.isInteger(opts.indent) && opts.indent > 0 ? opts.indent : 0;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch (_) {
        /* ya existe o no se puede crear: lo dirá el write */
    }
    try {
        fs.writeFileSync(tmp, indent > 0 ? JSON.stringify(obj, null, indent) : JSON.stringify(obj));
        fs.renameSync(tmp, file); // atómico dentro del mismo filesystem
        return true;
    } catch (_) {
        // Best-effort: no dejar el temporal colgado si el rename fue el que falló.
        try { fs.unlinkSync(tmp); } catch (_e) { /* no existía */ }
        return false;
    }
}

/**
 * Lee un JSON de estado. Fail-soft: ausente, ilegible o corrupto => `fallback`.
 *
 * @param {string} file
 * @param {*} [fallback]  valor devuelto ante cualquier problema (default null).
 * @returns {*}
 */
function readJsonSafe(file, fallback = null) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed === undefined ? fallback : parsed;
    } catch (_) {
        return fallback;
    }
}

module.exports = { writeJsonAtomic, readJsonSafe };
