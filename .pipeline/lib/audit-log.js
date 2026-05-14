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

/**
 * Append append-only de una entry al archivo, encadenando vía hash_prev.
 *
 * @param {object} params
 * @param {string} params.file — path absoluto al .jsonl.
 * @param {object} params.entry — datos a persistir (no incluir hash_self).
 * @param {object} [params.fsImpl] — inyectable para tests.
 * @returns {{hash_self: string, hash_prev: string, line: string}}
 */
function appendChained({ file, entry, fsImpl } = {}) {
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

    const hashPrev = readLastHash(file, _fs);
    const createdAt = entry.created_at || Date.now();
    const fullEntry = { ...entry, created_at: createdAt, hash_prev: hashPrev };
    const hashSelf = computeEntryHash(fullEntry, hashPrev);
    const finalEntry = { ...fullEntry, hash_self: hashSelf };
    const line = JSON.stringify(finalEntry) + '\n';

    _fs.appendFileSync(file, line, 'utf8');

    return { hash_self: hashSelf, hash_prev: hashPrev, line };
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
};
