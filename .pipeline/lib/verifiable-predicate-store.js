// =============================================================================
// verifiable-predicate-store.js — Canal SEPARADO para el predicado verificable
// del freeze de `delivery` (#6611).
//
// POR QUÉ UN CANAL PROPIO (requisito CRÍTICO de `security`)
// --------------------------------------------------------
// El predicado que habilita el auto-destrabe NO puede viajar por los motivos
// YAML de rechazo: esos los escribe un agente LLM, y `classifyPrecondition`
// los lee. Si el predicado entrara por ahí, un agente — o un prompt-injection
// leído de un PR de terceros — podría fabricarse su propio `precondition`
// verificable y levantarse solo un freeze humano, reinyectando el issue al
// camino de merge a `main`. Elevación de privilegio directa.
//
// Por eso el predicado nace en UN solo emisor autorizado
// (`skills-deterministicos/delivery.js`, gate `branch-protection-other`),
// viaja por este sidecar y `classifyPrecondition` NUNCA lo ve.
//
// El residual conocido — un agente con acceso al FS podría escribir el sidecar —
// lo cierra el selector puro, no este módulo: la liberación exige que el
// `headRefName` OBSERVADO en GitHub matchee `agent/<issue>-`. Apuntar el
// predicado a cualquier PR verde del repo no alcanza.
//
// PERSISTENCIA: `.pipeline/state/verifiable-predicates/<issue>.json`
//   { "issue": 6145,
//     "predicate": { "kind": "pr_merge_blocked", "pr": 6593,
//                    "head_ref": "agent/6145-...",
//                    "observed": { "httpStatus": 405, ... } },
//     "recorded_at": "...", "ttl_expires_at": "..." }
//
// GARANTÍAS
// ---------
// - **Fail-open ante IO**: cualquier error → no-op / `null`. Este sidecar jamás
//   puede romper el freeze; su ausencia sólo significa "sin predicado" y eso
//   degrada a juicio humano, que es el comportamiento de HOY (fail-closed).
// - **One-shot**: `consume` borra el archivo. El predicado se usa en el freeze
//   que lo motivó, no queda flotando para uno futuro.
// - **TTL corto (~30 min)**: la vida entre el gate-block de `delivery` y el
//   barrido del pulpo que congela. Vencido ⇒ `null`.
// - **0o600**: espejo de `agent-launcher/spawn-failure-state.js`.
// - **Sin contenido del issue**: sólo metadata de control.
// - **`issue` coaccionado a entero positivo antes de tocar el path**: el número
//   se interpola en un nombre de archivo; un `../` ahí sería escritura fuera
//   del directorio de estado.
//
// Node puro (fs, path). Sin dependencias externas.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Ventana entre el gate-block de `delivery` y el barrido del pulpo que congela.
const DEFAULT_TTL_MS = 30 * 60 * 1000;

// Enum CERRADO de kinds. Un solo kind a propósito: la generalización es #6616.
const PREDICATE_KINDS = Object.freeze(['pr_merge_blocked']);

/**
 * Coacciona el issue a entero positivo. Devuelve `null` si no lo es.
 * Es la única puerta entre un valor externo y un path del filesystem.
 */
function safeIssue(issue) {
    const n = Number(issue);
    if (!Number.isInteger(n) || n <= 0) return null;
    return n;
}

function stateDir(pipelineDir) {
    return path.join(pipelineDir, 'state', 'verifiable-predicates');
}

function stateFile(pipelineDir, issue) {
    const n = safeIssue(issue);
    if (n == null) return null;
    return path.join(stateDir(pipelineDir), n + '.json');
}

/**
 * Valida la FORMA del predicado antes de persistirlo. Defensa en profundidad:
 * la validación autoritativa es `human-block.normalizePrecondition`, pero un
 * predicado deforme no tiene por qué llegar siquiera a ocupar disco.
 * @returns {object|null} predicado normalizado, o null si es inválido.
 */
function normalizePredicate(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    if (typeof p.kind !== 'string' || !PREDICATE_KINDS.includes(p.kind)) return null;
    // Entero positivo ESTRICTO, sin coerción: misma regla que
    // `human-block.normalizePrecondition`. Si acá coaccionáramos `"00042"` a 42
    // y allá se rechazara, tendríamos dos validadores que discrepan sobre el
    // mismo dato — el sidecar guardaría un predicado que el marker después
    // degrada a juicio humano, en silencio. La coerción va en el BORDE (el
    // emisor de `delivery`), no en el validador.
    if (!Number.isInteger(p.pr) || p.pr <= 0) return null;
    if (typeof p.head_ref !== 'string' || !p.head_ref.trim()) return null;
    const out = { kind: p.kind, pr: p.pr, head_ref: p.head_ref.trim() };
    // `observed` es NARRATIVA: se persiste para el comentario y la auditoría,
    // y NUNCA entra a la decisión de liberar (ver selector puro).
    if (p.observed && typeof p.observed === 'object' && !Array.isArray(p.observed)) {
        out.observed = {
            httpStatus: Number.isFinite(Number(p.observed.httpStatus)) ? Number(p.observed.httpStatus) : null,
            mergeStateStatus: typeof p.observed.mergeStateStatus === 'string'
                ? p.observed.mergeStateStatus.slice(0, 40) : null,
            gate: typeof p.observed.gate === 'string' ? p.observed.gate.slice(0, 60) : null,
        };
    }
    return out;
}

// Escritura atómica 0o600. Best-effort: errores de IO se silencian (fail-open).
function writeAtomic(file, data, fsImpl) {
    const _fs = fsImpl || fs;
    try {
        _fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
        const fd = _fs.openSync(tmp, 'w', 0o600);
        try {
            _fs.writeSync(fd, JSON.stringify(data, null, 2));
            try { _fs.fsyncSync(fd); } catch { /* best-effort */ }
        } finally {
            try { _fs.closeSync(fd); } catch { /* best-effort */ }
        }
        _fs.renameSync(tmp, file);
        return true;
    } catch {
        return false;
    }
}

/**
 * record — persiste el predicado verificable de un issue. Idempotente:
 * re-registrar pisa el anterior y refresca el TTL.
 *
 * @param {object} opts
 * @param {string} opts.pipelineDir
 * @param {number|string} opts.issue
 * @param {object} opts.predicate  { kind, pr, head_ref, observed? }
 * @param {number} [opts.ttlMs]
 * @param {number} [opts.now]
 * @param {object} [opts.fsImpl]
 * @returns {boolean} true si persistió.
 */
function record(opts = {}) {
    const { pipelineDir } = opts;
    if (!pipelineDir) return false;
    const issue = safeIssue(opts.issue);
    if (issue == null) return false;
    const predicate = normalizePredicate(opts.predicate);
    if (!predicate) return false;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
    const file = stateFile(pipelineDir, issue);
    if (!file) return false;
    return writeAtomic(file, {
        issue,
        predicate,
        recorded_at: new Date(now).toISOString(),
        ttl_expires_at: new Date(now + ttlMs).toISOString(),
    }, opts.fsImpl);
}

/**
 * peek — devuelve el predicado activo SIN removerlo. `null` si no hay, si
 * venció o si el archivo es ilegible/deforme.
 */
function peek(opts = {}) {
    const { pipelineDir } = opts;
    if (!pipelineDir) return null;
    const issue = safeIssue(opts.issue);
    if (issue == null) return null;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const _fs = opts.fsImpl || fs;
    const file = stateFile(pipelineDir, issue);
    if (!file) return null;
    try {
        if (!_fs.existsSync(file)) return null;
        const parsed = JSON.parse(_fs.readFileSync(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object') return null;
        const exp = parsed.ttl_expires_at ? Date.parse(parsed.ttl_expires_at) : NaN;
        // Sin TTL válido ⇒ vencido (defensivo: no honrar un sidecar sin caducidad).
        if (!Number.isFinite(exp) || now >= exp) return null;
        return normalizePredicate(parsed.predicate);
    } catch {
        return null;
    }
}

/**
 * consume — devuelve el predicado activo y BORRA el sidecar (one-shot).
 * Fail-open: cualquier error → `null`. El borrado se intenta siempre que el
 * archivo exista, incluso si estaba vencido o deforme (drenado de basura).
 *
 * @returns {object|null} predicado `{kind, pr, head_ref, observed?}` o null.
 */
function consume(opts = {}) {
    const { pipelineDir } = opts;
    if (!pipelineDir) return null;
    const issue = safeIssue(opts.issue);
    if (issue == null) return null;
    const _fs = opts.fsImpl || fs;
    const file = stateFile(pipelineDir, issue);
    if (!file) return null;
    const found = peek(opts);
    try {
        if (_fs.existsSync(file)) _fs.unlinkSync(file);
    } catch { /* fail-open: el TTL lo termina venciendo igual */ }
    return found;
}

module.exports = {
    record,
    peek,
    consume,
    stateDir,
    stateFile,
    normalizePredicate,
    PREDICATE_KINDS,
    DEFAULT_TTL_MS,
};
