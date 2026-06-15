// =============================================================================
// sherlock-audit-jsonl.js — Writer del audit log JSONL de Sherlock.
//
// Issue: #3896 (split de #3894, hija 2/3) — CA-1..CA-6, SEC-2/3/4.
//
// Loguea cada validación canónica de Sherlock en un JSONL append-only por
// sesión (`.pipeline/audit/sherlock-<session>.jsonl`) con trazabilidad
// completa: claim → comando canónico → resultado → resolución.
//
// Principio rector: **envolver, no reimplementar**.
//   - La integridad (O_APPEND + hash chain + lock cross-process fail-closed)
//     la aporta `audit-log.js:appendChained()`. Acá NUNCA se toca
//     `fs.appendFileSync` directo sobre el audit (SEC-3 resuelto por
//     construcción: `appendChained` hace `JSON.stringify(entry)+'\n'`, que
//     escapa `\n`/`\r` → una línea por registro, sin log forging).
//   - La redacción de secrets la aportan `commander/redact-read.js` y
//     `redact.js`. Acá se ENCADENAN ambos (SEC-2) + se cubre el gap del PAT
//     fine-grained `github_pat_*` que ninguno de los dos contempla.
//
// Requisitos de seguridad NO NEGOCIABLES (verificados contra HEAD):
//   - SEC-2 (CWE-532): TODO stdout/stderr/claim/comando pasa por
//     `redactAll()` antes de escribir. Nunca se serializa `process.env` ni el
//     prompt crudo (eso lo garantiza el caller pasando hashes). Cobertura
//     explícita: `ghp_` (40 chars), `github_pat_*` (fine-grained), AWS `AKIA`.
//   - SEC-3 (CWE-117): un `JSON.stringify(record)+'\n'` por línea, append-only.
//   - SEC-4 (CWE-22): `session` validado con allowlist ANTES de construir el
//     path + verificación redundante de que el path resuelto cae dentro de
//     `.pipeline/audit/`. Fail-closed: si algo no cuadra, throw SIN crear
//     archivo.
// =============================================================================
'use strict';

const path = require('node:path');
const { appendChained } = require('./audit-log');
const { redactReadOutput } = require('./commander/redact-read');
const { redactSecretValue } = require('./redact');

// SEC-4 — allowlist del nombre de sesión. Sin `.`, `/`, `\`, `%` ni NUL → ningún
// vector de path traversal pasa. Largo acotado a 64 para evitar nombres
// patológicos. Se valida ANTES de construir cualquier path.
const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Subdirectorio canónico del audit. El path final SIEMPRE cae acá adentro.
const AUDIT_SUBDIR = 'audit';

// #3923 EP2-H3 — ENUM CERRADO de fuentes canónicas. `source` se persiste SOLO si
// pertenece a este set (no string libre del claim → anti log-injection A09,
// compatible con el hash-chain). Debe mantenerse en LOCKSTEP con el enum `source`
// de canonical-facts.js y con not_verifiable_by_source de dashboard-slices.js.
const AUDIT_SOURCE_ENUM = new Set([
    'git', 'github-api', 'heartbeat', 'filesystem', 'pipeline-state', 'waves',
]);

// #3936 EP4-H3 (CA-5a) — ENUM CERRADO del dominio del claim. `repo_state` marca
// los verdicts que refieren al estado del repo (las 5 dimensiones del bloque de
// estado del Commander); permite filtrar la métrica de reducción de correcciones
// de Sherlock SIN reparsear texto libre. Lockstep con CLAIM_DOMAINS
// (canonical-facts.js).
const CLAIM_DOMAIN_ENUM = new Set(['repo_state', 'other']);

const REDACTION_MARKER = '[REDACTED]';

// SEC-2 — gap real verificado contra HEAD:
//   - `redact-read.js` cubre `\bgh[pousr]_[A-Za-z0-9]{30,}\b` (ghp_/gho_/ghu_/
//     ghs_/ghr_) pero NO `github_pat_*` (el 3er char de "github" es 't', fuera
//     del set [pousr]).
//   - `redact.js SECRET_VALUE_PATTERNS` no tiene NINGÚN patrón GitHub; el
//     fallback de entropía exige `length > 40` estricto → frágil.
// Por eso agregamos un patrón explícito para el PAT fine-grained (formato
// `github_pat_` + base62/underscore, ~82 chars). El `{50,}` es holgado y no
// solapa con el patrón corto.
const GITHUB_PAT_FINE_GRAINED_RE = /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g;

/**
 * Cadena de redacción obligatoria (SEC-2). Idempotente y null-safe.
 *
 * Orden:
 *   1. PAT fine-grained `github_pat_*` (gap no cubierto por ninguno de los dos
 *      redactores oficiales).
 *   2. `redactReadOutput()` — cubre `gh[pousr]_` (incluye `ghp_` de 40 chars
 *      por longitud ≥30), AWS, JWT, API keys varias, telegram, slack, emails.
 *      OJO: devuelve `{ text, redactedCount }`, NO un string.
 *   3. `redactSecretValue()` — patrones por valor + fallback de entropía.
 *
 * No confiamos en el fallback de entropía como única defensa.
 *
 * @param {*} text — cualquier valor; null/undefined se devuelven tal cual.
 * @returns {*} string redactado, o el valor original si no era string.
 */
function redactAll(text) {
    if (text == null) return text;
    let s = String(text);
    s = s.replace(GITHUB_PAT_FINE_GRAINED_RE, REDACTION_MARKER);
    const readRes = redactReadOutput(s);
    // redactReadOutput devuelve { text, redactedCount }. Defensivo por si la
    // firma cambia a string en el futuro.
    s = (readRes && typeof readRes === 'object' && typeof readRes.text === 'string')
        ? readRes.text
        : (typeof readRes === 'string' ? readRes : s);
    s = redactSecretValue(s);
    return s;
}

/**
 * Resuelve y valida el path del archivo de audit para una sesión (SEC-4).
 * Fail-closed: lanza si la sesión no pasa la allowlist o si el path resuelto
 * se sale de `.pipeline/audit/`. NO crea el archivo.
 *
 * @param {string} session
 * @param {string} pipelineDir — raíz `.pipeline/` (absoluta).
 * @returns {string} path absoluto a `sherlock-<session>.jsonl`.
 */
function resolveAuditFile(session, pipelineDir) {
    if (typeof session !== 'string' || !SESSION_RE.test(session)) {
        throw new Error(
            `[sherlock-audit] session inválida (SEC-4): rechazado sin crear archivo. ` +
            `Debe matchear ${SESSION_RE}`
        );
    }
    if (typeof pipelineDir !== 'string' || pipelineDir.length === 0) {
        throw new Error('[sherlock-audit] pipelineDir requerido (string absoluto).');
    }
    const auditDir = path.resolve(pipelineDir, AUDIT_SUBDIR);
    // `path.basename(session)` es no-op para una sesión que ya pasó la allowlist
    // (no tiene separadores), pero lo dejamos como defensa redundante explícita.
    const fileName = `sherlock-${path.basename(session)}.jsonl`;
    const file = path.resolve(auditDir, fileName);
    // Defensa redundante: el path resuelto DEBE caer dentro de auditDir.
    const expected = path.join(auditDir, `sherlock-${session}.jsonl`);
    if (file !== expected || !file.startsWith(auditDir + path.sep)) {
        throw new Error('[sherlock-audit] path fuera de .pipeline/audit/ (SEC-4).');
    }
    return file;
}

/**
 * Persiste UN registro de validación canónica en el JSONL de la sesión.
 *
 * Firma sync, fail-closed. Redacta TODO stdout/stderr/claim/comando antes de
 * escribir y delega la escritura (append-only + hash chain + lock) en
 * `audit-log.appendChained`. NO reimplementa hash chain ni lock.
 *
 * @param {object} params
 * @param {string} params.session — id de sesión (allowlist SEC-4).
 * @param {object} params.record — datos del evento canónico:
 *   { timestamp, claim, canonical_command, stdout, stderr, resultado,
 *     commander_vs_sherlock, resolucion }.
 * @param {string} params.pipelineDir — raíz `.pipeline/`.
 * @param {object} [params.fsImpl] — inyectable para tests.
 * @returns {{hash_self: string, hash_prev: string, line: string}}
 */
function appendSherlockAudit({ session, record, pipelineDir, fsImpl } = {}) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error('[sherlock-audit] record requerido (objeto plano).');
    }
    // SEC-4 ANTES de tocar el FS. Si falla, throw sin crear nada.
    const file = resolveAuditFile(session, pipelineDir);

    // CA-1 — shape canónico del registro. Los campos de texto pasan por la
    // cadena de redacción (SEC-2). Los enums de control (resultado/resolución)
    // NO se redactan (no transportan secrets y son valores acotados).
    const entry = {
        timestamp: record.timestamp != null ? record.timestamp : new Date().toISOString(),
        claim: redactAll(record.claim),
        canonical_command: redactAll(record.canonical_command),
        stdout: redactAll(record.stdout),
        stderr: redactAll(record.stderr),
        resultado: record.resultado,                   // 'true' | 'false' | 'not_verifiable'
        commander_vs_sherlock: record.commander_vs_sherlock,
        resolucion: record.resolucion,                 // 'accepted' | 'rejected' | 'escalated'
    };

    // CA-3/SEC-3 (#3921) — `same_provider` del intento que produjo el veredicto.
    // Boolean, NO se redacta (no transporta texto sensible). Solo se persiste
    // cuando el caller lo provee: los records que no lo traen (callers viejos)
    // NO quedan con un `false` espurio que contaminaría el % del dashboard. El
    // verifier lo pasa SIEMPRE en la verificación canónica → el slice cuenta
    // todas las same-provider, incluido el fallback de último recurso (no
    // manipulable).
    if (record.same_provider !== undefined && record.same_provider !== null) {
        entry.same_provider = !!record.same_provider;
    }

    // #3923 EP2-H3 — `source` (enum cerrado AUDIT_SOURCE_ENUM). Patrón idéntico
    // al de `same_provider`: solo se persiste cuando el caller lo provee y
    // pertenece al enum (records viejos sin `source` no quedan contaminados). Es
    // un enum acotado sin secrets → NO se redacta. Insumo de la tasa
    // not_verifiable por-fuente del slice de precisión (EP8-H8).
    if (record.source !== undefined && record.source !== null
        && AUDIT_SOURCE_ENUM.has(String(record.source))) {
        entry.source = String(record.source);
    }

    // #3936 EP4-H3 (CA-5a) — `claim_domain` (enum cerrado CLAIM_DOMAIN_ENUM).
    // Mismo patrón que `source`/`same_provider`: sólo se persiste cuando el caller
    // lo provee y pertenece al enum (records viejos sin el campo no se contaminan).
    // Enum acotado sin secrets → NO se redacta. Insumo de la métrica de reducción
    // de correcciones de Sherlock por estado del repo (CA-5).
    if (record.claim_domain !== undefined && record.claim_domain !== null
        && CLAIM_DOMAIN_ENUM.has(String(record.claim_domain))) {
        entry.claim_domain = String(record.claim_domain);
    }

    // appendChained agrega created_at + hash_prev/hash_self y escribe
    // exactamente UNA línea (`JSON.stringify(entry)+'\n'`) con O_APPEND + lock.
    // Resuelve SEC-3 por construcción.
    return appendChained({ file, entry, fsImpl });
}

module.exports = {
    appendSherlockAudit,
    redactAll,
    resolveAuditFile,
    SESSION_RE,
    AUDIT_SUBDIR,
    AUDIT_SOURCE_ENUM,
    CLAIM_DOMAIN_ENUM,
    GITHUB_PAT_FINE_GRAINED_RE,
};
