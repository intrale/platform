// =============================================================================
// operator-signature.js — GATE 2 · Firma de Aceptación del operador (#4575)
// =============================================================================
//
// Épico: #4570 · Diseño: docs/pipeline/gates-firma-operador.md (§4.6 GATE 2,
// §11 matriz auto-vs-gateado, §12 fail-closed, §13 autoridad e integridad).
//
// Hermano determinístico de `operator-signoff-gate.js` (GATE 1, #4574). Mientras
// GATE 1 retiene la ADMISIÓN a `desarrollo` (firma de definición, anclada al
// `sha256(body)` de los criterios), GATE 2 retiene la PROMOCIÓN de `aprobacion`
// → `entrega` (firma de aceptación, anclada al **commit SHA** del HEAD que se va
// a mergear). Es el gate que habría atajado #4531/#4500/#4532.
//
// Contrato de entrada/salida (READ/decision path):
//
//   evaluate({ issue, headOid, config, options }) →
//     { decision: 'approve'|'block', gate_mode, original_decision, reason,
//       verdict, route, condition_results, invoked }
//
// La firma se liga al **commit SHA** del HEAD a mergear, NO al nº de issue/PR.
// Si el HEAD avanza tras firmar ⇒ firma inválida ⇒ re-firma (anti-TOCTOU, CA-3,
// misma doctrina que `signed_commit` de architect-verify.js #3700).
//
// REQUISITOS DE SEGURIDAD (fijados por `security`/`po` en definición — CA-3..CA-9)
// -----------------------------------------------------------------------------
//  CA-3 · Anti-TOCTOU firma↔SHA. La firma ancla `signed_commit`. Revalidación
//         contra `headOid` en `evaluate` (pulpo) y de nuevo en `delivery.js`
//         justo antes del merge. HEAD avanzado ⇒ inválida.
//  CA-4 · AuthN/AuthZ del firmante. Sólo un `chat_id` ∈ authorizedSigners
//         (reusa `telegram.operator_chat_ids` + credential dedicada) produce una
//         firma válida. Fail-closed: sin allowlist, ninguna firma vale. Quien
//         PRESENTA el gate (agente) ≠ quien FIRMA (operador).
//  CA-5 · Nonce anti-replay. Cada presentación emite un nonce de un solo uso
//         ligado a `{issue, sha, timestamp}` con expiración. El WRITE path lo
//         consume al primer callback válido; un callback reenviado NO re-aprueba.
//  CA-6 · Clases pre-autorizadas ESTÁTICAS/versionadas en config.yaml. NUNCA
//         derivadas de labels que el pipeline escribe (un agente no puede meter
//         su propio issue en la clase exenta).
//  CA-7 · Circuit-breaker → `needs-human`. Al agotar rebotes de firma NO se
//         auto-aprueba: escala a humano (coherente con v3-efficiency-priority).
//  CA-8 · Audit inmutable append-only. Todo evento (nonce/firma/rechazo) se
//         persiste en `.pipeline/audit/operator-signatures.jsonl` vía el
//         hash-chain tamper-evident de `audit-log.appendChained` (append-only por
//         construcción; JSONL parseable por `jq`).
//  CA-9 · Sanitización + redacción del paquete de evidencia antes de renderizar.
//         `sanitizeEvidencePackage` reusa `handoff.detectInjection` (anti
//         prompt-injection) + `redact.redactRagContent` (secrets/PII).
//
// Rollout gradual (espeja GATE 1 / architect:):
//   - `enabled: false` → kill switch, cortocircuita `approve` sin leer/escribir.
//   - `gate_mode: dry-run` → evalúa y loguea pero NUNCA bloquea.
//   - `gate_mode: enforce` → un block lógico retiene la promoción a `entrega`.
//   - `go_live_date` → issues legacy (createdAt anterior) se grandfatherean.
//   - `preauthorized_classes` → opt-out por label, editado SÓLO por el operador.
//
// El módulo NO carga credentials ni lee `.env`: los firmantes autorizados se
// inyectan (`options.authorizedSigners`) por el caller (pulpo), que los resuelve
// de `credentials.js` + `telegram.operator_chat_ids`. NO toca paths fuera de
// `<pipelineDir>/audit/`.
// =============================================================================
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const auditLog = require('./audit-log');

// -----------------------------------------------------------------------------
// Constantes
// -----------------------------------------------------------------------------

// Audit hash-chain de firmas de aceptación (GATE 2). Un único archivo con
// registros discriminados por `kind`:
//   - 'nonce_issued' → emisión de nonce al presentar la evidencia (CA-5).
//   - 'signature'    → firma/rechazo del operador (CA-8).
// Ambos usan `audit-log.appendChained` (mismo writer, sin duplicar el patrón
// hash-chain; append-only por construcción — CA-8).
const SIGNATURE_AUDIT_FILE = 'operator-signatures.jsonl';

// Verdicts válidos del artefacto de firma (CA-10).
//   signed   → el operador aceptó el artefacto → promueve a `entrega`.
//   rejected → rechazo → vuelve a `dev` (fase_rechazo: dev), con motivo.
const VERDICTS = Object.freeze(['signed', 'rejected']);

// Kinds válidos de registro en el audit.
const KIND_NONCE = 'nonce_issued';
const KIND_SIGNATURE = 'signature';

// Defaults del nonce (CA-5) y del circuit-breaker (CA-7). Clamp defensivo para
// que una edición maliciosa del config no desactive la protección (patrón
// cost_anomaly_alert.max_snooze_hours).
const DEFAULT_NONCE_TTL_SECONDS = 3600;      // 1h de validez del nonce.
const MAX_NONCE_TTL_SECONDS = 86400;         // cap duro: 24h.
const DEFAULT_MAX_SIGNATURE_REBOTES = 3;     // circuit-breaker → needs-human.
const MAX_SIGNATURE_REBOTES_CAP = 10;        // cap duro anti-config-malicioso.

// Motivo canónico anti-TOCTOU (CA-3). Se cita textual en el rechazo para que el
// operador entienda por qué se invalidó la firma.
function staleShaReason(headOid, signedCommit) {
    return `HEAD avanzó (HEAD=${headOid}) desde la firma del operador (commit=${signedCommit})`;
}

// Códigos de error (visibles al caller para logging granular).
const ERROR_CODES = Object.freeze({
    AUDIT_READ_ERROR: 'AUDIT_READ_ERROR',
    AUDIT_CHAIN_BROKEN: 'AUDIT_CHAIN_BROKEN',
    INVALID_ISSUE_ID: 'INVALID_ISSUE_ID',
    INVALID_SHA: 'INVALID_SHA',
});

// -----------------------------------------------------------------------------
// Path resolution (inyectable por tests vía options.pipelineDir)
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
// Validación de inputs (hereda patrón CA-PO-B4-PATH del architect-gate)
// -----------------------------------------------------------------------------

/**
 * Valida y normaliza `issue_id` a entero positivo. Rechaza path-traversal,
 * shell metacharacters, vacíos, ceros, negativos, no-numéricos.
 * @param {string|number} issue
 * @returns {number}
 */
function validateIssueId(issue) {
    if (issue == null) {
        const err = new Error('operator-signature: issue_id requerido');
        err.code = ERROR_CODES.INVALID_ISSUE_ID;
        throw err;
    }
    const s = String(issue).trim();
    if (!/^\d+$/.test(s) || s === '0') {
        const err = new Error(`operator-signature: issue_id inválido "${s}" (esperado /^\\d+$/, > 0)`);
        err.code = ERROR_CODES.INVALID_ISSUE_ID;
        throw err;
    }
    return Number(s);
}

/**
 * Valida y normaliza un SHA de git: hex minúscula 7-40 chars. Git emite siempre
 * minúscula; normalizamos a lowercase para comparaciones case-insensitive
 * robustas (gh JSON podría normalizar distinto).
 * @param {string} sha
 * @returns {string}
 */
function validateSha(sha) {
    const s = String(sha == null ? '' : sha).trim().toLowerCase();
    if (!/^[a-f0-9]{7,40}$/.test(s)) {
        const err = new Error(`operator-signature: sha inválido "${sha}" (esperado hex [7,40])`);
        err.code = ERROR_CODES.INVALID_SHA;
        throw err;
    }
    return s;
}

// -----------------------------------------------------------------------------
// CA-9 · Sanitización + redacción del paquete de evidencia
// -----------------------------------------------------------------------------

/**
 * Computa el hash determinístico del paquete de evidencia (para
 * `hash_paquete_evidencia` del audit, CA-8). Acepta string u objeto (se
 * serializa canónico). No es secreto — es un checksum de integridad.
 * @param {string|object} evidence
 * @returns {string} `sha256:<hex>`
 */
function computeEvidenceHash(evidence) {
    const text = typeof evidence === 'string'
        ? evidence
        : JSON.stringify(evidence == null ? '' : evidence);
    const digest = crypto.createHash('sha256')
        .update('operator-signature-evidence|v1|', 'utf8')
        .update(text, 'utf8')
        .digest('hex');
    return `sha256:${digest}`;
}

/**
 * Sanitiza el paquete de evidencia (de #4573 `e2e-evidence-port.js`, armado con
 * contenido de agentes/PR/issue NO confiable) ANTES de renderizarlo al operador
 * en Telegram/dashboard (CA-9). Pipeline:
 *   1. `handoff.detectInjection` → detecta prompt-injection y markup hostil.
 *   2. `redact.redactRagContent` → redacta secrets/PII (AWS/JWT/API keys, emails,
 *      userinfo, tokens opacos de alta entropía) antes de emitir por canal público.
 *
 * NO lanza si los módulos no están disponibles: degrada conservador
 * (`safe: false`) para que el presentador alerte de más en vez de filtrar.
 *
 * @param {string} text
 * @returns {{ safe: boolean, matches: Array<string>, redacted_text: string }}
 */
function sanitizeEvidencePackage(text) {
    const s = String(text == null ? '' : text);
    let matches = [];
    let safe = true;
    let redacted = s;

    try {
        const handoff = require('./handoff');
        if (typeof handoff.detectInjection === 'function') {
            const res = handoff.detectInjection(s);
            if (res && typeof res === 'object') {
                matches = res.hits || res.matches || [];
                safe = !(Array.isArray(matches) && matches.length > 0);
                // detectInjection ya trunca el texto al primer patrón; usamos su
                // salida saneada como base para la redacción de secrets.
                redacted = typeof res.text === 'string' ? res.text : s;
            }
        }
    } catch (_) {
        safe = false; // conservador: mejor alertar de más.
    }

    try {
        const redact = require('./redact');
        if (typeof redact.redactRagContent === 'function') {
            redacted = redact.redactRagContent(redacted);
        }
    } catch (_) {
        // redact no disponible → dejamos el texto ya truncado por detectInjection.
    }

    return { safe, matches, redacted_text: redacted };
}

// -----------------------------------------------------------------------------
// CA-4 · Autorización del firmante
// -----------------------------------------------------------------------------

/**
 * Normaliza `authorizedSigners` (Set | Array | string | null) a un Set<string>.
 * Fail-closed: input vacío/ausente → Set vacío → ninguna firma autoriza.
 */
function normalizeAuthorizedSigners(input) {
    if (input instanceof Set) return new Set([...input].map(String));
    if (Array.isArray(input)) return new Set(input.filter(v => v != null).map(String));
    if (input != null && String(input).trim() !== '') return new Set([String(input).trim()]);
    return new Set();
}

// -----------------------------------------------------------------------------
// CA-6 · Preauthorized classes (opt-out por label — estático/versionado)
// -----------------------------------------------------------------------------

/**
 * ¿El issue pertenece a una clase pre-autorizada por el operador? El match es
 * por label estático versionado en config.yaml (NUNCA labels que el pipeline
 * escribe — un agente no puede auto-clasificarse como exento, CA-6).
 *
 * @param {Array<string|{name:string}>} labels
 * @param {Array<string>} preauthorizedClasses
 * @returns {{ preauthorized: boolean, matched: string|null }}
 */
function evalPreauthorized(labels, preauthorizedClasses) {
    if (!Array.isArray(preauthorizedClasses) || preauthorizedClasses.length === 0) {
        return { preauthorized: false, matched: null };
    }
    const names = (Array.isArray(labels) ? labels : [])
        .map(l => (l && typeof l === 'object') ? l.name : l)
        .filter(v => typeof v === 'string');
    const set = new Set(preauthorizedClasses.filter(v => typeof v === 'string'));
    for (const n of names) {
        if (set.has(n)) return { preauthorized: true, matched: n };
    }
    return { preauthorized: false, matched: null };
}

// -----------------------------------------------------------------------------
// CA-5 · Nonce anti-replay (funciones puras sobre entries)
// -----------------------------------------------------------------------------

/**
 * Clamp del TTL del nonce a `[1, MAX_NONCE_TTL_SECONDS]` segundos (defensa
 * anti-config-malicioso). Un `nonce_ttl_seconds: 999999` no extiende la ventana
 * más allá del cap duro.
 * @param {number} ttlSeconds
 * @returns {number} ms
 */
function resolveNonceTtlMs(ttlSeconds) {
    let s = Number.isFinite(ttlSeconds) ? ttlSeconds : DEFAULT_NONCE_TTL_SECONDS;
    if (s < 1) s = DEFAULT_NONCE_TTL_SECONDS;
    if (s > MAX_NONCE_TTL_SECONDS) s = MAX_NONCE_TTL_SECONDS;
    return s * 1000;
}

/**
 * Genera un nonce opaco de un solo uso. Usa `crypto.randomBytes` (CSPRNG), no
 * derivable por un atacante que conozca {issue, sha, timestamp}.
 * @returns {string} hex de 32 chars.
 */
function generateNonce() {
    return crypto.randomBytes(16).toString('hex');
}

/**
 * Filtra los registros de un issue por kind. `entries` es el resultado de
 * `audit-log.readAll` (o un array de tests). No valida la chain — eso lo hace
 * `readSignatureState`.
 */
function filterByKind(entries, issueId, kind) {
    const out = [];
    for (const rec of (Array.isArray(entries) ? entries : [])) {
        if (rec && Number(rec.issue_id) === issueId && rec.kind === kind) out.push(rec);
    }
    return out;
}

/**
 * Valida un nonce presentado en un callback de firma (CA-5). Reglas, en orden:
 *   1. Existe un `nonce_issued` con ese `nonce` para el issue.
 *   2. El `sha` del nonce coincide con el `signed_commit` que se intenta firmar
 *      (el nonce se emitió para ese artefacto exacto).
 *   3. No expiró: `now <= issued_at + ttl_ms`.
 *   4. No fue consumido: no existe ningún `signature` previo con ese `nonce`.
 *
 * @param {Array<object>} entries - registros del audit (readAll).
 * @param {object} p
 * @param {number} p.issueId
 * @param {string} p.nonce
 * @param {string} p.sha        - signed_commit que se intenta firmar.
 * @param {number} p.now        - epoch ms.
 * @returns {{ valid: boolean, reason: string, issued?: object }}
 */
function validateNonce(entries, p) {
    const issued = filterByKind(entries, p.issueId, KIND_NONCE)
        .find(r => r.nonce === p.nonce);
    if (!issued) {
        return { valid: false, reason: 'nonce inexistente (no fue emitido para este issue)' };
    }
    const sha = String(p.sha || '').toLowerCase();
    if (String(issued.sha || '').toLowerCase() !== sha) {
        return { valid: false, reason: 'nonce ligado a otro SHA (anti-TOCTOU): el artefacto cambió desde la emisión' };
    }
    const issuedAt = Number(issued.issued_at) || Date.parse(issued.issued_at) || 0;
    const ttlMs = Number.isFinite(issued.ttl_ms) ? issued.ttl_ms : DEFAULT_NONCE_TTL_SECONDS * 1000;
    if (Number(p.now) > issuedAt + ttlMs) {
        return { valid: false, reason: 'nonce expirado (ventana de firma vencida)' };
    }
    const consumed = filterByKind(entries, p.issueId, KIND_SIGNATURE)
        .some(r => r.nonce === p.nonce);
    if (consumed) {
        return { valid: false, reason: 'nonce ya consumido (anti-replay): un callback reenviado no re-aprueba' };
    }
    return { valid: true, reason: 'nonce válido', issued };
}

// -----------------------------------------------------------------------------
// Lectura + validación del audit hash-chain de firmas (CA-8)
// -----------------------------------------------------------------------------

/**
 * Lee y valida las firmas del issue desde el audit hash-chain. Devuelve la
 * ÚLTIMA firma (`signature`) del issue, todos los registros crudos, y flags.
 *
 * Lanza Error con:
 *   - code AUDIT_READ_ERROR   si el archivo existe pero no se puede leer.
 *   - code AUDIT_CHAIN_BROKEN si la cadena hash está rota (tamper-evident).
 * Si el archivo no existe → NO lanza; `{ latest: null, entries: [], chainOk: true }`
 * (ausencia de firma es un fail normal, no un estado corrupto).
 *
 * @param {number} issueId
 * @param {string} pipelineDir
 * @returns {{ latest: object|null, entries: Array<object>, signatures: Array<object>, chainOk: boolean }}
 */
function readSignatureState(issueId, pipelineDir) {
    const filePath = auditPath(pipelineDir, SIGNATURE_AUDIT_FILE);

    if (!fs.existsSync(filePath)) {
        return { latest: null, entries: [], signatures: [], chainOk: true };
    }

    // Validar integridad de la chain ANTES de confiar en cualquier entry: una
    // línea "firmada" escrita a mano en el FS (bypass) rompe la cadena (CA-8).
    let chain;
    try {
        chain = auditLog.verifyChain(filePath);
    } catch (e) {
        const err = new Error(`operator-signature audit chain no verificable: ${e.message}`);
        err.code = ERROR_CODES.AUDIT_READ_ERROR;
        err.cause = e;
        throw err;
    }
    if (!chain.ok) {
        const err = new Error(
            `operator-signature audit chain rota en línea ${chain.brokenAt}: ${chain.reason}`,
        );
        err.code = ERROR_CODES.AUDIT_CHAIN_BROKEN;
        throw err;
    }

    let entries;
    try {
        entries = auditLog.readAll(filePath);
    } catch (e) {
        const err = new Error(`operator-signature audit ilegible: ${e.message}`);
        err.code = ERROR_CODES.AUDIT_READ_ERROR;
        err.cause = e;
        throw err;
    }

    const issueEntries = entries.filter(r => r && Number(r.issue_id) === issueId);
    const signatures = issueEntries.filter(r => r.kind === KIND_SIGNATURE);
    const latest = signatures.length > 0 ? signatures[signatures.length - 1] : null;
    return { latest, entries: issueEntries, signatures, chainOk: true };
}

/**
 * Cuenta los rechazos (`verdict: 'rejected'`) del issue — insumo del
 * circuit-breaker (CA-7).
 * @param {Array<object>} signatures
 * @returns {number}
 */
function countRejections(signatures) {
    return (Array.isArray(signatures) ? signatures : [])
        .filter(s => s && s.verdict === 'rejected').length;
}

// -----------------------------------------------------------------------------
// CA-3/CA-4 · Evaluación de la firma (authZ + anti-TOCTOU SHA + verdict)
// -----------------------------------------------------------------------------

/**
 * Evalúa la última firma del issue contra:
 *   1. Autorización (CA-4): `signed_by` ∈ authorizedSigners.
 *   2. Anti-TOCTOU (CA-3): `signed_commit` === `headOid` actual.
 *   3. Verdict (CA-10): signed / rejected.
 *
 * @param {object|null} latest
 * @param {object} p
 * @param {string} p.headOid           - SHA del HEAD que se va a mergear.
 * @param {Set<string>} p.authorizedSigners
 * @returns {{ pass: boolean, reason: string, verdict: string|null,
 *   route: 'dev'|null, signed_by?: string, authorized?: boolean, sha_ok?: boolean }}
 */
function evalSignature(latest, p) {
    if (!latest) {
        return { pass: false, reason: 'sin firma de aceptación del operador', verdict: null, route: null };
    }

    const signedBy = latest.signed_by == null ? '' : String(latest.signed_by);
    const authorizedSigners = p.authorizedSigners;

    // 1 · Autorización (CA-4). Fail-closed: authorizedSigners vacío → rechaza.
    const authorized = authorizedSigners.size > 0 && authorizedSigners.has(signedBy);
    if (!authorized) {
        return {
            pass: false,
            reason: authorizedSigners.size === 0
                ? 'firmante no verificable (sin authorizedSigners configurado — fail-closed CA-4)'
                : `firmante '${signedBy}' no autorizado (CA-4, confused-deputy)`,
            verdict: latest.verdict || null,
            route: null,
            signed_by: signedBy,
            authorized: false,
        };
    }

    // 3 · Verdict primero para rutear rechazos (CA-10) sin exigir SHA match.
    const verdict = latest.verdict;
    if (!VERDICTS.includes(verdict)) {
        return {
            pass: false,
            reason: `verdict inválido '${verdict}' (esperado: ${VERDICTS.join('|')})`,
            verdict: verdict || null,
            route: null,
            signed_by: signedBy,
            authorized: true,
        };
    }
    if (verdict === 'rejected') {
        return {
            pass: false,
            reason: 'operador rechazó la aceptación → vuelve a dev con el motivo',
            verdict: 'rejected',
            route: 'dev', // CA-10
            signed_by: signedBy,
            authorized: true,
        };
    }

    // 2 · Anti-TOCTOU firma↔SHA (CA-3). El HEAD pudo avanzar tras firmar.
    const headOid = String(p.headOid == null ? '' : p.headOid).toLowerCase();
    const signedCommit = String(latest.signed_commit == null ? '' : latest.signed_commit).toLowerCase();
    const shaOk = signedCommit.length > 0 && headOid.length > 0 && signedCommit === headOid;
    if (!shaOk) {
        return {
            pass: false,
            reason: staleShaReason(headOid || '(desconocido)', signedCommit || '(sin ancla)'),
            verdict: 'signed',
            route: null, // re-firma; NO vuelve a dev (el trabajo está OK, cambió el SHA)
            signed_by: signedBy,
            authorized: true,
            sha_ok: false,
        };
    }

    return {
        pass: true,
        reason: 'firma de aceptación válida y ligada al HEAD actual',
        verdict: 'signed',
        route: null,
        signed_by: signedBy,
        authorized: true,
        sha_ok: true,
    };
}

// -----------------------------------------------------------------------------
// Evaluación principal (sin kill switch — sirve a tests con enabled forzado)
// -----------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {object} args.issue    - `{ number, createdAt, labels? }`
 * @param {string} args.headOid  - SHA del HEAD a mergear (anti-TOCTOU CA-3).
 * @param {object} args.config   - `{ enabled, gate_mode, go_live_date, preauthorized_classes, max_signature_rebotes }`
 * @param {object} [args.options] - `{ pipelineDir, authorizedSigners }`
 * @returns {object}
 */
function evaluateRaw({ issue, headOid, config, options }) {
    options = options || {};
    config = config || {};
    const pipelineDir = resolvePipelineDir(options);
    const gateMode = config.gate_mode === 'enforce' ? 'enforce' : 'dry-run';
    const authorizedSigners = normalizeAuthorizedSigners(
        options.authorizedSigners != null ? options.authorizedSigners : config.expected_chat_id,
    );
    const maxRebotes = Math.min(
        Number.isFinite(config.max_signature_rebotes) && config.max_signature_rebotes > 0
            ? config.max_signature_rebotes
            : DEFAULT_MAX_SIGNATURE_REBOTES,
        MAX_SIGNATURE_REBOTES_CAP,
    );

    // R3 — dry-run nunca bloquea efectivamente.
    const effective = (originalDecision) => (gateMode === 'dry-run' ? 'approve' : originalDecision);

    // Validación de issue_id antes de tocar nada.
    let issueId;
    try {
        issueId = validateIssueId(issue && issue.number);
    } catch (e) {
        return {
            decision: effective('block'),
            original_decision: 'block',
            reason: e.message,
            gate_mode: gateMode,
            verdict: null,
            route: null,
            condition_results: {},
            invoked: true,
        };
    }

    // CA-6 · Opt-out por clase pre-autorizada estática. Antes del grandfathering
    // para que un opt-out explícito gane sobre la fecha.
    const preauth = evalPreauthorized(
        (issue && issue.labels) || [],
        config.preauthorized_classes || [],
    );
    if (preauth.preauthorized) {
        return {
            decision: 'approve',
            original_decision: 'approve',
            reason: `pre-autorizado por clase '${preauth.matched}' (opt-out estático del operador, CA-6)`,
            gate_mode: gateMode,
            verdict: null,
            route: null,
            condition_results: { preauthorized: { pass: true, matched: preauth.matched } },
            invoked: true,
        };
    }

    // Grandfathering: issues legacy (createdAt < go_live_date) no bloquean.
    const goLiveDate = config.go_live_date || null;
    if (goLiveDate && issue && typeof issue.createdAt === 'string' && issue.createdAt < goLiveDate) {
        return {
            decision: 'approve',
            original_decision: 'approve',
            reason: 'grandfathered (issue.createdAt < operator_signature.go_live_date)',
            gate_mode: gateMode,
            verdict: null,
            route: null,
            condition_results: {
                grandfathered: { pass: true, issue_created_at: issue.createdAt, go_live_date: goLiveDate },
            },
            invoked: true,
        };
    }

    // Lectura + validación del audit hash-chain (CA-8). Estado corrupto →
    // fail-cerrado (enforce) / fail-abierto (dry-run).
    let sigState;
    try {
        sigState = readSignatureState(issueId, pipelineDir);
    } catch (e) {
        const corrupt = e.code === ERROR_CODES.AUDIT_READ_ERROR
            || e.code === ERROR_CODES.AUDIT_CHAIN_BROKEN;
        if (!corrupt) throw e; // bug real: re-lanzar, no enmascarar.
        const originalDecision = 'block';
        const reason = gateMode === 'enforce'
            ? `fail-cerrado: ${e.message}`
            : `fail-abierto (dry-run): ${e.message}`;
        return {
            decision: effective(originalDecision),
            original_decision: originalDecision,
            reason,
            gate_mode: gateMode,
            verdict: null,
            route: null,
            condition_results: { audit_state: { pass: false, code: e.code, reason: e.message } },
            audit_error: e.message,
            invoked: true,
        };
    }

    // CA-7 · Circuit-breaker: al agotar rebotes NO se auto-aprueba → needs-human.
    const rejections = countRejections(sigState.signatures);
    if (rejections >= maxRebotes) {
        return {
            decision: effective('block'),
            original_decision: 'block',
            reason: `circuit-breaker de firmas: ${rejections} rechazos ≥ límite ${maxRebotes} → escala a humano (NO auto-aprueba, CA-7)`,
            gate_mode: gateMode,
            verdict: 'rejected',
            route: 'needs-human',
            condition_results: {
                circuit_breaker: { pass: false, rejections, limit: maxRebotes, route: 'needs-human' },
            },
            invoked: true,
        };
    }

    const sigRes = evalSignature(sigState.latest, { headOid, authorizedSigners });
    const originalDecision = sigRes.pass ? 'approve' : 'block';

    return {
        decision: effective(originalDecision),
        original_decision: originalDecision,
        reason: sigRes.reason,
        gate_mode: gateMode,
        verdict: sigRes.verdict,
        route: sigRes.route,
        condition_results: {
            signature: {
                pass: sigRes.pass,
                reason: sigRes.reason,
                verdict: sigRes.verdict,
                signed_by: sigRes.signed_by,
                authorized: sigRes.authorized,
                sha_ok: sigRes.sha_ok,
            },
            circuit_breaker: { pass: true, rejections, limit: maxRebotes },
        },
        invoked: true,
    };
}

// -----------------------------------------------------------------------------
// CA-2 · Evaluación con kill switch (entry point ÚNICO)
// -----------------------------------------------------------------------------

/**
 * Entry point ÚNICO del gate GATE 2 (CA-2). Los tres puntos de promoción a
 * `entrega` en pulpo.js + `delivery.js` invocan ESTA función — nunca chequean
 * firma por nº de línea ni duplican la lógica.
 *
 * Aplica el kill switch (`operator_signature.enabled !== true` → cortocircuito
 * sin leer/escribir nada) y delega en `evaluateRaw`.
 *
 * @param {object} args - ver `evaluateRaw`.
 * @returns {object}
 */
function evaluate(args) {
    const config = (args && args.config) || {};
    if (config.enabled !== true) {
        return {
            decision: 'approve',
            original_decision: 'approve',
            reason: 'gate disabled (operator_signature.enabled !== true)',
            gate_mode: 'disabled',
            verdict: null,
            route: null,
            condition_results: {},
            invoked: false,
        };
    }
    return evaluateRaw(args);
}

// -----------------------------------------------------------------------------
// WRITE path — emisión de nonce + persistencia de la firma (CA-5, CA-8)
// -----------------------------------------------------------------------------

/**
 * Emite un nonce de un solo uso ligado a `{issue, sha, timestamp}` (CA-5) y lo
 * persiste como `nonce_issued` en el audit hash-chain. Lo invoca el presentador
 * (#4579/#4580) al mostrar la evidencia + botones ✅/❌ al operador. El `nonce`
 * viaja en el `callback_data` del botón.
 *
 * @param {object} p
 * @param {number|string} p.issueId
 * @param {string} p.sha          - HEAD a firmar (signed_commit esperado).
 * @param {string} [p.evidenceHash] - hash del paquete de evidencia presentado.
 * @param {object} [p.config]      - `{ nonce_ttl_seconds }`.
 * @param {object} [p.options]     - `{ pipelineDir, now, nowISO, fsImpl }`.
 * @returns {{ ok: boolean, nonce?: string, entry?: object, reason?: string }}
 */
function issueNonce(p = {}) {
    const options = p.options || {};
    const config = p.config || {};
    const pipelineDir = resolvePipelineDir(options);
    let issueId;
    let sha;
    try {
        issueId = validateIssueId(p.issueId);
        sha = validateSha(p.sha);
    } catch (e) {
        return { ok: false, reason: e.message };
    }

    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const ttlMs = resolveNonceTtlMs(config.nonce_ttl_seconds);
    const nonce = generateNonce();
    const entry = {
        kind: KIND_NONCE,
        issue_id: issueId,
        sha,
        nonce,
        issued_at: now,
        ttl_ms: ttlMs,
        evidence_hash: typeof p.evidenceHash === 'string' ? p.evidenceHash : '',
    };
    const filePath = auditPath(pipelineDir, SIGNATURE_AUDIT_FILE);
    auditLog.appendChained({ file: filePath, entry, fsImpl: options.fsImpl });
    return { ok: true, nonce, entry };
}

/**
 * Persiste la firma de aceptación del operador en el audit hash-chain (CA-8
 * inmutabilidad/no-repudio). Es el punto que invoca el receptor de
 * `callback_query` (listener-telegram.js, #4575) al recibir el ✅/❌. Valida, en
 * ESTE orden estricto (CA-4 → CA-5), ANTES de escribir cualquier marker:
 *   1. authZ del firmante (CA-4): `signedBy` ∈ authorizedSigners. Fail-closed.
 *   2. verdict válido.
 *   3. nonce válido (CA-5): emitido, mismo SHA, no expirado, no consumido.
 *
 * @param {object} p
 * @param {number|string} p.issueId
 * @param {string} p.signedBy      - `chat_id` del operador.
 * @param {string} p.signedCommit  - SHA firmado (anti-TOCTOU CA-3).
 * @param {string} p.nonce         - nonce del callback (CA-5).
 * @param {string} p.verdict       - 'signed' | 'rejected'.
 * @param {string} [p.evidenceHash]
 * @param {string} [p.gateMode]    - 'dry-run' | 'enforce'.
 * @param {object} [p.options]     - `{ pipelineDir, authorizedSigners, now, nowISO, fsImpl }`.
 * @returns {{ ok:boolean, reason?:string, entry?:object }}
 */
function recordAcceptanceSignature(p = {}) {
    const options = p.options || {};
    const pipelineDir = resolvePipelineDir(options);
    let issueId;
    let signedCommit;
    try {
        issueId = validateIssueId(p.issueId);
        signedCommit = validateSha(p.signedCommit);
    } catch (e) {
        return { ok: false, reason: e.message };
    }
    const signedBy = String(p.signedBy == null ? '' : p.signedBy);
    const authorizedSigners = normalizeAuthorizedSigners(options.authorizedSigners);

    // 1 · CA-4 — sólo el operador autorizado firma. Fail-closed sin allowlist.
    if (authorizedSigners.size === 0 || !authorizedSigners.has(signedBy)) {
        return { ok: false, reason: 'firmante no autorizado (CA-4) — firma rechazada, sin escribir marker' };
    }
    // 2 · verdict válido.
    if (!VERDICTS.includes(p.verdict)) {
        return { ok: false, reason: `verdict inválido '${p.verdict}' (esperado: ${VERDICTS.join('|')})` };
    }

    const filePath = auditPath(pipelineDir, SIGNATURE_AUDIT_FILE);
    let existing = [];
    try {
        existing = fs.existsSync(filePath) ? auditLog.readAll(filePath) : [];
    } catch (_) { existing = []; }

    // 3 · CA-5 — nonce válido (emitido, mismo SHA, no expirado, no consumido).
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const nonceRes = validateNonce(existing, { issueId, nonce: p.nonce, sha: signedCommit, now });
    if (!nonceRes.valid) {
        return { ok: false, reason: `nonce inválido (CA-5): ${nonceRes.reason}` };
    }

    const signedAt = options.nowISO || new Date(now).toISOString();
    const entry = {
        kind: KIND_SIGNATURE,
        issue_id: issueId,
        signed_by: signedBy,
        signed_at: signedAt,
        signed_commit: signedCommit,
        nonce: p.nonce,
        verdict: p.verdict,
        evidence_hash: typeof p.evidenceHash === 'string' ? p.evidenceHash : '',
        gate_mode: p.gateMode === 'enforce' ? 'enforce' : 'dry-run',
    };
    const res = auditLog.appendChained({ file: filePath, entry, fsImpl: options.fsImpl });
    return { ok: true, entry, hash_self: res.hash_self };
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
    // Entry points
    evaluate,          // CA-2 — función ÚNICA de verificación (kill switch)
    evaluateRaw,
    issueNonce,        // WRITE — emisión de nonce (presentador #4579/#4580)
    recordAcceptanceSignature, // WRITE — firma del operador (listener-telegram)

    // Helpers (exportados para tests + presentador/listener)
    computeEvidenceHash,
    sanitizeEvidencePackage,   // CA-9
    validateIssueId,
    validateSha,
    normalizeAuthorizedSigners,
    evalPreauthorized,         // CA-6
    generateNonce,
    validateNonce,             // CA-5
    resolveNonceTtlMs,
    readSignatureState,
    evalSignature,             // CA-3/CA-4
    countRejections,           // CA-7
    filterByKind,
    staleShaReason,

    // Constantes
    SIGNATURE_AUDIT_FILE,
    VERDICTS,
    KIND_NONCE,
    KIND_SIGNATURE,
    ERROR_CODES,
    DEFAULT_NONCE_TTL_SECONDS,
    MAX_NONCE_TTL_SECONDS,
    DEFAULT_MAX_SIGNATURE_REBOTES,
    MAX_SIGNATURE_REBOTES_CAP,
};
