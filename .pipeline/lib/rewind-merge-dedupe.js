// =============================================================================
// rewind-merge-dedupe.js — Barrera dura de idempotencia del rewind por
// conflicto de merge (#4967 · CA-9 · H-A6).
// =============================================================================
//
// Por qué un módulo nuevo y no reusar lo que ya existe:
//
//   - `writeInFlightMarker` de `pipeline-rewind.js` es un breadcrumb keyed por
//     ISSUE con TTL de 5 min: cubre el crash in-flight, no un poll repetido ni
//     un reinicio del Pulpo dos horas después.
//   - `getRecentRewindCount` parsea `audit/rewinds.jsonl` entero línea por
//     línea. Es O(n) creciente y no tiene ninguna garantía de atomicidad; el
//     rate-limit que lo consume además sólo ALERTA (`config.yaml → rewind.
//     rate_limit_threshold`), no bloquea. Como barrera dura no sirve.
//
// Contrato: la clave es exactamente la tupla `{repo, pr, headRefOid}` (CA-9).
// Un `headRefOid` nuevo es un evento nuevo — el autor pusheó algo y el
// conflicto vale la pena re-evaluarlo.
//
// El nombre del archivo es el SHA-256 de la tupla, NUNCA una interpolación de
// `repo` (metadata externa que llega desde GitHub): así el path derivado es
// hexadecimal por construcción y `repo: "../../etc"` no puede escapar del
// directorio (CA-6). El `repo` original queda dentro del JSON, donde no
// participa de ningún path.
//
// Uso obligatorio: `has()` y `claim()` se evalúan SIEMPRE dentro del
// `withLock` canónico del issue (H-A1). Este módulo no toma locks propios —
// hacerlo escondería la exclusión mutua justo donde tiene que ser explícita.
//
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Nombre del directorio bajo `.pipeline/audit/`.
const DEDUPE_DIRNAME = 'rewinds-merge-dedupe';

// TTL por defecto de una entrada reclamada. No es una ventana de "reintento":
// el claim vive lo suficiente como para cubrir polls y reinicios del Pulpo, y
// se poda para que el directorio no crezca sin techo. 30 días alcanza de
// sobra — un PR conflictivo que sigue abierto un mes es un problema humano,
// no de idempotencia.
const DEFAULT_CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// `headRefOid` de GitHub es un SHA-1 (40 hex) hoy y un SHA-256 (64 hex) el
// día que GitHub migre. Aceptamos el rango, nunca texto libre.
const OID_RE = /^[0-9a-f]{7,64}$/;
// `owner/name` de GitHub: sólo el charset que GitHub admite en ambos tramos.
const REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * Directorio del store. No se crea acá — `claim()` lo crea con `recursive`.
 */
function dedupeDir(pipelineRoot) {
    return path.join(pipelineRoot, 'audit', DEDUPE_DIRNAME);
}

/**
 * Valida la tupla y la devuelve normalizada. Fail-closed: cualquier campo
 * ausente, de tipo incorrecto o fuera de charset tira con `code`.
 *
 * @returns {{repo: string, pr: number, headRefOid: string}}
 */
function normalizeTuple({ repo, pr, headRefOid } = {}) {
    if (typeof repo !== 'string' || !REPO_RE.test(repo)) {
        const e = new Error(`repo inválido para el dedupe: ${JSON.stringify(repo)}`);
        e.code = 'DEDUPE_REPO_INVALID';
        throw e;
    }
    const prNum = Number(pr);
    if (!Number.isInteger(prNum) || prNum <= 0) {
        const e = new Error(`pr inválido para el dedupe: ${JSON.stringify(pr)}`);
        e.code = 'DEDUPE_PR_INVALID';
        throw e;
    }
    if (typeof headRefOid !== 'string' || !OID_RE.test(headRefOid)) {
        const e = new Error('headRefOid inválido para el dedupe (se espera hex de 7 a 64 chars).');
        e.code = 'DEDUPE_OID_INVALID';
        throw e;
    }
    return { repo, pr: prNum, headRefOid };
}

/**
 * Clave de idempotencia: sha256 hex de `repo#pr@headRefOid`.
 *
 * Es también el nombre del archivo. Hexadecimal puro ⇒ no hay separador de
 * path, `..`, ni caracteres reservados de Windows que puedan viajar desde la
 * metadata del PR (CA-6).
 */
function dedupeKey(tuple) {
    const t = normalizeTuple(tuple);
    return crypto
        .createHash('sha256')
        .update(`${t.repo}#${t.pr}@${t.headRefOid}`, 'utf8')
        .digest('hex');
}

function dedupeFile(tuple, pipelineRoot) {
    return path.join(dedupeDir(pipelineRoot), `${dedupeKey(tuple)}.json`);
}

/**
 * Write atómico (tmp + fsync + rename con reintentos EPERM/EBUSY de Windows).
 *
 * Delega en `waves.atomicWriteFile`, que es la implementación canónica del
 * repo, pero SÓLO cuando el `fsImpl` efectivo es el `fs` real: `waves` cierra
 * sobre `require('node:fs')` y no acepta inyección. Con un `fsImpl` doble
 * (tests que no quieren tocar disco) caemos a un write directo — la
 * atomicidad es una propiedad del filesystem real, no del doble.
 */
function atomicWrite(targetPath, data, _fs) {
    if (_fs === fs) {
        // require lazy: `waves.js` es un módulo grande y este store se usa en
        // un camino frío. No queremos su costo de carga en cada require de
        // `pipeline-rewind`.
        const waves = require('./waves');
        waves.atomicWriteFile(targetPath, data);
        return;
    }
    _fs.writeFileSync(targetPath, data);
}

/**
 * ¿La tupla ya fue reclamada?
 *
 * SIEMPRE relee desde disco — nunca cachea en memoria de proceso. Es lo que
 * hace que un reinicio del Pulpo no re-dispare la transición (CA-9).
 *
 * @returns {null | {repo, pr, headRefOid, issue, claimed_at, outcome, key}}
 */
function has(tuple, pipelineRoot, opts = {}) {
    const _fs = opts.fsImpl || fs;
    const now = typeof opts.now === 'function' ? opts.now() : Date.now();
    const ttlMs = opts.ttlMs != null ? opts.ttlMs : DEFAULT_CLAIM_TTL_MS;
    const file = dedupeFile(tuple, pipelineRoot);

    let raw;
    try {
        raw = _fs.readFileSync(file, 'utf8');
    } catch (e) {
        if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null;
        throw e;
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // Entrada corrupta (crash a mitad de un write no atómico previo, disco
        // lleno). Fail-closed en la dirección segura para "como máximo una
        // transición": la tratamos como reclamada. El operador siempre tiene
        // el camino humano del rewind.
        return { key: dedupeKey(tuple), corrupt: true, claimed_at: null, outcome: null };
    }

    if (ttlMs > 0 && Number.isFinite(Number(parsed.claimed_at))) {
        if (now - Number(parsed.claimed_at) > ttlMs) return null;
    }
    return { ...parsed, key: dedupeKey(tuple) };
}

/**
 * Reclama la tupla. Se llama ANTES de mutar, no después: si el move falla, la
 * tupla queda reclamada y el watcher NO reintenta solo.
 *
 * Es la lectura fail-closed correcta de "como máximo una transición" (CA-9):
 * preferimos un rewind perdido —que el operador puede disparar a mano— antes
 * que un rewind duplicado que mueve archivos dos veces y mata dos agentes.
 *
 * @returns {{claimed: boolean, key: string, file: string, existing?: object}}
 */
function claim(tuple, pipelineRoot, opts = {}) {
    const _fs = opts.fsImpl || fs;
    const now = typeof opts.now === 'function' ? opts.now() : Date.now();
    const t = normalizeTuple(tuple);
    const key = dedupeKey(t);
    const file = dedupeFile(t, pipelineRoot);

    const existing = has(t, pipelineRoot, opts);
    if (existing) {
        return { claimed: false, key, file, existing };
    }

    _fs.mkdirSync(dedupeDir(pipelineRoot), { recursive: true });
    const payload = {
        repo: t.repo,
        pr: t.pr,
        headRefOid: t.headRefOid,
        issue: opts.issue != null ? Number(opts.issue) : null,
        claimed_at: now,
        outcome: opts.outcome || 'claimed',
    };
    atomicWrite(file, JSON.stringify(payload, null, 2), _fs);
    return { claimed: true, key, file };
}

/**
 * Actualiza el `outcome` de un claim ya existente (`done` / `move_failed` /
 * ...). Best-effort y no re-crea la entrada: si el claim no está, no hay nada
 * que anotar y devolvemos `false`. Nunca libera el claim — el dedupe no tiene
 * "unclaim" a propósito.
 */
function markOutcome(tuple, pipelineRoot, outcome, opts = {}) {
    const _fs = opts.fsImpl || fs;
    const file = dedupeFile(tuple, pipelineRoot);
    let parsed;
    try {
        parsed = JSON.parse(_fs.readFileSync(file, 'utf8'));
    } catch {
        return false;
    }
    parsed.outcome = String(outcome || '').slice(0, 64);
    parsed.outcome_at = typeof opts.now === 'function' ? opts.now() : Date.now();
    try {
        atomicWrite(file, JSON.stringify(parsed, null, 2), _fs);
        return true;
    } catch {
        return false;
    }
}

/**
 * Poda entradas más viejas que el TTL. Devuelve la cantidad borrada. Best
 * effort: cualquier entrada que no se pueda leer o borrar se saltea.
 */
function prune(pipelineRoot, opts = {}) {
    const _fs = opts.fsImpl || fs;
    const now = typeof opts.now === 'function' ? opts.now() : Date.now();
    const ttlMs = opts.ttlMs != null ? opts.ttlMs : DEFAULT_CLAIM_TTL_MS;
    if (!(ttlMs > 0)) return 0;
    const dir = dedupeDir(pipelineRoot);
    let entries = [];
    try { entries = _fs.readdirSync(dir); } catch { return 0; }
    let removed = 0;
    for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(dir, name);
        try {
            const parsed = JSON.parse(_fs.readFileSync(file, 'utf8'));
            if (now - Number(parsed.claimed_at) > ttlMs) {
                _fs.unlinkSync(file);
                removed++;
            }
        } catch {
            // Corrupta: la dejamos. `has()` la trata como reclamada, que es el
            // lado seguro; borrarla acá reabriría la ventana de duplicado.
        }
    }
    return removed;
}

module.exports = {
    DEDUPE_DIRNAME,
    DEFAULT_CLAIM_TTL_MS,
    dedupeDir,
    dedupeFile,
    dedupeKey,
    normalizeTuple,
    has,
    claim,
    markOutcome,
    prune,
};
