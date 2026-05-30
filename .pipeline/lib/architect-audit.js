// =============================================================================
// architect-audit.js — Writers append-only de auditoría del rol `architect`
// (#3613, paraguas #3559, spike #3507)
// =============================================================================
//
// Centraliza la escritura append-only de los 3 JSONL del rol architect:
//
//   1. .pipeline/audit/architect-tokens.jsonl
//      Una línea por evento de signoff/rebote/abort, con tokens y costo.
//      Spec: docs/pipeline/architect-role.md §13.
//
//   2. .pipeline/audit/prompt-injection-attempts.jsonl
//      Una línea cada vez que el sanitizer detecta un patrón de injection en
//      body o comments del issue. El motivo de rechazo cita `source_id`, no
//      el contenido (defensa contra re-inyección al humano).
//      Spec: docs/pipeline/architect-role.md §14.
//
//   3. .pipeline/audit/architect-codebase-sanitized.jsonl
//      Una línea cada vez que el sanitizer redacta un chunk de codebase (no
//      rechaza el issue, redacta el chunk porque el codebase no es controlable
//      por el autor del issue — CA-7 de #3613).
//
// Reglas inquebrantables (CA-5, CA-6, CA-7, CA-8 del issue #3613):
//
//  R1. **Append-only obligatorio**: todos los writers usan `fs.appendFileSync`
//      en modo `'a'`. NUNCA se usa `writeFileSync` con el path de un audit
//      file. Test estático (grep) + test funcional (2 appends + reload +
//      verificar persistencia de ambas líneas) cubren la regla.
//
//  R2. **Validación de issue_id**: `/^\d+$/` y `> 0`. Patrón copiado de
//      `lib/handoff.js::validateIssueId` (CA-B4). Bloquea path-traversal
//      (`'../'`), strings vacíos, no-numéricos, y `'3613; rm -rf /'`.
//      Validación se aplica también a paths derivados si se construyen.
//
//  R3. **Atomicidad de la línea**: cada llamada serializa el record con
//      `JSON.stringify` y agrega `'\n'` antes de appendear. Si el record
//      contiene caracteres no serializables o ciclos, lanza error antes
//      de tocar disco.
//
//  R4. **Orden canónico de campos** (§13 del role doc): timestamp primero,
//      decision último, `fallback_chain_used: []` por default (no null) para
//      que `jq -r '.timestamp, .decision'` lea predecible.
//
//  R5. **Best-effort sobre errores de FS**: si `mkdirSync` falla o el disco
//      está lleno, el writer lanza error (no silenciar). El caller decide si
//      rebotear o seguir — el audit no debería degradarse silenciosamente.
//
// El módulo NO carga credentials, NO lee `.env`, NO toca paths fuera de
// `<pipelineDir>/audit/` (CA-9 + defensa Gemini).
//
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

// -----------------------------------------------------------------------------
// Constantes
// -----------------------------------------------------------------------------

const AUDIT_FILES = Object.freeze({
    tokens: 'architect-tokens.jsonl',
    promptInjection: 'prompt-injection-attempts.jsonl',
    codebaseSanitized: 'architect-codebase-sanitized.jsonl',
    // #3643 — registro de markers `architect-rejection` malformados detectados
    // por `architect-verify.parseRejectionMarker`. Append-only, mismas reglas R1.
    markerMismatches: 'architect-marker-mismatches.jsonl',
});

// Valores permitidos para `phase` y `decision` del JSONL de tokens.
const VALID_PHASES = Object.freeze(['criterios', 'aprobacion']);
const VALID_DECISIONS = Object.freeze(['signoff', 'rebote', 'abort']);

// -----------------------------------------------------------------------------
// Resolución de paths (sin bind a tiempo de carga — sirve a tests con tmpdir)
// -----------------------------------------------------------------------------

function resolvePipelineDir(opts) {
    if (opts && opts.pipelineDir) return opts.pipelineDir;
    // __dirname = .pipeline/lib → padre = .pipeline
    return path.resolve(__dirname, '..');
}

function auditDir(opts) {
    return path.join(resolvePipelineDir(opts), 'audit');
}

function auditFilePath(key, opts) {
    const fileName = AUDIT_FILES[key];
    if (!fileName) throw new Error(`architect-audit: clave de archivo desconocida "${key}"`);
    return path.join(auditDir(opts), fileName);
}

// -----------------------------------------------------------------------------
// Validación (CA-8)
// -----------------------------------------------------------------------------

/**
 * Valida que `issue` sea un entero positivo serializable como string `/^\d+$/`.
 * Patrón copiado de `lib/handoff.js::validateIssueId`. Bloquea path-traversal
 * (`'../'`), strings vacíos, no-numéricos, valores con shell metacharacters
 * (`'3613; rm -rf /'`), null/undefined, y `0`.
 *
 * Devuelve la string normalizada (sin espacios). Lanza Error con mensaje
 * accionable si no valida.
 *
 * @param {string|number} issue
 * @returns {string}
 */
function validateIssueId(issue) {
    if (issue == null) {
        throw new Error('architect-audit: issue_id requerido');
    }
    const s = String(issue).trim();
    if (!/^\d+$/.test(s) || s === '0') {
        throw new Error(`architect-audit: issue_id inválido "${s}" (esperado /^\\d+$/, > 0)`);
    }
    return s;
}

/**
 * Valida que `phase` sea una de las fases canónicas del JSONL de tokens.
 * @param {string} phase
 * @returns {string}
 */
function validatePhase(phase) {
    if (typeof phase !== 'string' || !VALID_PHASES.includes(phase)) {
        throw new Error(`architect-audit: phase inválida "${phase}" (válidas: ${VALID_PHASES.join(', ')})`);
    }
    return phase;
}

/**
 * Valida que `decision` sea uno de los valores canónicos del JSONL de tokens.
 * @param {string} decision
 * @returns {string}
 */
function validateDecision(decision) {
    if (typeof decision !== 'string' || !VALID_DECISIONS.includes(decision)) {
        throw new Error(`architect-audit: decision inválida "${decision}" (válidas: ${VALID_DECISIONS.join(', ')})`);
    }
    return decision;
}

// -----------------------------------------------------------------------------
// Writer base append-only (R1)
// -----------------------------------------------------------------------------

/**
 * Escribe un record JSON como una línea en `filePath`, modo append (`'a'`).
 * Crea el directorio padre si no existe (best-effort). Si la serialización
 * o el FS fallan, lanza Error — el audit NO se degrada silenciosamente (R5).
 *
 * @param {string} filePath
 * @param {object} record
 */
function appendRecord(filePath, record) {
    if (typeof record !== 'object' || record === null) {
        throw new Error('architect-audit: record debe ser un objeto');
    }
    const line = JSON.stringify(record) + '\n';
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, line, 'utf8');
}

// -----------------------------------------------------------------------------
// Writer #1 — tokens (CA-5)
// -----------------------------------------------------------------------------

/**
 * Escribe un record en `.pipeline/audit/architect-tokens.jsonl`.
 *
 * Campos canónicos (§13 del role doc):
 *   - timestamp (ISO8601, default `new Date().toISOString()`)
 *   - issue_id (entero positivo, validado por `validateIssueId`)
 *   - skill ("architect", forzado)
 *   - phase ("criterios" | "aprobacion")
 *   - model_requested (string)
 *   - model_used (string, distinto si hubo fallback)
 *   - fallback_chain_used (array, default [])
 *   - tokens_in (entero ≥ 0)
 *   - tokens_out (entero ≥ 0)
 *   - cache_read (entero ≥ 0)
 *   - cache_write (entero ≥ 0)
 *   - cost_usd (número ≥ 0)
 *   - decision ("signoff" | "rebote" | "abort")
 *   - signature_marker_hash (string, opcional — vacío para decision="abort")
 *
 * @param {object} params
 * @param {string|number} params.issue_id
 * @param {string} params.phase
 * @param {string} params.model_requested
 * @param {string} params.model_used
 * @param {Array<string>} [params.fallback_chain_used]
 * @param {number} [params.tokens_in]
 * @param {number} [params.tokens_out]
 * @param {number} [params.cache_read]
 * @param {number} [params.cache_write]
 * @param {number} [params.cost_usd]
 * @param {string} params.decision
 * @param {string} [params.signature_marker_hash]
 * @param {string} [params.timestamp]
 * @param {object} [opts]
 * @param {string} [opts.pipelineDir]
 */
function appendTokens(params, opts) {
    const issueId = validateIssueId(params.issue_id);
    const phase = validatePhase(params.phase);
    const decision = validateDecision(params.decision);

    if (typeof params.model_requested !== 'string' || !params.model_requested) {
        throw new Error('architect-audit: model_requested requerido');
    }
    if (typeof params.model_used !== 'string' || !params.model_used) {
        throw new Error('architect-audit: model_used requerido');
    }

    const record = {
        timestamp: params.timestamp || new Date().toISOString(),
        issue_id: Number(issueId),
        skill: 'architect',
        phase: phase,
        model_requested: params.model_requested,
        model_used: params.model_used,
        fallback_chain_used: Array.isArray(params.fallback_chain_used) ? params.fallback_chain_used : [],
        tokens_in: Number.isFinite(params.tokens_in) ? params.tokens_in : 0,
        tokens_out: Number.isFinite(params.tokens_out) ? params.tokens_out : 0,
        cache_read: Number.isFinite(params.cache_read) ? params.cache_read : 0,
        cache_write: Number.isFinite(params.cache_write) ? params.cache_write : 0,
        cost_usd: Number.isFinite(params.cost_usd) ? params.cost_usd : 0,
        decision: decision,
        signature_marker_hash: typeof params.signature_marker_hash === 'string'
            ? params.signature_marker_hash
            : '',
    };

    appendRecord(auditFilePath('tokens', opts), record);
}

// -----------------------------------------------------------------------------
// Writer #2 — prompt injection attempts (CA-6)
// -----------------------------------------------------------------------------

/**
 * Escribe un record en `.pipeline/audit/prompt-injection-attempts.jsonl`.
 *
 * Spec (§14 del role doc):
 *
 *   {
 *     timestamp: ISO8601,
 *     issue_id: <entero positivo>,
 *     phase: "criterios" | "aprobacion",
 *     source: "comment" | "body",
 *     source_id: "IC_kwDOPC...",   // ID del comment ofensor (NO contenido)
 *     author: "leitolarreta",
 *     pattern_matched: "ignore previous",  // metadata para debugging,
 *                                          // pattern detectado por handoff.detectInjection
 *     blocked: true,
 *     action_taken: "rejected_issue_promotion"
 *   }
 *
 * NUNCA persiste el contenido textual del comment — el `source_id` es
 * referencia (defensa contra re-inyección al pasar el motivo a humanos).
 *
 * @param {object} params
 * @param {string|number} params.issue_id
 * @param {string} params.phase
 * @param {string} params.source - "comment" | "body" | "pr-diff" (#3643)
 * @param {string} [params.source_id] - ID del comment (omit si source="body") | source_id sintético `pr-diff:<pr>:<file>@<sha>` para pr-diff
 * @param {string} [params.author]
 * @param {string} [params.pattern_matched]
 * @param {string} [params.action_taken]
 * @param {string} [params.timestamp]
 * @param {object} [opts]
 */
function appendPromptInjection(params, opts) {
    const issueId = validateIssueId(params.issue_id);
    const phase = validatePhase(params.phase);

    // `pr-diff` (CA-IMPL-B7-SANITIZE-DIFF, #3643) se suma a los sources
    // canónicos. NO sustituye `comment`/`body` — el architect Fase 1 sigue
    // usando esos. La extensión es aditiva, no breaking.
    if (typeof params.source !== 'string' || !['comment', 'body', 'pr-diff'].includes(params.source)) {
        throw new Error(`architect-audit: source inválido "${params.source}" (válidos: comment, body, pr-diff)`);
    }

    const record = {
        timestamp: params.timestamp || new Date().toISOString(),
        issue_id: Number(issueId),
        phase: phase,
        source: params.source,
        source_id: typeof params.source_id === 'string' ? params.source_id : '',
        author: typeof params.author === 'string' ? params.author : '',
        pattern_matched: typeof params.pattern_matched === 'string' ? params.pattern_matched : '',
        blocked: true,
        action_taken: typeof params.action_taken === 'string'
            ? params.action_taken
            : 'rejected_issue_promotion',
    };

    appendRecord(auditFilePath('promptInjection', opts), record);
}

// -----------------------------------------------------------------------------
// Writer #3 — codebase sanitized (CA-7)
// -----------------------------------------------------------------------------

/**
 * Escribe un record en `.pipeline/audit/architect-codebase-sanitized.jsonl`.
 *
 * El codebase NO es controlable por el autor del issue. Si un README contiene
 * un párrafo educativo con "ignore previous instructions", redactamos el chunk
 * (no inyectamos al prompt) y logueamos. NO rechazamos el issue (CA-7).
 *
 * Spec del record:
 *
 *   {
 *     timestamp: ISO8601,
 *     issue_id: <entero positivo>,
 *     chunk_source: "lib/handoff.js:227-244",
 *     pattern_matched: "ignore previous",
 *     action_taken: "chunk_redacted"
 *   }
 *
 * @param {object} params
 * @param {string|number} params.issue_id
 * @param {string} params.chunk_source - ej. "lib/handoff.js:227-244"
 * @param {string} [params.pattern_matched]
 * @param {string} [params.action_taken]
 * @param {string} [params.timestamp]
 * @param {object} [opts]
 */
function appendCodebaseSanitized(params, opts) {
    const issueId = validateIssueId(params.issue_id);

    if (typeof params.chunk_source !== 'string' || !params.chunk_source) {
        throw new Error('architect-audit: chunk_source requerido');
    }

    const record = {
        timestamp: params.timestamp || new Date().toISOString(),
        issue_id: Number(issueId),
        chunk_source: params.chunk_source,
        pattern_matched: typeof params.pattern_matched === 'string' ? params.pattern_matched : '',
        action_taken: typeof params.action_taken === 'string' ? params.action_taken : 'chunk_redacted',
    };

    appendRecord(auditFilePath('codebaseSanitized', opts), record);
}

// -----------------------------------------------------------------------------
// Writer #4 — marker mismatches (CA-PO-4 / CA-IMPL-B7-MARKER-STRICT, #3643)
// -----------------------------------------------------------------------------

/**
 * Escribe un record en `.pipeline/audit/architect-marker-mismatches.jsonl`.
 *
 * Se invoca desde `architect-verify.parseRejectionMarker` cada vez que un
 * marker `architect-rejection` parsea pero falla validación de campos (SHA
 * no-hex, issue_id con padding `00042`, issue_id ≤ 0, caracteres especiales
 * en el payload, etc.). El marker se ignora silenciosamente — esta entrada
 * deja audit trail para forensics + tuning de la regex.
 *
 * Spec del record:
 *
 *   {
 *     timestamp: ISO8601,
 *     issue_id: <entero positivo del contexto, NO del marker malformado>,
 *     raw_marker: "<!-- architect-rejection issue=00042 commit=zzz -->",
 *     reason: "issue_id padding/non-canonical",
 *     source_pr: 123 | null
 *   }
 *
 * `raw_marker` se trunca a 500 chars para evitar inflar el JSONL con payloads
 * gigantes que podrían explotar el disco si un atacante embede markers
 * patológicos. `issue_id` del record es el del **contexto** (el issue real
 * que está siendo verificado), NO el campo `issue=` del marker malformado
 * (ése puede ser hostil o malformado y NO confiamos en él).
 *
 * @param {object} params
 * @param {string|number} params.issue_id - issue REAL del contexto, no del marker
 * @param {string} params.raw_marker - marker completo malformado (se trunca a 500 chars)
 * @param {string} params.reason - clasificación del fallo de parseo
 * @param {number} [params.source_pr] - PR donde apareció el marker, si aplica
 * @param {string} [params.timestamp]
 * @param {object} [opts]
 * @param {string} [opts.pipelineDir]
 */
function appendMarkerMismatch(params, opts) {
    const issueId = validateIssueId(params.issue_id);

    if (typeof params.reason !== 'string' || !params.reason) {
        throw new Error('architect-audit: reason requerido en appendMarkerMismatch');
    }

    const record = {
        timestamp: params.timestamp || new Date().toISOString(),
        issue_id: Number(issueId),
        raw_marker: typeof params.raw_marker === 'string'
            ? params.raw_marker.slice(0, 500)
            : '',
        reason: params.reason,
        source_pr: typeof params.source_pr === 'number' && Number.isFinite(params.source_pr)
            ? params.source_pr
            : null,
    };

    appendRecord(auditFilePath('markerMismatches', opts), record);
}

// -----------------------------------------------------------------------------
// Sanitización de input externo (CA-6 + CA-7 — wrappers sobre lib/handoff)
// -----------------------------------------------------------------------------

const handoff = require('./handoff');

/**
 * Sanitiza un bloque de body o comment del issue antes de inyectarlo al
 * prompt del architect. Si detecta patrón de prompt-injection:
 *   1. Loguea un record en `prompt-injection-attempts.jsonl`.
 *   2. Devuelve `{ injection_detected: true, hits, sanitized_text }` —
 *      el caller decide rechazar el issue (CA-6 = sí rechaza body/comments).
 *
 * El `sanitized_text` siempre se devuelve por completitud, pero el caller
 * NO debería usarlo cuando `injection_detected: true` para body/comments.
 *
 * @param {object} params
 * @param {string|number} params.issue_id
 * @param {string} params.phase
 * @param {string} params.source - "comment" | "body"
 * @param {string} [params.source_id]
 * @param {string} [params.author]
 * @param {string} params.text - contenido a sanear
 * @param {object} [opts]
 * @returns {{ injection_detected: boolean, hits: Array<string>, sanitized_text: string }}
 */
function scanIssueInput(params, opts) {
    if (typeof params.text !== 'string') {
        throw new Error('architect-audit: text requerido en scanIssueInput');
    }
    const r = handoff.detectInjection(params.text);
    if (r.hits.length > 0) {
        appendPromptInjection({
            issue_id: params.issue_id,
            phase: params.phase,
            source: params.source,
            source_id: params.source_id,
            author: params.author,
            pattern_matched: r.hits[0],
            action_taken: 'rejected_issue_promotion',
        }, opts);
        return {
            injection_detected: true,
            hits: r.hits,
            sanitized_text: r.text,
        };
    }
    return {
        injection_detected: false,
        hits: [],
        sanitized_text: params.text,
    };
}

/**
 * Sanitiza un chunk de codebase antes de inyectarlo al prompt del architect.
 * A diferencia de `scanIssueInput`, si detecta injection:
 *   1. Loguea un record en `architect-codebase-sanitized.jsonl`.
 *   2. Devuelve `{ redacted: true, hits, sanitized_text }` con el contenido
 *      TRUNCADO al primer match (defensa CA-7, no rechaza el issue).
 *
 * El caller usa `sanitized_text` aunque haya hits — el codebase no controla
 * el autor del issue, por lo que redactamos sin bloquear.
 *
 * @param {object} params
 * @param {string|number} params.issue_id
 * @param {string} params.chunk_source - ej. "lib/handoff.js:227-244"
 * @param {string} params.text
 * @param {object} [opts]
 * @returns {{ redacted: boolean, hits: Array<string>, sanitized_text: string }}
 */
function scanCodebaseChunk(params, opts) {
    if (typeof params.text !== 'string') {
        throw new Error('architect-audit: text requerido en scanCodebaseChunk');
    }
    if (typeof params.chunk_source !== 'string' || !params.chunk_source) {
        throw new Error('architect-audit: chunk_source requerido');
    }
    const r = handoff.detectInjection(params.text);
    if (r.hits.length > 0) {
        appendCodebaseSanitized({
            issue_id: params.issue_id,
            chunk_source: params.chunk_source,
            pattern_matched: r.hits[0],
            action_taken: 'chunk_redacted',
        }, opts);
        return {
            redacted: true,
            hits: r.hits,
            sanitized_text: r.text,
        };
    }
    return {
        redacted: false,
        hits: [],
        sanitized_text: params.text,
    };
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
    // Writers
    appendTokens,
    appendPromptInjection,
    appendCodebaseSanitized,
    appendMarkerMismatch,  // #3643 — CA-PO-4 / CA-IMPL-B7-MARKER-STRICT

    // Sanitizer wrappers (CA-6, CA-7)
    scanIssueInput,
    scanCodebaseChunk,

    // Validación (exportada para tests + uso externo)
    validateIssueId,
    validatePhase,
    validateDecision,

    // Paths (útil para tests / debugging)
    auditDir,
    auditFilePath,

    // Constantes (testing)
    AUDIT_FILES,
    VALID_PHASES,
    VALID_DECISIONS,
};
