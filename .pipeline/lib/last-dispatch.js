'use strict';

// =============================================================================
// last-dispatch.js — Estampa del último DESPACHO EFECTIVO del pipeline (#5400).
//
// Por qué este módulo existe
// --------------------------
// El 2026-08-02 el pipeline estuvo 1h33 sin despachar nada y no llegó ninguna
// notificación. El watchdog de ola (#4708) existía pero medía el movimiento con
// una proxy: el CONTEO de archivos en `trabajando/`. Esa proxy miente en los dos
// sentidos que importan:
//
//   - Un agente clavado mantiene el conteo en 1 para siempre → el watchdog cree
//     que "hay despacho" y calla (G-3 del análisis).
//   - Los agentes terminando bajan el conteo → la firma cambia → el watchdog
//     interpreta "movió ficha" y reinicia el reloj, aunque no haya salido ni un
//     agente nuevo.
//
// La única señal honesta de "salió trabajo" es el instante en que el Pulpo
// realmente lanzó un agente. Este módulo la persiste.
//
// Por qué NO vive dentro de `dispatch-cause.json`
// ------------------------------------------------
// Ese artifact se BORRA (`clearArtifact`) justo cuando hubo despacho. Guardar
// ahí el timestamp del último despacho perdería el dato exactamente en el caso
// que hay que medir. Archivo propio, ciclo de vida propio.
//
// Contrato
// --------
//   - Escritura ATÓMICA (tmp + rename) — un lector nunca ve JSON a medio hacer.
//   - FAIL-SOFT total: un fallo de FS jamás propaga al loop del Pulpo. La
//     estampa es observabilidad, no puede tumbar producción.
//   - Metadata en ALLOWLIST y saneada: estos campos terminan interpolados en un
//     mensaje de Telegram, así que no se acepta contenido arbitrario del caller.
//   - Cero dependencias npm.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic-json');

const FILENAME = 'last-dispatch.json';

// Campos de metadata aceptados. Cualquier otra clave del caller se DESCARTA:
// el payload viaja al dashboard y a Telegram, no es un basurero de contexto.
const META_FIELDS = Object.freeze(['issue', 'skill', 'fase', 'pipeline']);

// Cap por campo. Un `skill` de 4KB no aporta nada y sí rompe el mensaje.
const MAX_FIELD_LEN = 64;

// Caracteres de control (C0 + DEL): se colapsan a espacio antes de persistir.
// Un \n o un \r en `skill` rompería el layout del mensaje de Telegram y podría
// usarse para inyectar líneas falsas en el aviso.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Path canónico de la estampa dentro del directorio de estado. */
function lastDispatchPath(stateDir) {
    return path.join(stateDir, FILENAME);
}

/**
 * Sanea un valor de metadata: a string, colapsando espacios, acotado y sin
 * caracteres de control. Devuelve null si queda vacío.
 */
function sanitizeField(value) {
    if (value == null) return null;
    const s = String(value)
        // eslint-disable-next-line no-control-regex
        .replace(CONTROL_CHARS, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_FIELD_LEN);
    return s.length > 0 ? s : null;
}

/**
 * Normaliza la metadata del despacho a la allowlist de campos.
 * @param {object} meta
 * @returns {object} sólo claves de META_FIELDS con valor no vacío.
 */
function normalizeMeta(meta) {
    const out = {};
    if (!meta || typeof meta !== 'object') return out;
    for (const key of META_FIELDS) {
        const clean = sanitizeField(meta[key]);
        if (clean !== null) out[key] = clean;
    }
    return out;
}

/**
 * Persiste la estampa del despacho efectivo. Idempotente y fail-soft.
 *
 * `ts` se escribe SIEMPRE al final del objeto para que un `meta` malicioso o
 * descuidado no pueda sobrescribir el timestamp (sería una forma trivial de
 * silenciar el watchdog para siempre estampando un futuro lejano).
 *
 * @param {string} stateDir  directorio de estado (`.pipeline/state`).
 * @param {object} [meta]    { issue, skill, fase, pipeline }.
 * @param {number} [nowMs]   timestamp inyectable (tests). Default Date.now().
 * @returns {boolean} true si se persistió; false si falló (nunca lanza).
 */
function writeLastDispatch(stateDir, meta, nowMs) {
    try {
        const ts = Number.isFinite(nowMs) && nowMs > 0 ? nowMs : Date.now();
        // El write atómico (tmp por PID + rename, mkdir, fail-soft) es el
        // compartido de `lib/atomic-json.js`: una sola implementación para todo
        // el estado del pipeline.
        return writeJsonAtomic(lastDispatchPath(stateDir), {
            ...normalizeMeta(meta),
            pid: process.pid,
            ts,
        });
    } catch (_) {
        // Fail-soft (regla #1 del rol): un fallo de FS jamás tumba el loop.
        return false;
    }
}

/**
 * Lee la estampa. Fail-soft: ausente, ilegible o corrupta => null.
 *
 * Un `ts` no finito o <= 0 se trata como ausencia de estampa: es preferible
 * caer a la proxy legacy que alimentar el watchdog con un reloj basura.
 *
 * @param {string} stateDir
 * @returns {{ts:number, pid?:number, issue?:string, skill?:string,
 *            fase?:string, pipeline?:string}|null}
 */
function readLastDispatch(stateDir) {
    try {
        const raw = fs.readFileSync(lastDispatchPath(stateDir), 'utf8');
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object') return null;
        if (!Number.isFinite(obj.ts) || obj.ts <= 0) return null;
        const out = { ...normalizeMeta(obj), ts: obj.ts };
        if (Number.isInteger(obj.pid) && obj.pid > 0) out.pid = obj.pid;
        return out;
    } catch (_) {
        return null;
    }
}

module.exports = {
    FILENAME,
    META_FIELDS,
    MAX_FIELD_LEN,
    lastDispatchPath,
    normalizeMeta,
    writeLastDispatch,
    readLastDispatch,
};
