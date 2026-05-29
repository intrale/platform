// =============================================================================
// init-waves-from-partial.js — Bootstrap one-shot de waves.json desde
// .partial-pause.json (#3617).
//
// Por qué este módulo existe
// --------------------------
// El pipeline tiene DOS fuentes históricas de allowlist:
//
//   1. .partial-pause.json — allowlist operacional plana, fuente real del
//      Pulpo desde #2490. Lo manipulan Commander + Telegram /allow.
//   2. waves.json — source-of-truth multi-ola con planificación, history y
//      dependencias, agregado en #3489 con schema 1.0 e inicializado vacío.
//
// `lib/waves.js:getAllowlist()` ya cae a `.partial-pause.json` como fallback
// si waves.json.active_wave === null. Funciona, pero el widget "Próximas Olas"
// del dashboard muestra "Planificación no disponible" porque consulta waves.json
// y lo ve vacío. Operador opera ciego sobre la planificación.
//
// Este módulo cierra el gap con un **bootstrap one-shot al boot**:
//   - Si waves.json.active_wave === null Y .partial-pause.json tiene issues:
//     creamos una "Ola 1" sintética con esos issues como active_wave.
//   - Si waves.json.active_wave !== null: NO-OP (no sobreescribir canónica).
//   - Si .partial-pause.json no existe / está vacío: NO-OP.
//   - Si .partial-pause.json tiene shape inválida o issues no-numéricos:
//     ABORT con error tipado. Caller (pulpo.js) decide fail-closed.
//
// Política de seguridad (REQ-SEC-1..7 del comentario de `security` en #3617)
// --------------------------------------------------------------------------
// REQ-SEC-1: Validación estricta de shape — only `allowed_issues` se propaga.
//            Claves desconocidas → log WARN + ABORT (no mezclar contenido no
//            validado en source-of-truth).
// REQ-SEC-2: Fail-closed — si init falla, NO devolvemos allowlist vacía
//            silenciosa. Devolvemos { ok: false, error } y caller decide
//            pausar Pulpo (no procesar = default deny).
// REQ-SEC-3: Cubierto por desync-detector existente + nuevo desync-ack
//            (no es responsabilidad de este módulo).
// REQ-SEC-4: Audit log de bootstrap en `.pipeline/audit/waves-bootstrap.jsonl`
//            (append-only chained vía `lib/audit-log.js`).
// REQ-SEC-5: TODA la transacción corre bajo `withLockSync(wavesFile)`.
//            Adquirir lock ANTES de leer `.partial-pause.json` (no TOCTOU).
// REQ-SEC-6: Cubierto por desync-clean-cycles counter (no acá).
// REQ-SEC-7: `pipelineDir()` solo deriva de `__dirname` o
//            `PIPELINE_DIR_OVERRIDE`. No acepta paths libres por CLI.
//
// Idempotencia: re-correr este módulo con waves.json ya poblado es no-op.
// No debe overwritear ni duplicar.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { withLockSync } = require('./file-lock');
const { atomicWriteFile } = require('./waves');
const { notifyTelegram } = require('./notify-telegram');
const auditLog = require('./audit-log');

// REQ-SEC-1: whitelist explícita de keys conocidas/seguras en .partial-pause.json.
// Cualquier otra clave → reject (no propagamos contenido no validado).
// La lista refleja todo lo que setPartialPause/Commander/Telegram pueden escribir:
//   - allowed_issues       — la allowlist (required)
//   - created_at           — timestamp de creación
//   - source               — quién escribió (telegram, commander, /wave)
//   - accepted_dep_risk    — #2893
//   - dep_sources          — #2893
//   - restored_at          — flag de restore manual
//   - reason               — anotación humana
//   - triggered_at         — timestamp del trigger
//   - triggered_by         — origen del trigger
//   - paused / partial / mode — flags legacy convivientes
const KNOWN_PARTIAL_KEYS = new Set([
    'allowed_issues',
    'created_at',
    'source',
    'accepted_dep_risk',
    'dep_sources',
    'restored_at',
    'reason',
    'triggered_at',
    'triggered_by',
    'paused',
    'partial',
    'mode',
    'createdAt',
    'depRoots',
    'dep_roots',
]);

// REQ-SEC-1 hard guard: payload máximo del .partial-pause.json. Defensa ante
// un attacker que infle el archivo con basura para forzar OOM en el boot.
// 10MB es muy generoso (allowlist real máxima ~100 issues × ~30 bytes c/u
// ≈ 3KB). Si se supera, abortamos.
const MAX_PARTIAL_SIZE_BYTES = 10 * 1024 * 1024;

// Lock acquisition: 5s timeout, 3 retries (mismo patrón que waves.js).
const LOCK_TIMEOUT_MS = 5000;
const LOCK_MAX_RETRIES = 3;

// ─── Paths ──────────────────────────────────────────────────────────────────

function pipelineDir() {
    // REQ-SEC-7: SOLO override por env reconocido o derivación desde __dirname.
    // NO aceptar CLI args ni paths libres.
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.join(__dirname, '..');
}

function wavesFile() { return path.join(pipelineDir(), 'waves.json'); }
function partialFile() { return path.join(pipelineDir(), '.partial-pause.json'); }
function auditFile() { return path.join(pipelineDir(), 'audit', 'waves-bootstrap.jsonl'); }

/**
 * Defensa en profundidad ante symlink traversal — equivalente a
 * `assertArchivedDirSafe` en waves.js pero para el target de waves.json.
 * Si el path resuelto sale del pipelineDir (porque alguien metió un symlink
 * apuntando afuera), abortamos.
 */
function assertWavesPathSafe() {
    const root = path.resolve(pipelineDir());
    const target = path.resolve(wavesFile());
    if (target !== path.join(root, 'waves.json')) {
        throw new Error(`waves.json fuera de pipelineDir: ${target}`);
    }
    if (fs.existsSync(target)) {
        let real;
        try { real = fs.realpathSync(target); } catch { real = target; }
        if (path.resolve(real) !== target) {
            throw new Error(`waves.json es symlink fuera de pipelineDir: ${real}`);
        }
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function nowIso() {
    return new Date().toISOString();
}

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function logInfo(msg) {
    console.log(`[init-waves] ${msg}`);
}

function logWarn(msg) {
    console.warn(`[init-waves] ${msg}`);
}

function normalizeIssue(issue) {
    const n = Number(String(issue).trim().replace(/^#/, ''));
    return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * REQ-SEC-1: Lee .partial-pause.json y valida shape ESTRICTAMENTE.
 *
 * Retorna { ok, issues, sourceBytes, errors }.
 * - ok: false si alguna validación falla. issues=[] en ese caso.
 * - ok: true con issues=[] si el archivo no existe (no-op aguas arriba).
 *
 * Razones de rechazo (ok=false):
 *   - Archivo más grande que MAX_PARTIAL_SIZE_BYTES
 *   - JSON inválido
 *   - Top-level no es objeto
 *   - allowed_issues ausente o no-array
 *   - Algún issue de allowed_issues no es entero positivo válido
 *   - Aparece una clave fuera de KNOWN_PARTIAL_KEYS
 */
function readPartialStrict() {
    const file = partialFile();
    const errors = [];
    let st;
    try {
        st = fs.statSync(file);
    } catch (err) {
        if (err && err.code === 'ENOENT') {
            return { ok: true, issues: [], sourceBytes: null, errors: [] };
        }
        errors.push(`stat falló: ${err.message}`);
        return { ok: false, issues: [], sourceBytes: null, errors };
    }
    if (st.size > MAX_PARTIAL_SIZE_BYTES) {
        errors.push(`.partial-pause.json supera el máximo permitido (${st.size} > ${MAX_PARTIAL_SIZE_BYTES} bytes)`);
        return { ok: false, issues: [], sourceBytes: null, errors };
    }
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        errors.push(`read falló: ${err.message}`);
        return { ok: false, issues: [], sourceBytes: null, errors };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        errors.push(`JSON inválido: ${err.message}`);
        return { ok: false, issues: [], sourceBytes: raw, errors };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        errors.push('top-level no es objeto');
        return { ok: false, issues: [], sourceBytes: raw, errors };
    }
    // REQ-SEC-1: rechazar claves desconocidas.
    for (const k of Object.keys(parsed)) {
        if (!KNOWN_PARTIAL_KEYS.has(k)) {
            errors.push(`clave desconocida no admitida: "${k}"`);
        }
    }
    if (!Array.isArray(parsed.allowed_issues)) {
        errors.push('allowed_issues ausente o no es array');
    }
    if (errors.length > 0) {
        return { ok: false, issues: [], sourceBytes: raw, errors };
    }
    const issues = [];
    for (const item of parsed.allowed_issues) {
        const n = normalizeIssue(item);
        if (!n) {
            errors.push(`elemento inválido en allowed_issues: ${JSON.stringify(item)} (debe ser entero positivo)`);
            continue;
        }
        issues.push(n);
    }
    if (errors.length > 0) {
        return { ok: false, issues: [], sourceBytes: raw, errors };
    }
    // Deduplicar preservando orden.
    const seen = new Set();
    const unique = [];
    for (const n of issues) {
        if (!seen.has(n)) { seen.add(n); unique.push(n); }
    }
    return { ok: true, issues: unique, sourceBytes: raw, errors: [] };
}

/**
 * Lee waves.json desde disco. Retorna null si no existe o si JSON inválido.
 */
function readWavesRaw() {
    const file = wavesFile();
    if (!fs.existsSync(file)) return null;
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/**
 * Construye el state inicial de waves.json para bootstrap.
 *
 * - Crea Wave #1 "Bootstrap from .partial-pause.json" con los issues importados.
 * - meta.note formato trazable (G-UX-5): "bootstrap automatic from
 *   .partial-pause.json on <ISO ts>, source_sha256=<hash>".
 */
function buildBootstrappedState(issues, sourceSha256) {
    const ts = nowIso();
    return {
        version: '1.0',
        meta: {
            created_at: ts,
            updated_at: ts,
            updated_by: 'init-waves-from-partial',
            source: 'auto-bootstrap',
            note: `bootstrap automatic from .partial-pause.json on ${ts}, source_sha256=${sourceSha256}`,
        },
        active_wave: {
            number: 1,
            name: 'Bootstrap from .partial-pause.json',
            goal: 'Estado inicial sintetizado desde la allowlist operativa pre-existente. Promover una nueva ola desde Commander cuando esté listo.',
            started_at: ts,
            issues: issues.map((n) => ({ number: n })),
        },
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
    };
}

/**
 * REQ-SEC-4: Append-only audit del bootstrap.
 *
 * Entry shape:
 *   {
 *     ts: ISO,
 *     pid, hostname,
 *     source_sha256, result_sha256,
 *     imported_count, imported_issues,
 *     source: 'auto-bootstrap' | 'manual',
 *     outcome: 'ok' | 'noop' | 'error',
 *     error?, errors?
 *   }
 *
 * Best-effort: si appendChained falla, log + continúa (audit perdido no
 * debe romper el bootstrap mismo). Pero loggeamos WARN para visibilidad.
 */
function appendAuditEntry(entry) {
    const file = auditFile();
    try {
        try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch {}
        const payload = {
            ts: entry.ts || nowIso(),
            pid: entry.pid || process.pid,
            hostname: entry.hostname || os.hostname(),
            source: entry.source || 'auto-bootstrap',
            outcome: entry.outcome || 'ok',
            source_sha256: entry.source_sha256 || null,
            result_sha256: entry.result_sha256 || null,
            imported_count: entry.imported_count || 0,
            imported_issues: entry.imported_issues || [],
            error: entry.error || null,
            errors: entry.errors || null,
        };
        auditLog.appendChained({ file, entry: payload });
    } catch (err) {
        logWarn(`audit append falló: ${err.message}`);
    }
}

// ─── API pública ────────────────────────────────────────────────────────────

/**
 * Ejecuta el bootstrap de waves.json desde .partial-pause.json.
 *
 * Flujo (todo bajo lock — REQ-SEC-5):
 *
 *   1. assertWavesPathSafe() — REQ-SEC-7
 *   2. Adquirir withLockSync(wavesFile)
 *   3. Re-leer waves.json bajo lock. Si active_wave !== null → no-op idempotente.
 *   4. readPartialStrict() — REQ-SEC-1. Si no-ok → ABORT.
 *   5. Si issues=[] → no-op (no hay nada que importar).
 *   6. buildBootstrappedState(issues, sha256(source))
 *   7. atomicWriteFile(wavesFile, JSON.stringify(state))
 *   8. appendAuditEntry(...) — REQ-SEC-4
 *   9. Return { ok: true, action: 'bootstrapped' | 'noop', ... }
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.skipNotify=false] — si true, no manda Telegram en error
 *                                            (útil para tests).
 * @returns {{
 *   ok: boolean,
 *   action: 'bootstrapped' | 'noop' | 'error',
 *   reason?: string,
 *   issues?: number[],
 *   source_sha256?: string,
 *   result_sha256?: string,
 *   errors?: string[],
 * }}
 */
function initWavesFromPartial(opts = {}) {
    const skipNotify = opts.skipNotify === true;

    // REQ-SEC-7: validar paths antes de cualquier IO destructivo.
    try {
        assertWavesPathSafe();
    } catch (err) {
        const result = { ok: false, action: 'error', reason: err.message, errors: [err.message] };
        appendAuditEntry({ outcome: 'error', error: err.message });
        if (!skipNotify) {
            try {
                notifyTelegram({
                    level: 'error',
                    component: 'waves-bootstrap',
                    message: 'Bootstrap de waves.json: path inseguro',
                    detail: err.message.slice(0, 380),
                    action: 'Pipeline NO arrancó dispatch. Revisar symlinks en .pipeline/waves.json.',
                    diag: 'ls -la .pipeline/waves.json && realpath .pipeline/waves.json',
                });
            } catch {}
        }
        return result;
    }

    // REQ-SEC-5: TODA la transacción bajo lock.
    return withLockSync(wavesFile(), () => {
        return initWavesFromPartialLocked(opts);
    }, {
        component: 'waves-bootstrap',
        timeoutMs: LOCK_TIMEOUT_MS,
        maxRetries: LOCK_MAX_RETRIES,
        notify: skipNotify ? null : notifyTelegram,
    });
}

function initWavesFromPartialLocked(opts = {}) {
    const skipNotify = opts.skipNotify === true;

    // Idempotencia: si waves.json ya tiene canónica, salir sin tocar nada.
    const existing = readWavesRaw();
    if (existing && existing.active_wave) {
        return { ok: true, action: 'noop', reason: 'active_wave_already_set' };
    }

    // REQ-SEC-1: validación shape ESTRICTA de .partial-pause.json.
    const partial = readPartialStrict();
    if (!partial.ok) {
        const reason = `shape inválida en .partial-pause.json: ${partial.errors.join('; ')}`;
        logWarn(reason);
        appendAuditEntry({
            outcome: 'error',
            error: reason,
            errors: partial.errors,
            source_sha256: partial.sourceBytes ? sha256(partial.sourceBytes) : null,
        });
        if (!skipNotify) {
            try {
                notifyTelegram({
                    level: 'error',
                    component: 'waves-bootstrap',
                    message: 'Bootstrap de waves.json abortado por shape inválida',
                    detail: partial.errors.slice(0, 3).join('; ').slice(0, 380),
                    action: 'Pipeline NO procesa issues hasta corregir .partial-pause.json. Revisar audit log y re-disparar bootstrap.',
                    diag: 'cat .pipeline/audit/waves-bootstrap.jsonl | tail -1 | jq',
                });
            } catch {}
        }
        return { ok: false, action: 'error', reason, errors: partial.errors };
    }

    // Sin issues que importar → no-op (no hay nada que bootstrappear).
    if (partial.issues.length === 0) {
        appendAuditEntry({
            outcome: 'noop',
            imported_count: 0,
            imported_issues: [],
            source_sha256: partial.sourceBytes ? sha256(partial.sourceBytes) : null,
        });
        return { ok: true, action: 'noop', reason: 'partial_pause_empty', issues: [] };
    }

    const sourceSha = sha256(partial.sourceBytes);
    const state = buildBootstrappedState(partial.issues, sourceSha);
    const serialized = JSON.stringify(state, null, 2);
    const resultSha = sha256(serialized);

    try {
        atomicWriteFile(wavesFile(), serialized);
    } catch (err) {
        const reason = `atomicWriteFile falló: ${err.message}`;
        logWarn(reason);
        appendAuditEntry({
            outcome: 'error',
            error: reason,
            source_sha256: sourceSha,
        });
        if (!skipNotify) {
            try {
                notifyTelegram({
                    level: 'error',
                    component: 'waves-bootstrap',
                    message: 'Bootstrap de waves.json: write falló',
                    detail: reason.slice(0, 380),
                    action: 'Pipeline NO procesa issues. Revisar permisos/disk en .pipeline/.',
                    diag: 'ls -la .pipeline/waves.json* .pipeline/audit/',
                });
            } catch {}
        }
        return { ok: false, action: 'error', reason, errors: [reason] };
    }

    appendAuditEntry({
        outcome: 'ok',
        imported_count: partial.issues.length,
        imported_issues: partial.issues,
        source_sha256: sourceSha,
        result_sha256: resultSha,
    });

    logInfo(`waves.json bootstrappeado desde .partial-pause.json — ${partial.issues.length} issues importados.`);

    return {
        ok: true,
        action: 'bootstrapped',
        issues: partial.issues,
        source_sha256: sourceSha,
        result_sha256: resultSha,
    };
}

module.exports = {
    initWavesFromPartial,
    // Helpers expuestos para tests
    _internal: {
        readPartialStrict,
        readWavesRaw,
        buildBootstrappedState,
        appendAuditEntry,
        assertWavesPathSafe,
        normalizeIssue,
        KNOWN_PARTIAL_KEYS,
        MAX_PARTIAL_SIZE_BYTES,
        _paths: () => ({
            WAVES_FILE: wavesFile(),
            PARTIAL_FILE: partialFile(),
            AUDIT_FILE: auditFile(),
        }),
    },
};
