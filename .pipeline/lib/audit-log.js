// =============================================================================
// audit-log.js — Append-only JSONL con hash chain SHA-256 (tamper-evident).
//
// Issue: #3082 (S4 multi-provider) — CA-13, CA-S4 del PO/security.
//
// Patrón general (igual que el aprobado para #3068 sobre `model-switches.jsonl`):
//   - Cada línea es un JSON con `{...entry, hash_prev, hash_self, created_at}`.
//   - `hash_prev` = `hash_self` de la línea anterior. La primera línea usa
//     `hash_prev = 'GENESIS'` (sentinel constante para que el chain arranque
//     en un punto bien definido).
//   - `hash_self` = SHA-256(canonical_json(entry_sin_hash_self) + hash_prev).
//     `canonical_json` ordena keys lexicográficamente para garantizar que el
//     hash sea reproducible sin importar el orden de inserción.
//
// Verificación: `verifyChain(file)` itera el archivo y recomputa cada hash.
// Si alguna línea no matchea, devuelve `{ ok: false, brokenAt, reason }`.
//
// **Acoplamiento con #3068**: cuando #3068 cierre con `lib/audit-log.js`
// independiente, este módulo se DEPRECA y los callers reusan ese. Marcamos
// con TODO arriba para que el dev de #3068 lo borre limpiamente sin perder
// el patrón. Mientras tanto, este archivo cubre CA-13 sin duplicar el chain
// pattern (un solo lugar canónico, este).
//
// TODO(#3068): cuando #3068 mergee `lib/audit-log.js` como módulo genérico
// (`appendChained({ file, entry })`), borrar este archivo y reusar ese.
// El módulo dedicado debe seguir el mismo protocolo de hash chain.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const GENESIS = 'GENESIS';

/**
 * Serializa un objeto con keys ordenadas lexicográficamente. Necesario para
 * que el hash sea reproducible: dos procesos que escriban la misma entry
 * (en orden distinto de inserción de keys) deben producir el mismo hash.
 *
 * NO maneja referencias circulares — el caller no debe pasar valores con
 * loops. Para entries de audit log no aplica (todos son data plana).
 */
function canonicalJsonStringify(obj) {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) {
        return '[' + obj.map(canonicalJsonStringify).join(',') + ']';
    }
    const keys = Object.keys(obj).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJsonStringify(obj[k])).join(',') + '}';
}

/**
 * Calcula el hash SHA-256 de una entry concatenada con `hash_prev`.
 * `entry` no debe incluir `hash_self` (eso es el output).
 */
function computeEntryHash(entry, hashPrev) {
    const payload = canonicalJsonStringify(entry) + '|' + hashPrev;
    return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Lee la última línea no vacía de un archivo y devuelve su `hash_self`.
 * Si el archivo no existe o está vacío, devuelve GENESIS.
 * Si la última línea no parsea como JSON o no tiene `hash_self`, throw
 * (chain roto previamente — no podemos seguir escribiendo encima sin alertar).
 */
function readLastHash(file, fsImpl) {
    const _fs = fsImpl || fs;
    if (!_fs.existsSync(file)) return GENESIS;
    const content = _fs.readFileSync(file, 'utf8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) return GENESIS;
    const lastLine = lines[lines.length - 1];
    let parsed;
    try {
        parsed = JSON.parse(lastLine);
    } catch (e) {
        throw new Error(
            `[audit-log] Última línea de ${file} no es JSON válido — chain roto. ` +
            `Revisar manualmente y restaurar desde backup o aceptar la pérdida ` +
            `(borrar el archivo y empezar nueva cadena con motivo documentado). ` +
            `Error: ${e.message}`
        );
    }
    if (typeof parsed.hash_self !== 'string' || parsed.hash_self.length === 0) {
        throw new Error(
            `[audit-log] Última línea de ${file} no tiene 'hash_self' válido — ` +
            `chain roto. Línea: ${lastLine}`
        );
    }
    return parsed.hash_self;
}

// -----------------------------------------------------------------------------
// #3275 — CA-8: serialización de escrituras (mutex por archivo).
//
// El hash-chain es read-then-append. Dentro de un solo proceso Node, la
// ejecución sync de `appendChained` no se interleava con otra (event loop
// single-threaded), así que dos callbacks async que ambos llaman
// `appendChained` quedan serializados de hecho.
//
// PERO en el escenario del fallback in-flight del Commander hay dos riesgos
// reales:
//   1. **Cross-process**: el restart.js puede solapar con el pulpo vivo unos
//      segundos durante el handover; ambos escriben al mismo
//      `commander-dispatch-YYYY-MM-DD.jsonl`. Sin file-lock, ambos leen el
//      mismo `hash_prev` y emiten entries con la misma cadena → chain rota.
//   2. **Late-response del primario** después de que el secundario ya escribió
//      `inflight_fallback_completed`. Si el primero abre su sync window justo
//      antes del switch del event loop al callback del secundario, el
//      hash-chain igual queda OK (sync code no se interleava). Pero defense
//      in depth: cualquier futura conversión a async I/O (fs.promises) abre
//      la grieta, así que cementamos el lock ahora.
//
// Solución mínima sin dependencias: `fs.openSync(lockPath, 'wx')` (O_EXCL).
// Si otro proceso tiene el lock, hacemos polling con backoff exponencial
// acotado a `LOCK_RETRY_MAX_MS`. Si vence el budget, fallamos cerrado (no
// escribir es preferible a romper la cadena).
//
// El lockfile vive junto al archivo de audit (`<file>.lock`). Si pulpo muere
// con lock activo, el OS no lo libera automáticamente — por eso TAMBIÉN
// chequeamos el mtime del lock: si tiene más de `LOCK_STALE_MS`, lo
// consideramos huérfano y lo borramos antes de reintentar. Eso evita que un
// crash del primario nos bloquee permanentemente.
// -----------------------------------------------------------------------------

const LOCK_RETRY_MAX_MS = 5000;        // budget total esperando lock
const LOCK_RETRY_BACKOFF_START_MS = 5; // primer backoff
const LOCK_RETRY_BACKOFF_MAX_MS = 200; // backoff cap
const LOCK_STALE_MS = 30 * 1000;       // lockfile más viejo que 30s → huérfano

function lockPathFor(file) {
    return file + '.lock';
}

function _acquireFileLockSync(file, fsImpl, options = {}) {
    const _fs = fsImpl || fs;
    const lp = lockPathFor(file);
    const start = Date.now();
    const maxMs = Number.isFinite(options.maxMs) ? options.maxMs : LOCK_RETRY_MAX_MS;
    const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : LOCK_STALE_MS;
    let backoff = LOCK_RETRY_BACKOFF_START_MS;

    while (true) {
        try {
            const fd = _fs.openSync(lp, 'wx');
            // Escribimos PID + timestamp para diagnóstico forense; no es
            // autoritativo (el lock es la existencia del archivo).
            try {
                _fs.writeSync(fd, `${process.pid}|${Date.now()}\n`);
            } catch { /* best-effort */ }
            try { _fs.closeSync(fd); } catch {}
            return { ok: true, lockPath: lp };
        } catch (e) {
            if (e.code !== 'EEXIST') {
                // Errores inesperados: no podemos adquirir → fallar cerrado.
                return { ok: false, reason: e.code || 'lock_open_error', error: e.message };
            }
            // EEXIST: lock tomado. Chequear staleness.
            try {
                const st = _fs.statSync(lp);
                const age = Date.now() - Number(st.mtimeMs || 0);
                if (age > staleMs) {
                    try { _fs.unlinkSync(lp); } catch { /* otro lo limpió */ }
                    continue;
                }
            } catch { /* lock desapareció → reintentar */ continue; }

            if (Date.now() - start > maxMs) {
                return { ok: false, reason: 'lock_timeout', heldFor: Date.now() - start };
            }
            // Busy-wait sync acotado (no podemos await en sync API).
            const until = Date.now() + Math.min(backoff, LOCK_RETRY_BACKOFF_MAX_MS);
            while (Date.now() < until) { /* spin */ }
            backoff = Math.min(backoff * 2, LOCK_RETRY_BACKOFF_MAX_MS);
        }
    }
}

function _releaseFileLockSync(lockPath, fsImpl) {
    const _fs = fsImpl || fs;
    try { _fs.unlinkSync(lockPath); } catch { /* best-effort */ }
}

/**
 * Append append-only de una entry al archivo, encadenando vía hash_prev.
 *
 * #3275 CA-8: usa file-lock (`<file>.lock`) para serializar read-then-append
 * cross-process. Si no se puede adquirir el lock en `LOCK_RETRY_MAX_MS`,
 * fail-closed (mejor no escribir que romper la cadena).
 *
 * Opt-out: `lockMaxMs: 0` deshabilita el lock (uso interno para tests del
 * propio mecanismo del lock — NO usar en runtime).
 *
 * @param {object} params
 * @param {string} params.file — path absoluto al .jsonl.
 * @param {object} params.entry — datos a persistir (no incluir hash_self).
 * @param {object} [params.fsImpl] — inyectable para tests.
 * @param {number} [params.lockMaxMs] — override budget de adquisición de lock.
 * @returns {{hash_self: string, hash_prev: string, line: string}}
 */
function appendChained({ file, entry, fsImpl, lockMaxMs } = {}) {
    if (!file || typeof file !== 'string') {
        throw new Error('[audit-log] appendChained: parámetro "file" requerido.');
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('[audit-log] appendChained: parámetro "entry" debe ser objeto plano.');
    }
    const _fs = fsImpl || fs;

    // Crear directorio padre si no existe
    const dir = path.dirname(file);
    if (!_fs.existsSync(dir)) {
        _fs.mkdirSync(dir, { recursive: true });
    }

    // #3275 CA-8 — adquirir lock antes del read-then-append.
    const useLock = lockMaxMs !== 0;
    let lock = null;
    if (useLock) {
        lock = _acquireFileLockSync(file, _fs, { maxMs: lockMaxMs });
        if (!lock.ok) {
            // Fail-closed: no podemos garantizar consistencia de la cadena.
            throw new Error(
                `[audit-log] No se pudo adquirir lock de ${file} (${lock.reason})` +
                (lock.heldFor ? ` después de ${lock.heldFor}ms` : '') +
                (lock.error ? `: ${lock.error}` : '')
            );
        }
    }

    try {
        const hashPrev = readLastHash(file, _fs);
        const createdAt = entry.created_at || Date.now();
        const fullEntry = { ...entry, created_at: createdAt, hash_prev: hashPrev };
        const hashSelf = computeEntryHash(fullEntry, hashPrev);
        const finalEntry = { ...fullEntry, hash_self: hashSelf };
        const line = JSON.stringify(finalEntry) + '\n';

        _fs.appendFileSync(file, line, 'utf8');

        return { hash_self: hashSelf, hash_prev: hashPrev, line };
    } finally {
        if (lock && lock.ok) {
            _releaseFileLockSync(lock.lockPath, _fs);
        }
    }
}

/**
 * Verifica la integridad de la chain completa en un archivo.
 *
 * @param {string} file
 * @param {object} [fsImpl]
 * @returns {{ok: boolean, entriesChecked: number, brokenAt?: number, reason?: string}}
 */
function verifyChain(file, fsImpl) {
    const _fs = fsImpl || fs;
    if (!_fs.existsSync(file)) {
        return { ok: true, entriesChecked: 0 };
    }
    const content = _fs.readFileSync(file, 'utf8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);

    let expectedPrev = GENESIS;
    for (let i = 0; i < lines.length; i++) {
        let parsed;
        try {
            parsed = JSON.parse(lines[i]);
        } catch (e) {
            return { ok: false, entriesChecked: i, brokenAt: i, reason: `JSON parse failed: ${e.message}` };
        }
        if (parsed.hash_prev !== expectedPrev) {
            return {
                ok: false,
                entriesChecked: i,
                brokenAt: i,
                reason: `hash_prev mismatch: esperaba '${expectedPrev}' pero la entry trae '${parsed.hash_prev}'`,
            };
        }
        const claimed = parsed.hash_self;
        const { hash_self: _ignore, ...rest } = parsed;
        const recomputed = computeEntryHash(rest, expectedPrev);
        if (recomputed !== claimed) {
            return {
                ok: false,
                entriesChecked: i,
                brokenAt: i,
                reason: `hash_self mismatch: claimed '${claimed}', recomputed '${recomputed}'`,
            };
        }
        expectedPrev = claimed;
    }
    return { ok: true, entriesChecked: lines.length };
}

/**
 * Lee todas las entries del archivo como array de objetos.
 * Si el archivo no existe, devuelve []. No verifica la chain — usar
 * `verifyChain` para eso. Útil para CLIs de consulta y override readers.
 */
function readAll(file, fsImpl) {
    const _fs = fsImpl || fs;
    if (!_fs.existsSync(file)) return [];
    const content = _fs.readFileSync(file, 'utf8');
    return content.split('\n')
        .filter(l => l.trim().length > 0)
        .map(l => JSON.parse(l));
}

module.exports = {
    GENESIS,
    appendChained,
    verifyChain,
    readAll,
    // exportados para tests
    canonicalJsonStringify,
    computeEntryHash,
    readLastHash,
    // #3275 CA-8 — file lock exportado para tests del propio mecanismo.
    _acquireFileLockSync,
    _releaseFileLockSync,
    lockPathFor,
    LOCK_RETRY_MAX_MS,
    LOCK_STALE_MS,
};
