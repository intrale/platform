// =============================================================================
// recent-requests.js — Listado de las últimas peticiones atendidas por el
// Commander (#6459, extraído de `dashboard.js:renderCommanderRequestLogs`).
//
// POR QUÉ EXISTE ESTE MÓDULO
// --------------------------
// El listado "logs recientes + badge de resultado" (#3949/#3951) vivía
// enteramente dentro de `generateHTML()` de `dashboard.js`, que el dispatch
// sirve ÚNICAMENTE para `/legacy`. El dashboard que abre el operador (`/`,
// `/v3`, `/dashboard`) lo emite `views/dashboard/home.js`, donde el listado
// nunca existió: el badge de resultado era código muerto en pantalla.
//
// Para que las dos superficies muestren LO MISMO sin duplicar la lectura del
// filesystem, la extracción de datos vive acá y cada superficie sólo aporta su
// render. Un cambio de formato de nombre o de sidecar se toca en un solo lugar.
//
// El módulo NO produce HTML: devuelve datos planos. Es I/O puro y aislado,
// testeable inyectando `deps.fs`.
// =============================================================================
'use strict';

const fsDefault = require('fs');
const pathDefault = require('path');

const DEFAULT_LIMIT = 8;

// Nombre del log de una petición: `commander-<chat_id>-<epochms>.log`.
// OJO: el `chat_id` de los grupos de Telegram es NEGATIVO, así que el nombre
// real trae dos guiones seguidos (`commander--1001234-1787....log`). Por eso el
// id se parte por el ÚLTIMO `-` y no por el primero.
const LOG_NAME_RE = /^commander-.+\.log$/;

/**
 * Descompone el nombre de archivo en `{ file, id, epochms, chat }`.
 * @returns {{file:string,id:string,epochms:number,chat:string}}
 */
function parseLogName(file) {
    const id = String(file).replace(/^commander-/, '').replace(/\.log$/, '');
    const parts = id.split('-');
    const epochms = Number(parts[parts.length - 1]);
    const chat = parts.slice(0, -1).join('-') || '?';
    return { file: String(file), id, epochms: Number.isFinite(epochms) ? epochms : 0, chat };
}

/**
 * Lee el sidecar `commander-<id>.meta.json`. Lectura DEFENSIVA: si no existe
 * (peticiones previas a #3951) o está corrupto ⇒ `null`, nunca excepción.
 */
function readMeta(logDir, id, fs, path) {
    try {
        const metaPath = path.join(logDir, `commander-${id}.meta.json`);
        if (!fs.existsSync(metaPath)) return null;
        const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Últimas `limit` peticiones del Commander, de la más nueva a la más vieja.
 *
 * @param {string} logDir  directorio de logs del pipeline.
 * @param {number} [limit] tope de filas (default 8).
 * @param {{fs?:object, path?:object}} [deps] inyección para tests.
 * @returns {Array<{file:string,id:string,epochms:number,chat:string,meta:object|null}>}
 *          Array vacío si el directorio no existe o no se puede leer.
 */
function listRecentRequests(logDir, limit, deps) {
    const fs = (deps && deps.fs) || fsDefault;
    const path = (deps && deps.path) || pathDefault;
    const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT;

    let entries;
    try {
        entries = fs.readdirSync(logDir)
            .filter((f) => LOG_NAME_RE.test(f))
            .map(parseLogName)
            .sort((a, b) => b.epochms - a.epochms)
            .slice(0, max);
    } catch {
        return []; // dir inexistente / ilegible → estado vacío, nunca excepción
    }

    return entries.map((it) => Object.assign({}, it, { meta: readMeta(logDir, it.id, fs, path) }));
}

module.exports = { listRecentRequests, parseLogName, readMeta, DEFAULT_LIMIT };
