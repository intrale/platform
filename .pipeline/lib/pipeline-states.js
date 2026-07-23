// =============================================================================
// pipeline-states.js — Puntos de no retorno del pipeline V3 (#3417).
//
// Define la lista cerrada de estados terminales desde los cuales un rebobinado
// (`/rechazar`, #3416) NO puede ni debe ejecutarse. Es la guard que
// el listener de `pipeline.rejection` consume ANTES de cualquier side-effect.
//
// -----------------------------------------------------------------------------
// CONTRATO DE CONSUMO (lee esto antes de invocar `isNoReturnState`)
// -----------------------------------------------------------------------------
//
// 1) LOCK PRIMERO (SEC-NR-2 / CA-5). El consumer DEBE adquirir un lock
//    `.pipeline/locks/rewind-<issue>.lock` con `fs.openSync(p, 'wx')` (creación
//    atómica O_EXCL) ANTES de llamar a `isNoReturnState(issue)` y mantenerlo
//    hasta que el rewind (o el bloqueo) complete. El lock cierra el TOCTOU:
//    sin él, otro proceso podría mergear el PR entre el check y la acción.
//
//    - Lock huérfano (PID en el archivo ya no existe en el sistema) → romper
//      idempotentemente (mismo patrón que `lib/handoff.js`). NO usar TTL
//      absoluto: rewinds legítimos pueden tocar varias fases y tardar.
//    - Lock tomado por proceso vivo → abortar con mensaje al operador
//      "rebobinado en curso, intentá en unos segundos".
//
// 2) VALIDATE-FIRST, ACT-SECOND (SEC-NR-4 / CA-7). El consumer DEBE invocar
//    `isNoReturnState` ANTES de cualquier efecto colateral del rewind:
//
//      ✗ Antes de matar el PID del agente activo.
//      ✗ Antes de mover archivos `trabajando/` → `pendiente/`.
//      ✗ Antes de borrar `.po/.ux/.plan/.dev/.qa` de fases posteriores.
//      ✗ Antes de aplicar labels a GH.
//
//    Si `isNoReturnState` retorna `{ blocked: true, ... }` el sistema queda
//    en el estado original SIN PERTURBAR NADA. Es responsabilidad del consumer
//    cumplir esto, validado por test E2E en #3416.
//
// 3) AUDIT LOG OBLIGATORIO (SEC-NR-5 / CA-8). Después de un bloqueo el
//    consumer DEBE llamar `appendBlockedRejection(...)` para persistir la
//    entry en `.pipeline/audit/rejections-blocked.jsonl` (hash chain SHA-256
//    via `lib/audit-log.js`). NO inventar otro append-only.
//
// 4) FAIL-CLOSED (CA-3). Ante error de GH API, timeout, JSON malformado o
//    ambigüedad, `isNoReturnState` retorna `blocked: true, reason:
//    'github_api_unavailable'`. NUNCA permite el rewind ante incertidumbre.
//
// 5) MENSAJES CURADOS (SEC-NR-6 / CA-9). Para el texto al operador, usar
//    `formatBlockedMessage(result)`. NO interpolar libremente
//    `result.reason_details.error` — el dictionary tiene templates curados
//    que no revelan paths absolutos, tags Kodein ni stacks técnicos.
//
// -----------------------------------------------------------------------------
// CONSUMERS PREVISTOS
// -----------------------------------------------------------------------------
//
//   - Listener `pipeline.rejection` (#3416). Llama `isNoReturnState` con el
//     lock tomado, ejecuta el rewind o el bloqueo según el veredicto, y
//     persiste el audit log.
//
//   - Commander (#3415) NO consume directamente este módulo: el flujo es
//     Commander → emite evento `pipeline.rejection` → listener → este módulo.
//
// -----------------------------------------------------------------------------
// FUENTES DE VERDAD (CA-4)
// -----------------------------------------------------------------------------
//
//   - GitHub REST API (`gh api repos/intrale/platform/issues/<N>`) para
//     `state`, `closedAt`, `stateReason`, `labels`.
//   - PR search vía `pr-info-fetcher.js` (`gh pr list --search head:agent/<N>-`)
//     para detectar PR mergeado (campo `mergedAt`).
//   - Filesystem `.pipeline/<pipeline>/<fase>/archivado/<N>.*` para detectar
//     archivado por reconciler (único caso donde FS es autoritativo).
//
// NUNCA consultar: cache local de labels, HEAD de worktrees, archivos
// `.pipeline/desarrollo/aprobacion/procesado/<N>.delivery` para deducir
// "delivery finalizado" (pueden estar desincronizados).
//
// =============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const auditLog = require('./audit-log');
const { redactSensitive } = require('./redact');
const { fetchPrInfoForIssue } = require('./pr-info-fetcher');

// =============================================================================
// Constantes
// =============================================================================

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PIPELINE_DIR = path.join(REPO_ROOT, '.pipeline');
const AUDIT_DIR = path.join(PIPELINE_DIR, 'audit');
const AUDIT_FILE = path.join(AUDIT_DIR, 'rejections-blocked.jsonl');

const GH_API_TIMEOUT_MS = 5000;      // CA-2: 5s, no 30s — operador espera.
const GH_BIN_DEFAULT = process.platform === 'win32' ? 'C:/Workspaces/gh-cli/bin/gh' : 'gh';
const REPO = 'intrale/platform';

const MAX_ISSUE_NUMBER = 10_000_000; // CA-6: límite superior razonable.
const RAW_COMMAND_PREVIEW_MAX_LEN = 200;

// CA-1 — Lista cerrada de reasons de no retorno. Es la única fuente de
// verdad de qué estados bloquean. Cualquier consumer debe operar contra
// esta constante (en vez de hardcodear strings).
const NO_RETURN_STATES = Object.freeze([
    'pr_merged',
    'issue_closed',
    'label_wontfix',
    'label_duplicate',
    'label_invalid',
    'archived',
    'github_api_unavailable',
]);

// Labels de GitHub que disparan reason `label_<X>`. Mantener sincronizado
// con NO_RETURN_STATES (el test de coherencia valida que la unión cubra
// todos los `label_*`).
const TERMINAL_LABELS = Object.freeze(['wontfix', 'duplicate', 'invalid']);

// Pipelines/fases con directorio `archivado/`. Mantener sincronizado con
// `config.yaml > pipelines.<x>.fases`. El test SEC-NR-7 valida que no se
// agreguen fases nuevas sin actualizar esta lista.
const ARCHIVADO_PHASES = Object.freeze([
    { pipeline: 'definicion',  fase: 'analisis' },
    { pipeline: 'definicion',  fase: 'criterios' },
    { pipeline: 'definicion',  fase: 'sizing' },
    { pipeline: 'desarrollo',  fase: 'validacion' },
    { pipeline: 'desarrollo',  fase: 'dev' },
    { pipeline: 'desarrollo',  fase: 'build' },
    { pipeline: 'desarrollo',  fase: 'verificacion' },
    { pipeline: 'desarrollo',  fase: 'linteo' },
    { pipeline: 'desarrollo',  fase: 'aprobacion' },
    { pipeline: 'desarrollo',  fase: 'entrega' },
]);

// CA-9 / G-UX-1..G-UX-4 — Dictionary fijo de mensajes al operador, en
// español argentinizado, sin variantes rotativas (reconocimiento de patrón
// instantáneo en bloqueos operacionales).
//
// Convenciones:
//   - ❌ para bloqueos definitivos (todos los reasons salvo
//     `github_api_unavailable`, que es ⏳ porque admite retry).
//   - **negrita** sobre el motivo principal.
//   - Acción correctiva concreta al final.
//   - Placeholders: `{issue}`, `{prNumber}`, `{mergedAt}`, `{closedAt}`,
//     `{label}` (interpolados por `formatBlockedMessage`, NO concatenación
//     libre del consumer).
const BLOCKED_REASON_TO_USER_MSG = Object.freeze({
    pr_merged:
        '❌ No se puede rebobinar #{issue} — está en estado **delivery finalizado** ' +
        '(PR #{prNumber} mergeado el {mergedAt}). Si querés cambiar algo, abrí un ' +
        'issue nuevo.',
    issue_closed:
        '❌ No se puede rebobinar #{issue} — el issue fue **cerrado manualmente** ' +
        'el {closedAt}. Si querés reabrirlo, hacelo desde GitHub primero.',
    label_wontfix:
        '❌ No se puede rebobinar #{issue} — está marcado como **wontfix**, es un ' +
        'estado terminal del backlog.',
    label_duplicate:
        '❌ No se puede rebobinar #{issue} — está marcado como **duplicate**, es un ' +
        'estado terminal del backlog.',
    label_invalid:
        '❌ No se puede rebobinar #{issue} — está marcado como **invalid**, es un ' +
        'estado terminal del backlog.',
    archived:
        '❌ No se puede rebobinar #{issue} — fue **archivado por el reconciler**. ' +
        'Si querés reactivarlo, sacalo del directorio archivado primero.',
    github_api_unavailable:
        '⏳ No pude verificar el estado de #{issue} ahora mismo. Probá de nuevo en ' +
        'unos segundos.',
});

// =============================================================================
// Helpers internos
// =============================================================================

/**
 * Valida el parámetro `issue` (SEC-NR-3 / CA-6). Acepta enteros positivos
 * acotados; rechaza NaN, strings, decimales, objects, null, undefined, 0,
 * negativos y números fuera del rango razonable.
 *
 * @param {*} issue
 * @returns {number} issue normalizado
 * @throws {TypeError} si el input no es un entero válido en el rango.
 */
function validateIssueNumber(issue) {
    if (!Number.isInteger(issue) || issue <= 0 || issue >= MAX_ISSUE_NUMBER) {
        throw new TypeError(
            `[pipeline-states] número de issue inválido: ${String(issue)} ` +
            `(esperado entero entre 1 y ${MAX_ISSUE_NUMBER - 1}).`
        );
    }
    return issue;
}

/**
 * Resuelve el path al archivo archivado de un issue en una fase específica,
 * con prefix check para defenderse contra path traversal (CA-6).
 *
 * Retorna `null` si el path resultante escapa del prefijo permitido.
 *
 * @param {number} issue
 * @param {string} pipeline
 * @param {string} fase
 * @param {string} [rootOverride] inyectable para tests
 * @returns {string|null}
 */
function resolveArchivadoGlob(issue, pipeline, fase, rootOverride) {
    const root = rootOverride || PIPELINE_DIR;
    const baseDir = path.resolve(root, pipeline, fase, 'archivado');
    const expected = path.resolve(root, pipeline, fase, 'archivado');
    // CA-6: si por alguna razón resolve no matchea (no debería pasar con
    // primitivos validados, pero defensa en profundidad) → rechazar.
    if (baseDir !== expected) return null;
    return baseDir;
}

/**
 * Busca un archivo del issue dentro de algún `archivado/` del pipeline.
 * Match por prefijo: `<N>.<skill>` (convención de archivos de trabajo).
 *
 * @param {number} issue
 * @param {object} [opts]
 * @param {string} [opts.root] override del PIPELINE_DIR para tests
 * @param {object} [opts.fsImpl]
 * @returns {{found: boolean, pipeline?: string, fase?: string, file?: string}}
 */
function findInArchivado(issue, opts) {
    const o = opts || {};
    const root = o.root || PIPELINE_DIR;
    const _fs = o.fsImpl || fs;
    const needle = `${issue}.`;
    for (const { pipeline, fase } of ARCHIVADO_PHASES) {
        const dir = resolveArchivadoGlob(issue, pipeline, fase, root);
        if (!dir) continue;
        if (!_fs.existsSync(dir)) continue;
        let entries;
        try {
            entries = _fs.readdirSync(dir);
        } catch {
            continue;
        }
        for (const f of entries) {
            // CA-6: el path final debe seguir dentro del directorio archivado.
            const candidate = path.resolve(dir, f);
            if (!candidate.startsWith(dir + path.sep) && candidate !== dir) continue;
            if (f === String(issue) || f.startsWith(needle)) {
                return { found: true, pipeline, fase, file: f };
            }
        }
    }
    return { found: false };
}

// Patrones de "key=value" en texto plano operativo (sin separador URL).
// Captura el valor hasta whitespace/coma/punto-y-coma/comilla.
// Lista basada en SENSITIVE_QUERY_KEYS pero adaptada a free-text input.
const BARE_KV_REDACT_PATTERN = /\b(password|passwd|pwd|token|secret|apikey|api_key|access_token|refresh_token|id_token|authorization|auth|otp|code2fa|cookie|sessionid|session_id|jwt|bearer)\s*[:=]\s*[^\s,;'"]+/gi;

/**
 * Redacta pares `key=value` / `key:value` en texto plano. Complementa
 * `lib/redact.js` (que solo cubre URLs, emails y JSON). Usado para
 * sanear comandos de operador en Telegram antes de persistirlos.
 */
function redactBareKeyValuePairs(text) {
    if (typeof text !== 'string') return text;
    return text.replace(BARE_KV_REDACT_PATTERN, (_m, key) => `${key}=[REDACTED]`);
}

/**
 * Default runner para `gh`. Inyectable en tests.
 */
function defaultGhRunner(args, options) {
    const o = options || {};
    const ghBin = o.ghBin || process.env.GH_BIN || process.env.GH_PATH || GH_BIN_DEFAULT;
    const r = spawnSync(ghBin, args, {
        encoding: 'utf8',
        timeout: o.timeoutMs || GH_API_TIMEOUT_MS,
        windowsHide: true,
    });
    return {
        status: r.status,
        stdout: r.stdout || '',
        stderr: r.stderr || '',
        error: r.error,
        signal: r.signal,
    };
}

/**
 * Llama `gh issue view <N> --repo intrale/platform --json
 * number,state,closedAt,stateReason,labels`. Devuelve la entidad parseada,
 * o `{ error: true, ... }` ante fallo / timeout / JSON malformado.
 *
 * @param {number} issue
 * @param {object} [opts]
 * @param {Function} [opts.ghRunner] inyectable
 * @param {number} [opts.timeoutMs] default 5000
 * @param {string} [opts.repo] default intrale/platform
 * @returns {{number, state, closedAt, stateReason, labels}|{error: true, reason: string, message?: string}}
 */
function fetchIssueState(issue, opts) {
    const o = opts || {};
    const ghRunner = typeof o.ghRunner === 'function' ? o.ghRunner : defaultGhRunner;
    const args = [
        'issue', 'view', String(issue),
        '--repo', o.repo || REPO,
        '--json', 'number,state,closedAt,stateReason,labels',
    ];
    const r = ghRunner(args, { timeoutMs: o.timeoutMs || GH_API_TIMEOUT_MS });

    if (r && r.error && r.error.code === 'ETIMEDOUT') {
        return { error: true, reason: 'timeout' };
    }
    if (r && r.signal === 'SIGTERM') {
        return { error: true, reason: 'timeout' };
    }
    if (!r || typeof r.status !== 'number') {
        return { error: true, reason: 'spawn_failed', message: r && r.error && r.error.message };
    }
    if (r.status !== 0) {
        const stderr = (r.stderr || '').slice(0, 200);
        if (/not found|no such issue/i.test(stderr)) {
            return { error: true, reason: 'not_found' };
        }
        return { error: true, reason: 'non_zero_exit', message: stderr };
    }
    try {
        const parsed = JSON.parse(r.stdout || '{}');
        return {
            number: parsed.number,
            state: typeof parsed.state === 'string' ? parsed.state.toLowerCase() : 'unknown',
            closedAt: parsed.closedAt || null,
            stateReason: parsed.stateReason || null,
            labels: Array.isArray(parsed.labels) ? parsed.labels.map(l => (l && l.name) || '').filter(Boolean) : [],
        };
    } catch (e) {
        return { error: true, reason: 'json_parse_failed', message: e.message };
    }
}

/**
 * Formatea una fecha ISO8601 a formato argentino `DD/MM/YYYY HH:mm` (G-UX-3).
 * Si el input no es parseable, devuelve el string original.
 *
 * @param {string} iso
 * @returns {string}
 */
function formatDateArgentine(iso) {
    if (typeof iso !== 'string' || iso.length === 0) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = d.getUTCFullYear();
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mi = String(d.getUTCMinutes()).padStart(2, '0');
    return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
}

// =============================================================================
// API pública
// =============================================================================

/**
 * CA-2 / CA-3 / CA-4 — Determina si un issue está en estado de no retorno.
 *
 * Orden de checks:
 *   1) Filesystem `archivado/` (autoritativo).
 *   2) GitHub API `issue view` con timeout 5s.
 *   3) Si closed + PR mergeado linkeado → pr_merged.
 *   4) Si closed sin PR → issue_closed.
 *   5) Si labels en TERMINAL_LABELS → label_<x>.
 *
 * Fail-closed: cualquier error de GH / timeout / JSON malformado retorna
 * `{ blocked: true, reason: 'github_api_unavailable', reason_details: {...} }`.
 *
 * @param {number} issue
 * @param {object} [opts]
 * @param {Function} [opts.ghRunner] inyectable para tests
 * @param {Function} [opts.prFetcher] inyectable para tests (firma de
 *   `fetchPrInfoForIssue`)
 * @param {string} [opts.root] override de PIPELINE_DIR
 * @param {object} [opts.fsImpl]
 * @returns {Promise<{blocked: boolean, reason?: string, reason_details?: object}>}
 */
async function isNoReturnState(issue, opts) {
    const o = opts || {};
    validateIssueNumber(issue); // CA-6 — throws TypeError ante input inválido.

    // 1) Filesystem archivado (autoritativo, escrito por reconciler).
    const arch = findInArchivado(issue, { root: o.root, fsImpl: o.fsImpl });
    if (arch.found) {
        return {
            blocked: true,
            reason: 'archived',
            reason_details: { pipeline: arch.pipeline, fase: arch.fase },
        };
    }

    // 2) GitHub API.
    const ghState = fetchIssueState(issue, {
        ghRunner: o.ghRunner,
        timeoutMs: o.timeoutMs,
        repo: o.repo,
    });
    if (ghState.error) {
        return {
            blocked: true,
            reason: 'github_api_unavailable',
            reason_details: { code: ghState.reason }, // mensaje genérico, sin stack
        };
    }

    // 3) Closed + PR mergeado → pr_merged. Buscamos PR vía pr-info-fetcher
    //    (convención agent/<N>-<slug>). Si no encontramos un PR mergeado,
    //    caemos a issue_closed.
    if (ghState.state === 'closed') {
        // Solo intentamos resolver PR mergeado si stateReason no es explícitamente
        // 'not_planned' (wontfix-style). Pero igual fallback a issue_closed.
        let prInfo = null;
        try {
            const prFetcher = typeof o.prFetcher === 'function'
                ? o.prFetcher
                : fetchPrInfoForIssue;
            prInfo = prFetcher(issue, { timeoutMs: o.timeoutMs || GH_API_TIMEOUT_MS });
        } catch {
            prInfo = null;
        }
        if (prInfo && !prInfo.error && prInfo.state === 'MERGED' && prInfo.mergedAt) {
            return {
                blocked: true,
                reason: 'pr_merged',
                reason_details: {
                    prNumber: typeof prInfo.number === 'number' ? prInfo.number : null,
                    mergedAt: prInfo.mergedAt,
                },
            };
        }
        return {
            blocked: true,
            reason: 'issue_closed',
            reason_details: { closedAt: ghState.closedAt || null },
        };
    }

    // 4) Labels terminales (issue todavía open con label wontfix/duplicate/invalid).
    const labelSet = new Set((ghState.labels || []).map(l => String(l).toLowerCase()));
    for (const terminal of TERMINAL_LABELS) {
        if (labelSet.has(terminal)) {
            return {
                blocked: true,
                reason: `label_${terminal}`,
                reason_details: { label: terminal },
            };
        }
    }

    return { blocked: false };
}

/**
 * CA-9 / G-UX-1..G-UX-4 — Convierte un resultado de `isNoReturnState` en el
 * mensaje user-facing para el operador. NO interpola libremente el campo
 * `reason_details.error` (defensa contra leak de internos).
 *
 * @param {{blocked: boolean, reason?: string, reason_details?: object}} result
 * @param {number} issue
 * @returns {string|null} mensaje formateado, o null si `result.blocked` es false.
 */
function formatBlockedMessage(result, issue) {
    if (!result || !result.blocked) return null;
    const reason = result.reason;
    const template = BLOCKED_REASON_TO_USER_MSG[reason];
    if (!template) {
        // Defensa: si llegara un reason no listado (no debería, NO_RETURN_STATES
        // es cerrado), mostrar un fallback genérico sin filtrar nada técnico.
        return `❌ No se puede rebobinar #${issue} — estado terminal no clasificado.`;
    }
    const details = result.reason_details || {};
    // Interpolación controlada por dictionary — NO `result.reason_details` libre.
    const replacements = {
        issue: String(issue),
        prNumber: details.prNumber != null ? String(details.prNumber) : '?',
        mergedAt: details.mergedAt ? formatDateArgentine(details.mergedAt) : '?',
        closedAt: details.closedAt ? formatDateArgentine(details.closedAt) : '?',
        label: details.label || '?',
    };
    return template.replace(/\{(\w+)\}/g, (_m, key) => {
        if (Object.prototype.hasOwnProperty.call(replacements, key)) {
            return replacements[key];
        }
        return '?'; // placeholder no mapeado — defensa.
    });
}

/**
 * CA-8 / CA-11 — Persiste un rejection bloqueado al audit log encadenado
 * (`.pipeline/audit/rejections-blocked.jsonl`). Reusa
 * `lib/audit-log.js` (hash chain SHA-256, GENESIS, verifyChain).
 *
 * El consumer debe pasar:
 *   - issue: number validado
 *   - blockedResult: salida de isNoReturnState (debe tener `blocked: true`)
 *   - operatorChatId: chat_id de Telegram (se hashea SHA-256, NO se persiste plano)
 *   - rawCommand: comando original del operador (pasa por lib/redact, truncado)
 *   - lockHeldMs: tiempo que el lock estuvo tomado (telemetría)
 *
 * `reason_details` se limita a primitivos planos (no paths absolutos) para
 * reproducibilidad del hash chain entre Windows y Linux/CI (canonical_json
 * normaliza orden de keys pero NO `path.sep`).
 *
 * @param {object} params
 * @returns {{hash_self: string, hash_prev: string}}
 */
function appendBlockedRejection(params) {
    const {
        issue,
        blockedResult,
        operatorChatId,
        rawCommand,
        lockHeldMs,
        file,        // override para tests
        fsImpl,      // inyectable
    } = params || {};

    validateIssueNumber(issue);
    if (!blockedResult || !blockedResult.blocked || !blockedResult.reason) {
        throw new Error('[pipeline-states] appendBlockedRejection: blockedResult inválido.');
    }
    if (!NO_RETURN_STATES.includes(blockedResult.reason)) {
        throw new Error(
            `[pipeline-states] reason '${blockedResult.reason}' no está en NO_RETURN_STATES. ` +
            'Actualizá la lista o corregí el caller.'
        );
    }

    // CA-8: chat_id NUNCA en plano — hash SHA-256 (PII operativo).
    const operatorChatIdHash = operatorChatId == null
        ? null
        : 'sha256:' + crypto.createHash('sha256').update(String(operatorChatId), 'utf8').digest('hex');

    // CA-11 / SEC-NR-8: raw command pasa por redact (tokens/passwords/paths).
    // `lib/redact.js` cubre URLs, emails y query strings; pero operadores en
    // Telegram pueden pegar pares `key=value` en texto plano sin separador
    // URL. Aplicamos primero una pasada extra para esos patrones comunes
    // (password=, token=, secret=, apikey=, otp=, etc.) y después pasamos
    // por `redactSensitive` para el resto (URLs, emails, paths absolutos).
    let rawPreview = '';
    if (typeof rawCommand === 'string') {
        let preRedacted = redactBareKeyValuePairs(rawCommand);
        const redacted = redactSensitive(preRedacted);
        rawPreview = String(redacted).slice(0, RAW_COMMAND_PREVIEW_MAX_LEN);
    }

    // CA-8: reason_details normalizado a primitivos (la línea ya está cubierta
    // por `isNoReturnState` que solo emite numbers/strings, pero defensa).
    const safeDetails = {};
    const details = blockedResult.reason_details || {};
    for (const [k, v] of Object.entries(details)) {
        if (v == null) continue;
        if (typeof v === 'number' || typeof v === 'boolean') {
            safeDetails[k] = v;
        } else if (typeof v === 'string') {
            // Truncar y forzar forward-slash para reproducibilidad cross-OS.
            safeDetails[k] = v.replace(/\\/g, '/').slice(0, 200);
        }
    }

    const entry = {
        ts: new Date().toISOString(),
        issue,
        blocked_reason: blockedResult.reason,
        reason_details: safeDetails,
        operator_chat_id_hash: operatorChatIdHash,
        raw_command_preview: rawPreview,
        lock_held_ms: Number.isFinite(lockHeldMs) ? lockHeldMs : null,
    };

    const target = file || AUDIT_FILE;
    return auditLog.appendChained({ file: target, entry, fsImpl });
}

module.exports = {
    // CA-1 — Constantes exportadas.
    NO_RETURN_STATES,
    BLOCKED_REASON_TO_USER_MSG,
    TERMINAL_LABELS,
    ARCHIVADO_PHASES,

    // CA-2..CA-4 — API principal.
    isNoReturnState,

    // CA-8 — Audit log helper (sobre lib/audit-log.js).
    appendBlockedRejection,

    // CA-9 — Formato de mensajes al operador.
    formatBlockedMessage,

    // Constantes de path para el consumer (sin obligar a hardcodear).
    AUDIT_FILE,
    AUDIT_DIR,
    PIPELINE_DIR,

    // Internos exportados para tests (privados a efectos del consumer).
    __internal: {
        validateIssueNumber,
        findInArchivado,
        resolveArchivadoGlob,
        fetchIssueState,
        formatDateArgentine,
        defaultGhRunner,
        GH_API_TIMEOUT_MS,
        MAX_ISSUE_NUMBER,
        RAW_COMMAND_PREVIEW_MAX_LEN,
    },
};
