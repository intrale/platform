// =============================================================================
// architect-signoff-gate.js — Gate de promoción criterios → Ready (#3614)
// =============================================================================
//
// Paraguas: #3559 — implementación B3 del rol Arquitecto.
// Depende de la foundation #3613 (lib/architect-audit.js, schema y skill).
// Spike origen: #3507 — specs firmadas.
//
// El gate evalúa 3 condiciones simultáneas antes de permitir que un issue del
// pipeline `definicion` reciba el label `Ready` y sea promovido al pipeline de
// `desarrollo`. Las condiciones (Security #1 del role doc) son:
//
//   1. Sección `## Detalles Técnicos` presente en el body del issue, no vacía,
//      con al menos 200 caracteres de contenido (excluyendo el header).
//   2. Comment con marker `<!-- architect-signoff issue=NNNN -->` emitido por
//      el bot dedicado (validación anti-spoofing — GAP-SEC-1).
//   3. Entrada en `.pipeline/audit/architect-tokens.jsonl` con
//      `decision='signoff'` y `signature_marker_hash` matcheando el hash
//      determinístico SHA256(comment.body.trim().normalize('NFC')) (R11).
//
// El gate es API pura: input `{ issue, body, comments, config, options }` →
// output `{ decision, gate_mode, condition_results, ... }`. Esto permite
// invocarlo desde `pulpo.js` JUSTO antes del `fs.writeFileSync(labelFile, ...)`
// que enquequa el label `Ready` hacia `servicios/github/pendiente/`
// (pulpo.js:3791-3800). NO se implementa en `servicio-github.js` porque ese
// worker es downstream: cuando recibe el label, la decisión ya está tomada
// (hallazgo R1 del análisis guru en #3614).
//
// Reglas inquebrantables consolidadas (CA-1..CA-16 del issue + R1..R8 guru):
//
//   R1. **Kill switch separado** (CA-14): si `architect.enabled !== true`,
//       el gate ni se invoca, ni logguea, ni evalúa. Cortocircuito completo.
//       Patrón consistente con kill switch implícito de `agent-models.json`
//       (architect-rollout-plan.md:93).
//
//   R2. **Fail-cerrado vs fail-abierto explícito** (CA-13): si `architect-
//       tokens.jsonl` no existe / está corrupto / no se puede leer:
//         - modo `enforce` → fail-CERRADO (decision=block + alerta).
//         - modo `dry-run` → fail-ABIERTO (decision=approve + log + alerta).
//       No queda implícito en el código — rama explícita por modo.
//
//   R3. **Modo dry-run nunca bloquea promoción** (CA-5): aunque `decision`
//       lógica sea `block`, el `effective_decision` que recibe pulpo es
//       siempre `approve` en `dry-run`. La decisión lógica se persiste en
//       el audit para refinar regex/auth antes de pasar a `enforce`.
//
//   R4. **Anti-spoofing del marker** (CA-3, GAP-SEC-1): valida simultáneamente
//       `comment.author.login === config.bot_login`,
//       `comment.authorAssociation ∈ {OWNER, MEMBER, COLLABORATOR}`,
//       regex estricta `^<!-- architect-signoff issue=(\\d+) -->$`,
//       y `marker.issue_id === current_issue_id`.
//
//   R5. **Triple consistencia del issue_id** (CA-12, R4 guru): antes de
//       aprobar, exige `current_issue_id === marker.issue_id ===
//       audit_entry.issue_id` (enteros, no strings). Cierra el vector
//       cross-issue mixing por error de tooling humano.
//
//   R6. **Política multi-marker** (CA-11, R3 guru): si N>1 markers o N>1
//       comments con marker para el mismo issue, toma el PRIMERO por
//       `createdAt` ascendente. Logguea `anomaly: 'multi-marker'` con
//       `count`. Sin esto, comportamiento ambiguo bajo re-firma del bot.
//
//   R7. **Hash determinístico** (CA-7): `signature_marker_hash =
//       sha256(comment.body.trim().normalize('NFC'))`. Whitespace trailing
//       no afecta; mismo body → mismo hash (idempotencia para condición 3
//       y dedup CA-10).
//
//   R8. **Dedup del audit signoff** (CA-10, R2 guru): antes de
//       `appendFileSync` en `architect-signoff.jsonl`, verifica si ya
//       existe entrada con `(issue_id, marker_hash)` idéntico. Si existe,
//       NO escribe nueva entrada. Evita inflación del audit bajo barridos
//       repetidos del pulpo.
//
//   R9. **Append-only obligatorio** (CA-2): los writers usan `appendFileSync`
//       modo `'a'`, NUNCA `writeFileSync` con path de audit file. Test
//       estático grep + funcional cubren la regla.
//
//   R10. **Grandfathering** (CA-4): si `issue.createdAt < config.go_live_date`,
//        gate aprueba sin evaluar las 3 condiciones y registra entrada en
//        `architect-grandfathered.jsonl` (mismo append-only). Permite
//        rollout sin paralizar issues legacy.
//
//   R11. **Log por condición individual en dry-run** (CA-15, GAP-SEC-DRYRUN-LOG,
//        R8 guru): el record en JSONL incluye `condition_results` con cada
//        condición evaluada por separado (pass + reason). Necesario para
//        calcular "<5% falsos positivos" en el go/no-go del piloto.
//
//   R12. **Path validation heredada** (CA-PO-B4-PATH): `issue_id` debe matchear
//        `/^\d+$/` y ser > 0 antes de construir paths o leer/escribir audit.
//        Patrón copiado de `lib/handoff.js::validateIssueId`.
//
// El módulo NO carga credentials, NO lee `.env`, NO toca paths fuera de
// `<pipelineDir>/audit/` (CA-9 + defensa Gemini heredada de la foundation).
//
// =============================================================================
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// -----------------------------------------------------------------------------
// Constantes
// -----------------------------------------------------------------------------

// Audit files (sin path absoluto — se resuelve contra `pipelineDir`).
const SIGNOFF_AUDIT_FILE = 'architect-signoff.jsonl';
const GRANDFATHER_AUDIT_FILE = 'architect-grandfathered.jsonl';
// Cross-check de la condición #3: el architect agent escribe acá su signoff
// via `lib/architect-audit.js::appendTokens({ decision: 'signoff', ... })`.
const TOKENS_AUDIT_FILE = 'architect-tokens.jsonl';

const DEFAULT_BOT_LOGIN = 'architect-bot';

// `authorAssociation` aceptables (R4). `NONE`, `CONTRIBUTOR`, `FIRST_TIMER`
// quedan fuera para evitar comments de terceros que matchearan el regex.
const ALLOWED_AUTHOR_ASSOCIATIONS = Object.freeze([
    'OWNER',
    'MEMBER',
    'COLLABORATOR',
]);

// Regex no-greedy para encontrar markers DENTRO de un body (puede haber texto
// adicional alrededor del marker en el mismo comment). Captura el issue_id.
// NOTA: usar `new RegExp(...)` por iteración para evitar estado compartido del
// flag `g` entre llamadas concurrentes.
function buildMarkerSearchRegex() {
    return /<!--\s*architect-signoff\s+issue=(\d+)\s*-->/g;
}

// Regex estricta de validación de un marker individual (R4): el marker debe
// estar en una línea propia con formato canónico exacto. Esto descarta
// markers ofuscados (`<!--   architect-signoff   issue=3614   -->`) y forzá
// al bot a emitir el formato documentado en `architect-role.md` §13.
const STRICT_MARKER_LINE_REGEX = /^<!-- architect-signoff issue=(\d+) -->$/;

// Header de la sección "Detalles Técnicos" en el body del issue. Aceptamos
// con y sin tilde para resiliencia ante variaciones tipográficas.
const DETALLES_TECNICOS_HEADER_RE = /^##\s+Detalles\s+T[ée]cnicos\s*$/m;

// Header genérico de markdown — usado para delimitar el fin de la sección.
const NEXT_MARKDOWN_HEADER_RE = /^##\s+\S/m;

const MIN_DETALLES_TECNICOS_LENGTH = 200;

// Códigos de error del módulo (visible al caller para logging granular).
const ERROR_CODES = Object.freeze({
    AUDIT_READ_ERROR: 'AUDIT_READ_ERROR',
    INVALID_ISSUE_ID: 'INVALID_ISSUE_ID',
});

// -----------------------------------------------------------------------------
// Path resolution (sin bind a tiempo de carga — los tests inyectan pipelineDir)
// -----------------------------------------------------------------------------

function resolvePipelineDir(options) {
    if (options && options.pipelineDir) return options.pipelineDir;
    // __dirname = .pipeline/lib → padre = .pipeline
    return path.resolve(__dirname, '..');
}

function auditPath(pipelineDir, file) {
    return path.join(pipelineDir, 'audit', file);
}

// -----------------------------------------------------------------------------
// Validación de issue_id (R12, hereda CA-PO-B4-PATH de la hija foundation)
// -----------------------------------------------------------------------------

/**
 * Valida y normaliza `issue_id` a entero positivo. Rechaza path-traversal,
 * shell metacharacters, vacíos, ceros, negativos, no-numéricos.
 * @param {string|number} issue
 * @returns {number}
 */
function validateIssueId(issue) {
    if (issue == null) {
        const err = new Error('architect-gate: issue_id requerido');
        err.code = ERROR_CODES.INVALID_ISSUE_ID;
        throw err;
    }
    const s = String(issue).trim();
    if (!/^\d+$/.test(s) || s === '0') {
        const err = new Error(`architect-gate: issue_id inválido "${s}" (esperado /^\\d+$/, > 0)`);
        err.code = ERROR_CODES.INVALID_ISSUE_ID;
        throw err;
    }
    return Number(s);
}

// -----------------------------------------------------------------------------
// R7 · Hash determinístico del marker comment (CA-7)
// -----------------------------------------------------------------------------

/**
 * Computa `signature_marker_hash` determinístico del cuerpo de un comment.
 * Whitespace trailing no afecta. Mismo `comment.body` lógico → mismo hash.
 * Garantiza idempotencia para condición 3 y dedup R8.
 *
 * @param {string} commentBody
 * @returns {string} sha256 hex
 */
function computeMarkerHash(commentBody) {
    const normalized = String(commentBody || '').trim().normalize('NFC');
    return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

// -----------------------------------------------------------------------------
// Condición 1 · Sección `## Detalles Técnicos` en el body
// -----------------------------------------------------------------------------

/**
 * Verifica que el body del issue contenga `## Detalles Técnicos` con al menos
 * `MIN_DETALLES_TECNICOS_LENGTH` (200) caracteres de contenido tras el header.
 *
 * @param {string} body
 * @returns {{ pass: boolean, reason?: string, length: number }}
 */
function evalDetallesTecnicos(body) {
    if (typeof body !== 'string' || body.length === 0) {
        return { pass: false, reason: 'body vacío o no es string', length: 0 };
    }
    const headerMatch = body.match(DETALLES_TECNICOS_HEADER_RE);
    if (!headerMatch) {
        return { pass: false, reason: 'header "## Detalles Técnicos" ausente', length: 0 };
    }
    // Extraer contenido entre el header y el siguiente `## …` o EOF.
    const headerIdx = body.indexOf(headerMatch[0]);
    const rest = body.slice(headerIdx + headerMatch[0].length);
    const nextHeader = rest.match(NEXT_MARKDOWN_HEADER_RE);
    const section = nextHeader ? rest.slice(0, rest.indexOf(nextHeader[0])) : rest;
    const content = section.trim();
    if (content.length < MIN_DETALLES_TECNICOS_LENGTH) {
        return {
            pass: false,
            reason: `sección demasiado corta (${content.length}/${MIN_DETALLES_TECNICOS_LENGTH} chars)`,
            length: content.length,
        };
    }
    return { pass: true, length: content.length };
}

// -----------------------------------------------------------------------------
// Condición 2 · Marker comment con validación anti-spoofing
// -----------------------------------------------------------------------------

/**
 * Encuentra el marker canónico (primer comment con marker por createdAt
 * ascendente) y lo valida contra anti-spoofing.
 *
 * Casos cubiertos:
 *   - Sin comments con marker → fail.
 *   - N>1 comments con marker para el mismo issue → toma primero + anomaly.
 *   - N>1 markers en un mismo comment → toma primero + anomaly.
 *   - author.login distinto al bot → fail.
 *   - authorAssociation fuera del set permitido → fail.
 *   - marker.issue_id no coincide con current_issue_id → fail.
 *   - Regex estricta no matchea (e.g., whitespace extra) → fail.
 *
 * @param {number} issueId
 * @param {Array<object>} comments
 * @param {object} config - `{ bot_login }`
 * @returns {{
 *   pass: boolean,
 *   reason?: string,
 *   comment_url?: string,
 *   marker_hash?: string,
 *   marker_issue_id?: number,
 *   comment_created_at?: string,
 *   anomaly?: { kind: string, count: number }|null
 * }}
 */
function evalMarker(issueId, comments, config) {
    config = config || {};
    const botLogin = config.bot_login || DEFAULT_BOT_LOGIN;

    if (!Array.isArray(comments)) {
        return { pass: false, reason: 'comments no es array', anomaly: null };
    }

    // Recolectar todos los candidatos con al menos 1 marker en el body.
    const candidates = [];
    for (const c of comments) {
        if (!c || typeof c !== 'object') continue;
        const body = typeof c.body === 'string' ? c.body : '';
        const re = buildMarkerSearchRegex();
        const markers = [];
        let m;
        while ((m = re.exec(body)) !== null) {
            markers.push({ raw: m[0], issueId: Number(m[1]), index: m.index });
        }
        if (markers.length > 0) {
            candidates.push({ comment: c, markers });
        }
    }

    if (candidates.length === 0) {
        return { pass: false, reason: 'sin comment con marker architect-signoff', anomaly: null };
    }

    // R6 — toma primero por createdAt ascendente (canónico estable).
    candidates.sort((a, b) => {
        const ta = a.comment.createdAt || '';
        const tb = b.comment.createdAt || '';
        return ta < tb ? -1 : (ta > tb ? 1 : 0);
    });

    const totalMarkers = candidates.reduce((acc, c) => acc + c.markers.length, 0);
    const anomaly = (candidates.length > 1 || candidates[0].markers.length > 1)
        ? { kind: 'multi-marker', count: totalMarkers }
        : null;

    const canonical = candidates[0];
    const comment = canonical.comment;
    const marker = canonical.markers[0];

    // R4 — anti-spoofing simultáneo
    const authorLogin = comment.author && comment.author.login;
    if (authorLogin !== botLogin) {
        return {
            pass: false,
            reason: `author.login mismatch: expected '${botLogin}', got '${authorLogin}'`,
            anomaly,
        };
    }
    if (!ALLOWED_AUTHOR_ASSOCIATIONS.includes(comment.authorAssociation)) {
        return {
            pass: false,
            reason: `authorAssociation inválida '${comment.authorAssociation}' (válidas: ${ALLOWED_AUTHOR_ASSOCIATIONS.join(', ')})`,
            anomaly,
        };
    }
    if (!STRICT_MARKER_LINE_REGEX.test(marker.raw)) {
        return {
            pass: false,
            reason: `marker no matchea regex estricta '${STRICT_MARKER_LINE_REGEX.source}' (raw='${marker.raw}')`,
            anomaly,
        };
    }
    if (marker.issueId !== issueId) {
        return {
            pass: false,
            reason: `marker.issue_id (${marker.issueId}) no coincide con current_issue_id (${issueId})`,
            anomaly,
        };
    }

    return {
        pass: true,
        comment_url: typeof comment.url === 'string' ? comment.url : '',
        marker_hash: computeMarkerHash(comment.body),
        marker_issue_id: marker.issueId,
        comment_created_at: comment.createdAt || '',
        anomaly,
    };
}

// -----------------------------------------------------------------------------
// Condición 3 · Cross-check del audit de tokens (architect-tokens.jsonl)
// -----------------------------------------------------------------------------

/**
 * Busca en `architect-tokens.jsonl` una entrada con
 * `issue_id === issueId && decision === 'signoff' && signature_marker_hash
 * === markerHash`. Devuelve el match si existe; lanza Error con
 * `code = AUDIT_READ_ERROR` si el archivo no se puede leer (no si no
 * existe — eso es un fail normal).
 *
 * Diseño: el architect agent es quien escribe estos tokens via
 * `lib/architect-audit.js::appendTokens(..., decision: 'signoff', ...)`
 * cuando firma. El gate solo lee, nunca escribe en este archivo.
 *
 * @param {number} issueId
 * @param {string} markerHash
 * @param {string} pipelineDir
 * @returns {{ pass: boolean, reason?: string, matched_timestamp?: string, matched_audit_issue_id?: number }}
 */
function evalAuditEntry(issueId, markerHash, pipelineDir) {
    const filePath = auditPath(pipelineDir, TOKENS_AUDIT_FILE);
    let content;
    try {
        if (!fs.existsSync(filePath)) {
            return { pass: false, reason: `${TOKENS_AUDIT_FILE} no existe (sin signoff registrado)` };
        }
        content = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        // Permission denied, EIO, etc. — caller decide fail-cerrado vs fail-abierto.
        const err = new Error(`audit JSONL '${TOKENS_AUDIT_FILE}' no se puede leer: ${e.message}`);
        err.code = ERROR_CODES.AUDIT_READ_ERROR;
        err.cause = e;
        throw err;
    }

    const lines = content.split('\n').filter(l => l.trim() !== '');
    for (const line of lines) {
        let rec;
        try {
            rec = JSON.parse(line);
        } catch {
            // Linea corrupta — saltear (no es read error, solo skip).
            continue;
        }
        if (rec
            && Number(rec.issue_id) === issueId
            && rec.decision === 'signoff'
            && rec.signature_marker_hash === markerHash) {
            return {
                pass: true,
                matched_timestamp: rec.timestamp,
                matched_audit_issue_id: Number(rec.issue_id),
            };
        }
    }
    return {
        pass: false,
        reason: `sin entrada signoff con signature_marker_hash matching en ${TOKENS_AUDIT_FILE}`,
    };
}

// -----------------------------------------------------------------------------
// Writers append-only (R9)
// -----------------------------------------------------------------------------

/**
 * Append-only base. Crea el directorio padre si no existe.
 * @param {string} pipelineDir
 * @param {string} file - relativo a `<pipelineDir>/audit/`
 * @param {object} record
 */
function appendAuditEntry(pipelineDir, file, record) {
    const filePath = auditPath(pipelineDir, file);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
}

/**
 * R8 — Dedup append en `architect-signoff.jsonl`. Si ya existe entrada con
 * `(issue_id, marker_hash)` idéntico, NO escribe (skipped). Devuelve metadata
 * para que el caller pueda loggear el skip.
 *
 * @param {string} pipelineDir
 * @param {string} file
 * @param {{ issue_id: number, marker_hash: string }} dedupKey
 * @param {object} record
 * @returns {{ skipped: boolean, reason?: string }}
 */
function ensureAuditDedup(pipelineDir, file, dedupKey, record) {
    const filePath = auditPath(pipelineDir, file);
    if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const r = JSON.parse(trimmed);
                if (Number(r.issue_id) === dedupKey.issue_id
                    && r.marker_hash === dedupKey.marker_hash) {
                    return { skipped: true, reason: 'duplicate (issue_id, marker_hash)' };
                }
            } catch {
                // Línea corrupta — ignorar, no aborta el dedup.
            }
        }
    }
    appendAuditEntry(pipelineDir, file, record);
    return { skipped: false };
}

// -----------------------------------------------------------------------------
// Evaluación principal (sin kill switch — sirve a tests)
// -----------------------------------------------------------------------------

/**
 * Evalúa el gate sin aplicar el kill switch. Útil para tests que quieren
 * inspeccionar la lógica con `enabled: true` forzado.
 *
 * @param {object} args
 * @param {object} args.issue - `{ number, createdAt }`
 * @param {string} args.body - body del issue
 * @param {Array<object>} args.comments
 * @param {object} args.config - `{ enabled, gate_mode, go_live_date, bot_login }`
 * @param {object} [args.options] - `{ pipelineDir, nowISO }`
 * @returns {object}
 */
function evaluateRaw({ issue, body, comments, config, options }) {
    options = options || {};
    config = config || {};
    const pipelineDir = resolvePipelineDir(options);
    const gateMode = config.gate_mode === 'enforce' ? 'enforce' : 'dry-run';
    const nowISO = options.nowISO || new Date().toISOString();

    // Validación de issue_id antes de tocar nada (R12).
    let issueId;
    try {
        issueId = validateIssueId(issue && issue.number);
    } catch (e) {
        return {
            decision: gateMode === 'enforce' ? 'block' : 'approve',
            original_decision: 'block',
            reason: e.message,
            gate_mode: gateMode,
            condition_results: {},
            anomaly: null,
            invoked: true,
        };
    }

    // R10 — Grandfathering: si el issue es anterior a `go_live_date`, aprobar
    // sin evaluar las 3 condiciones, y registrar entrada en
    // `architect-grandfathered.jsonl`.
    const goLiveDate = config.go_live_date || null;
    if (goLiveDate && issue && typeof issue.createdAt === 'string' && issue.createdAt < goLiveDate) {
        try {
            appendAuditEntry(pipelineDir, GRANDFATHER_AUDIT_FILE, {
                timestamp: nowISO,
                issue_id: issueId,
                issue_created_at: issue.createdAt,
                go_live_date: goLiveDate,
                action: 'grandfathered',
            });
        } catch (_) { /* best-effort: no abortar grandfathering por FS */ }
        return {
            decision: 'approve',
            original_decision: 'approve',
            reason: 'grandfathered (issue.createdAt < architect.go_live_date)',
            gate_mode: gateMode,
            condition_results: {
                grandfathered: {
                    pass: true,
                    issue_created_at: issue.createdAt,
                    go_live_date: goLiveDate,
                },
            },
            anomaly: null,
            invoked: true,
        };
    }

    // Evaluación de las 3 condiciones — siempre independiente, R11.
    const condResults = {};
    condResults.detalles_tecnicos = evalDetallesTecnicos(body);

    const markerRes = evalMarker(issueId, comments, config);
    condResults.marker = markerRes.pass
        ? {
            pass: true,
            comment_url: markerRes.comment_url,
            marker_hash: markerRes.marker_hash,
            marker_issue_id: markerRes.marker_issue_id,
            comment_created_at: markerRes.comment_created_at,
        }
        : { pass: false, reason: markerRes.reason };
    if (markerRes.anomaly) condResults.marker.anomaly = markerRes.anomaly;

    // Condición 3 — solo si tenemos un hash para matchear.
    let auditReadError = null;
    if (markerRes.pass) {
        try {
            const auditRes = evalAuditEntry(issueId, markerRes.marker_hash, pipelineDir);
            condResults.audit_entry = auditRes;
            // R5 — Triple consistencia del issue_id.
            if (auditRes.pass) {
                if (!(issueId === markerRes.marker_issue_id
                    && issueId === auditRes.matched_audit_issue_id)) {
                    condResults.audit_entry = {
                        pass: false,
                        reason: `triple issue_id mismatch (defensa en profundidad): current=${issueId} marker=${markerRes.marker_issue_id} audit=${auditRes.matched_audit_issue_id}`,
                    };
                }
            }
        } catch (e) {
            if (e.code === ERROR_CODES.AUDIT_READ_ERROR) {
                auditReadError = e;
                condResults.audit_entry = { pass: false, reason: `audit_read_error: ${e.message}` };
            } else {
                // Error inesperado: re-lanzar — no es fail-cerrado, es bug.
                throw e;
            }
        }
    } else {
        condResults.audit_entry = { pass: false, reason: 'marker no pasó; audit_entry no evaluado' };
    }

    // Decisión lógica
    const allPass = condResults.detalles_tecnicos.pass
        && condResults.marker.pass
        && condResults.audit_entry.pass;

    let originalDecision;
    let reason;

    // R2 — Fail-cerrado vs fail-abierto en errores de lectura del audit.
    if (auditReadError) {
        if (gateMode === 'enforce') {
            originalDecision = 'block';
            reason = `fail-cerrado: ${auditReadError.message}`;
        } else {
            originalDecision = 'approve';
            reason = `fail-abierto (dry-run): ${auditReadError.message}`;
        }
    } else if (allPass) {
        originalDecision = 'approve';
        reason = 'todas las condiciones pasaron';
    } else {
        originalDecision = 'block';
        const failed = Object.entries(condResults)
            .filter(([_, v]) => v && v.pass === false)
            .map(([k]) => k);
        reason = `condiciones fallidas: ${failed.join(', ')}`;
    }

    // R3 — Dry-run nunca bloquea efectivamente la promoción.
    const effectiveDecision = (gateMode === 'dry-run') ? 'approve' : originalDecision;

    // R8 — Dedup audit signoff. Solo escribimos si tenemos marker_hash
    // (cualquier evaluación con marker_hash conocido se loguea).
    if (markerRes.pass) {
        try {
            ensureAuditDedup(pipelineDir, SIGNOFF_AUDIT_FILE, {
                issue_id: issueId,
                marker_hash: markerRes.marker_hash,
            }, {
                timestamp: nowISO,
                issue_id: issueId,
                bot_login: config.bot_login || DEFAULT_BOT_LOGIN,
                marker_hash: markerRes.marker_hash,
                comment_url: markerRes.comment_url,
                gate_mode: gateMode,
                decision: originalDecision,
                effective_decision: effectiveDecision,
                condition_results: condResults,
                anomaly: markerRes.anomaly || null,
            });
        } catch (_) { /* best-effort: no abortar por FS error */ }
    }

    return {
        decision: effectiveDecision,
        original_decision: originalDecision,
        reason,
        gate_mode: gateMode,
        condition_results: condResults,
        anomaly: markerRes.anomaly || null,
        audit_read_error: auditReadError ? auditReadError.message : null,
        invoked: true,
    };
}

// -----------------------------------------------------------------------------
// Evaluación con kill switch (R1) — entry point público
// -----------------------------------------------------------------------------

/**
 * Entry point del gate. Aplica kill switch (`architect.enabled !== true` →
 * cortocircuito sin escribir nada), y delega al evaluador principal.
 *
 * @param {object} args - ver `evaluateRaw`
 * @returns {object}
 */
function evaluate(args) {
    const config = (args && args.config) || {};
    if (config.enabled !== true) {
        // Cortocircuito completo: ni se invoca el evaluador, ni se logguea,
        // ni se evalúa. Test verifica que JSONL no se toca cuando enabled=false.
        return {
            decision: 'approve',
            original_decision: 'approve',
            reason: 'gate disabled (architect.enabled !== true)',
            gate_mode: 'disabled',
            condition_results: {},
            anomaly: null,
            invoked: false,
        };
    }
    return evaluateRaw(args);
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
    // Entry points
    evaluate,
    evaluateRaw,

    // Helpers (exportados para tests + uso externo)
    computeMarkerHash,
    validateIssueId,
    evalDetallesTecnicos,
    evalMarker,
    evalAuditEntry,
    appendAuditEntry,
    ensureAuditDedup,

    // Constantes
    SIGNOFF_AUDIT_FILE,
    GRANDFATHER_AUDIT_FILE,
    TOKENS_AUDIT_FILE,
    DEFAULT_BOT_LOGIN,
    ALLOWED_AUTHOR_ASSOCIATIONS,
    STRICT_MARKER_LINE_REGEX,
    DETALLES_TECNICOS_HEADER_RE,
    MIN_DETALLES_TECNICOS_LENGTH,
    ERROR_CODES,
};
