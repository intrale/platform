'use strict';

// =============================================================================
// partial-pause-deps-mute.js — Silencio persistente de la alerta de
// dependencias faltantes (#6118, CA-9..CA-13).
//
// POR QUÉ NO ALCANZA EL COOLDOWN QUE YA EXISTE
// --------------------------------------------
// El Pulpo ya tenía `partialPauseDepsAlertCache`: un `Map` en memoria que evita
// repetir la misma alerta antes de 30 min. No sirve como silencio, por dos
// razones que no son de estilo:
//
//   1. Cruza procesos. La alerta la EMITE el Pulpo; el tap del botón lo RECIBE
//      el dashboard (listener → callback-handler → POST a localhost:3200). Un
//      Map en el heap del Pulpo es invisible desde el proceso que atiende el
//      tap.
//   2. No sobrevive al respawn (CA-11). El Pulpo se reinicia seguido, y un
//      "no volver a avisar" que vuelve a avisar diez minutos después es peor
//      que no tener el botón: enseña al operador que los botones mienten, que
//      es exactamente el defecto que #6118 vino a corregir.
//
// Por eso el silencio va a archivo, con write atómico. Cooldown y silencio son
// mecanismos distintos y conviven: el cooldown sigue tal cual (persistirlo es
// otro issue, #6128).
//
// CLAVE DEL SILENCIO (REQ-SEC-4.1 / CA-10)
// ----------------------------------------
// La clave es `alertSignature(issue, deps)` de `partial-pause-deps.js`, que ya
// normaliza y ordena las deps. Consecuencia buscada: si aparece una dependencia
// nueva, la firma cambia y la alerta VUELVE aunque la ventana siga vigente. Es
// una situación distinta de la que el operador silenció, y ocultarla sería un
// punto ciego (OWASP A09).
//
// TTL ACOTADO (REQ-SEC-4.2 / CA-13)
// ---------------------------------
// Nunca infinito. Un silencio permanente convierte un issue trabado en un
// agujero de observabilidad. El valor sale de `partial_pause_deps.mute_ttl_ms`
// en `config.yaml`, con default explícito de 24 h y clamp duro.
//
// La firma NUNCA se usa como path ni se concatena a una URL: es sólo una clave
// dentro de un JSON.
// =============================================================================

const fs = require('fs');
const path = require('path');

// Mismo mecanismo de resolución que `partial-pause.js`: override por env para
// que los tests apunten a un tmp sin tocar el pipeline real.
function pipelineDir() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.join(__dirname, '..');
}

const MUTE_FILENAME = 'partial-pause-deps-mute.json';

function muteFilePath() {
    return path.join(pipelineDir(), MUTE_FILENAME);
}

// 24 h por default (CA-13). El clamp existe para que un valor absurdo en config
// —0, negativo, un año— no desactive el mecanismo ni lo vuelva permanente.
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_TTL_MS = 60 * 1000;              // 1 min: por debajo el botón no sirve
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días: techo duro, nunca infinito

// Tope de entradas persistidas. Cada tap del operador agrega una; el pruning por
// TTL las limpia solo, pero un tope explícito evita que un archivo de estado
// crezca sin límite si algo patina.
const MAX_ENTRIES = 500;

/**
 * TTL efectivo a partir del config del pipeline. Acepta el objeto de config
 * completo o directamente el sub-objeto `partial_pause_deps`.
 *
 * @param {object} [config]
 * @returns {number} ms, siempre dentro de [MIN_TTL_MS, MAX_TTL_MS]
 */
function resolveTtlMs(config) {
    const c = (config && (config.partial_pause_deps || config)) || {};
    const raw = Number(c.mute_ttl_ms);
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TTL_MS;
    return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.round(raw)));
}

/**
 * Igual que `resolveTtlMs`, pero leyendo el config del disco. Existe para los
 * dos consumidores que NO tienen el config ya cargado en memoria: el hook de
 * callbacks de Telegram (que necesita la ventana para redactar el texto de la
 * confirmación) y el endpoint del dashboard.
 *
 * Defensivo a propósito: si el resolver tira —config corrupto, archivo ausente,
 * violación de schema— devuelve el default en vez de propagar. Un aviso que no
 * se puede silenciar es molesto; un hook de Telegram que explota deja al
 * operador sin ningún botón.
 *
 * @returns {number} ms
 */
function resolveTtlMsFromDisk() {
    try {
        const resolver = require('./config-resolver');
        const cfg = resolver.resolve({ pipelineDir: pipelineDir() });
        return resolveTtlMs(cfg);
    } catch {
        return DEFAULT_TTL_MS;
    }
}

/**
 * Lee el archivo de silencios. NUNCA tira: un JSON corrupto o un archivo
 * ausente degradan a "no hay ningún silencio activo", que es el lado seguro
 * (se avisa de más, no de menos).
 *
 * @returns {{version:number, entries:object}}
 */
function readAll() {
    const empty = { version: 1, entries: {} };
    try {
        const file = muteFilePath();
        if (!fs.existsSync(file)) return empty;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || !parsed.entries || typeof parsed.entries !== 'object') {
            return empty;
        }
        return { version: Number(parsed.version) || 1, entries: parsed.entries };
    } catch {
        // Archivo corrupto: se ignora y el próximo `mute()` lo reescribe entero.
        return empty;
    }
}

/**
 * Write atómico tmp + rename. Mismo molde que `partial-pause.js:writeAtomic`.
 * Sin esto, un Pulpo que muere a mitad del `writeFileSync` deja un JSON
 * truncado y el silencio se pierde en silencio (valga la redundancia).
 */
function writeAtomic(data) {
    const target = muteFilePath();
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, target);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch {}
        throw err;
    }
}

/** Entrada válida y todavía vigente. */
function isLive(entry, now) {
    return !!entry
        && typeof entry === 'object'
        && Number.isFinite(Number(entry.expiresAt))
        && Number(entry.expiresAt) > now;
}

/**
 * ¿Está silenciada esta combinación exacta de (issue, dependencias)?
 *
 * @param {string} signature - salida de `partialPauseDeps.alertSignature`
 * @param {number} [now] - epoch ms; inyectable para test
 * @returns {boolean}
 */
function isMuted(signature, now = Date.now()) {
    const sig = String(signature || '');
    if (!sig) return false;
    const entry = readAll().entries[sig];
    return isLive(entry, now);
}

/**
 * Silencia una combinación (issue, dependencias) por la ventana indicada.
 * Idempotente: volver a silenciar la misma firma renueva la ventana.
 *
 * IMPORTANTE: esta función NO toca la selección de issues habilitados (CA-9).
 * No importa ni `partial-pause.js` ni ninguna primitiva de mutación, así que no
 * hay camino de código desde acá hasta `setPartialPause`/`clearPartialPause`.
 * Eso es verificable por test y por lectura del `require` de arriba.
 *
 * @param {string} signature
 * @param {object} [meta]
 * @param {number|string} [meta.issue]
 * @param {Array<number>} [meta.deps]
 * @param {string} [meta.operatorRef]
 * @param {number} [meta.ttlMs]
 * @param {number} [meta.now]
 * @returns {{ok:boolean, signature:string, mutedAt:string, expiresAt:number, ttlMs:number}}
 */
function mute(signature, meta = {}) {
    const sig = String(signature || '');
    if (!sig) return { ok: false, signature: sig, reason: 'empty_signature' };

    const now = Number.isFinite(Number(meta.now)) ? Number(meta.now) : Date.now();
    const ttlMs = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS,
        Number.isFinite(Number(meta.ttlMs)) && Number(meta.ttlMs) > 0 ? Number(meta.ttlMs) : DEFAULT_TTL_MS));
    const expiresAt = now + ttlMs;

    const data = readAll();
    // Se poda en el mismo write: el archivo se mantiene chico sin necesidad de
    // un barrido aparte.
    const entries = {};
    for (const [k, v] of Object.entries(data.entries)) {
        if (isLive(v, now)) entries[k] = v;
    }

    entries[sig] = {
        signature: sig,
        issue: Number(meta.issue) || null,
        deps: (Array.isArray(meta.deps) ? meta.deps : []).map(Number).filter(Number.isFinite),
        mutedAt: new Date(now).toISOString(),
        expiresAt,
        ttlMs,
        // Identidad del operador, recortada. Es para auditoría (CA-12), no para
        // autorización: la authz ya la hizo el listener por `from.id`.
        operatorRef: meta.operatorRef ? String(meta.operatorRef).slice(0, 64) : null,
    };

    // Si aun después de podar hay demasiadas, se descartan las que vencen antes.
    const keys = Object.keys(entries);
    if (keys.length > MAX_ENTRIES) {
        keys.sort((a, b) => Number(entries[b].expiresAt) - Number(entries[a].expiresAt));
        for (const k of keys.slice(MAX_ENTRIES)) delete entries[k];
    }

    writeAtomic({ version: 1, entries });
    return { ok: true, signature: sig, mutedAt: entries[sig].mutedAt, expiresAt, ttlMs };
}

/**
 * Silencios vigentes, del que vence antes al que vence después.
 * @param {number} [now]
 * @returns {Array<object>}
 */
function listActive(now = Date.now()) {
    return Object.values(readAll().entries)
        .filter(e => isLive(e, now))
        .sort((a, b) => Number(a.expiresAt) - Number(b.expiresAt));
}

/**
 * Borra del archivo los silencios vencidos. No es imprescindible (`mute` ya
 * poda y `isMuted` ignora los vencidos), pero deja el estado legible para quien
 * lo lea a mano.
 *
 * @param {number} [now]
 * @returns {{removed:number, remaining:number}}
 */
function pruneExpired(now = Date.now()) {
    const data = readAll();
    const kept = {};
    let removed = 0;
    for (const [k, v] of Object.entries(data.entries)) {
        if (isLive(v, now)) kept[k] = v; else removed++;
    }
    if (removed > 0) writeAtomic({ version: 1, entries: kept });
    return { removed, remaining: Object.keys(kept).length };
}

/**
 * Levanta un silencio puntual. No lo usa la alerta, pero un estado que sólo se
 * puede escribir y nunca revertir es una trampa operativa.
 *
 * @param {string} signature
 * @returns {{ok:boolean, existed:boolean}}
 */
function unmute(signature) {
    const sig = String(signature || '');
    const data = readAll();
    const existed = Object.prototype.hasOwnProperty.call(data.entries, sig);
    if (!existed) return { ok: true, existed: false };
    delete data.entries[sig];
    writeAtomic({ version: 1, entries: data.entries });
    return { ok: true, existed: true };
}

module.exports = {
    MUTE_FILENAME,
    DEFAULT_TTL_MS,
    MIN_TTL_MS,
    MAX_TTL_MS,
    MAX_ENTRIES,
    muteFilePath,
    resolveTtlMs,
    resolveTtlMsFromDisk,
    readAll,
    isMuted,
    mute,
    listActive,
    pruneExpired,
    unmute,
};
