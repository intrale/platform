// =============================================================================
// operator-signoff-gate.js — GATE 1 · Firma de Definición del operador (#4574)
// =============================================================================
//
// Épico: #4570 · Diseño: docs/pipeline/gates-firma-operador.md (§3 GATE 1,
// §10.4 re-definición, §12 fail-closed, §13 autoridad e integridad).
//
// Hermano determinístico de `architect-signoff-gate.js` (#3614). Se invoca en
// `pulpo.js`, dentro de `if (pipelineName === 'definicion')`, JUSTO antes de
// encolar el label `Ready`. Retiene la admisión a `desarrollo` hasta que el
// operador FIRMA la definición (criterios + mockup). Contrato de entrada/salida:
//
//   evaluate({ issue, body, comments, config, options }) →
//     { decision: 'approve'|'block', gate_mode, original_decision, reason,
//       verdict, route, condition_results, invoked }
//
// A DIFERENCIA del architect-gate (que valida un marker+token de un BOT), este
// gate valida la firma de un HUMANO (el operador). El canal de firma en sí — los
// botones ✅/❌/✏️ de Telegram — lo provee `operator-gate.js` (#4579, write path).
// Este módulo es el READ/decision path: lee el audit hash-chain de firmas y
// decide si el issue puede promover.
//
// REQUISITOS DE SEGURIDAD (fijados por `security` en análisis — no negociables)
// -----------------------------------------------------------------------------
//  A01 · Autorización del firmante. Sólo el operador autorizado (su `chat_id`,
//        patrón `expectedChatId` de commander-deterministic.js:910) produce una
//        firma válida. Ningún agente/proceso automático puede firmar. Quien
//        PRESENTA el gate (agente) ≠ quien FIRMA (operador). Fail-closed: sin
//        `authorizedSigners` configurado, ninguna firma es válida.
//  A03 · Sanitización de presentación. Todo texto de criterios/body que se
//        renderice al operador pasa por `sanitizeForPresentation` (detecta
//        prompt-injection vía handoff.detectInjection). Este módulo NO renderiza
//        (eso es #4579/#4580), pero exporta el helper para el presentador.
//  A04 · Fail-cerrado en `enforce` / fail-abierto en `dry-run` ante estado
//        corrupto de la firma (audit ilegible o chain roto). Nunca auto-admite
//        por agotamiento (§12 del diseño).
//  A08 · Anti-bypass + anti-TOCTOU. La transición se valida contra el AUDIT LOG
//        hash-chain (`audit-log.verifyChain`), NO contra la mera presencia de un
//        archivo de estado en el FS. Además, la firma ancla `criteria_hash =
//        sha256(body)` al momento de firmar: si el body cambia después, la firma
//        se invalida y se re-solicita (idéntico al `signed_commit` anti-stale
//        del architect-gate Fase 2).
//
// Rollout gradual (espeja architect:):
//   - `enabled: false` → kill switch, cortocircuita `approve` sin escribir.
//   - `gate_mode: dry-run` → evalúa y loguea pero NUNCA bloquea (original_decision
//     puede ser block, pero decision efectiva = approve).
//   - `gate_mode: enforce` → un block lógico retiene la promoción.
//   - `go_live_date` → issues legacy (createdAt anterior) se grandfatherean.
//   - `preauthorized_classes` → opt-out por label, editado SÓLO por el operador
//     (read-only para el pipeline, security A01).
//
// El módulo NO carga credentials ni lee `.env`: los firmantes autorizados se
// inyectan (`options.authorizedSigners`) por el caller (pulpo), que los resuelve
// de `credentials.js`. NO toca paths fuera de `<pipelineDir>/audit/`.
// =============================================================================
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const auditLog = require('./audit-log');

// -----------------------------------------------------------------------------
// Constantes
// -----------------------------------------------------------------------------

// Audit hash-chain de firmas de definición (GATE 1). Distinto del
// `operator-gate-signatures.jsonl` de #4579 porque el artefacto de GATE 1
// persiste `criteria_hash` (ancla anti-TOCTOU, A08) que el schema de #4579 no
// contempla. Ambos usan `audit-log.appendChained` (mismo writer, sin duplicar
// el patrón hash-chain).
const SIGNOFF_AUDIT_FILE = 'operator-signoff.jsonl';

// Verdicts válidos del artefacto de firma (§13 del diseño + §10.4).
//   signed         → el operador aprobó la definición → promueve.
//   re-definition  → "el spec estaba mal" → vuelve a `criterios` (NO dev-reject).
//   rejected       → rechazo normal → vuelve a `criterios`.
const VERDICTS = Object.freeze(['signed', 're-definition', 'rejected']);

// Códigos de error (visibles al caller para logging granular).
const ERROR_CODES = Object.freeze({
    AUDIT_READ_ERROR: 'AUDIT_READ_ERROR',
    AUDIT_CHAIN_BROKEN: 'AUDIT_CHAIN_BROKEN',
    INVALID_ISSUE_ID: 'INVALID_ISSUE_ID',
});

// Rate-limit por defecto del canal de firma (CA-11). Aplica al WRITE path
// (`recordDefinitionSignature`), no al `evaluate` (read-only).
const DEFAULT_RATE_LIMIT = Object.freeze({ windowMs: 60 * 1000, maxPerWindow: 5 });

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
// Validación de issue_id (hereda patrón CA-PO-B4-PATH del architect-gate)
// -----------------------------------------------------------------------------

/**
 * Valida y normaliza `issue_id` a entero positivo. Rechaza path-traversal,
 * shell metacharacters, vacíos, ceros, negativos, no-numéricos.
 * @param {string|number} issue
 * @returns {number}
 */
function validateIssueId(issue) {
    if (issue == null) {
        const err = new Error('operator-signoff-gate: issue_id requerido');
        err.code = ERROR_CODES.INVALID_ISSUE_ID;
        throw err;
    }
    const s = String(issue).trim();
    if (!/^\d+$/.test(s) || s === '0') {
        const err = new Error(`operator-signoff-gate: issue_id inválido "${s}" (esperado /^\\d+$/, > 0)`);
        err.code = ERROR_CODES.INVALID_ISSUE_ID;
        throw err;
    }
    return Number(s);
}

// -----------------------------------------------------------------------------
// A08 · Anti-TOCTOU — hash del contenido firmado
// -----------------------------------------------------------------------------

/**
 * Computa el `criteria_hash` determinístico del contenido que el operador firma.
 * Se ancla sobre el body completo del issue (los criterios de aceptación viven
 * en el body, por lo que cualquier cambio a un criterio cambia el hash). NFC +
 * trim para robustez tipográfica; mismo body lógico → mismo hash.
 *
 * @param {string} body
 * @returns {string} `sha256:<hex>`
 */
function computeCriteriaHash(body) {
    const normalized = String(body == null ? '' : body).trim().normalize('NFC');
    const digest = crypto.createHash('sha256')
        .update('operator-signoff-def|v1|', 'utf8')
        .update(normalized, 'utf8')
        .digest('hex');
    return `sha256:${digest}`;
}

// -----------------------------------------------------------------------------
// A03 · Sanitización de presentación (para el presentador #4579/#4580)
// -----------------------------------------------------------------------------

/**
 * Detecta patrones de prompt-injection en el texto de criterios/body antes de
 * renderizarlo al operador. Reusa `handoff.detectInjection` (single source of
 * truth). Devuelve `{ safe, matches }`. NO muta el texto — el presentador decide
 * si escapar/redactar/alertar. Fail-safe: si el módulo handoff no está
 * disponible, degrada a `safe: false` (conservador: mejor alertar de más).
 *
 * @param {string} text
 * @returns {{ safe: boolean, matches: Array<any> }}
 */
function sanitizeForPresentation(text) {
    const s = String(text == null ? '' : text);
    try {
        const handoff = require('./handoff');
        if (typeof handoff.detectInjection === 'function') {
            const res = handoff.detectInjection(s);
            // detectInjection devuelve `{ text, hits }` (hits = patrones
            // matcheados). Normalizamos también las formas bool / {detected}
            // por robustez ante futuras versiones.
            if (typeof res === 'boolean') {
                return { safe: !res, matches: [] };
            }
            if (res && typeof res === 'object') {
                const matches = res.hits || res.matches || res.patterns || [];
                const detected = res.detected === true
                    || (Array.isArray(matches) && matches.length > 0);
                return { safe: !detected, matches };
            }
        }
    } catch (_) {
        // handoff no disponible en este contexto → conservador.
        return { safe: false, matches: [] };
    }
    return { safe: true, matches: [] };
}

// -----------------------------------------------------------------------------
// Autorización del firmante (A01)
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
// Preauthorized classes (opt-out por label — §4 del diseño, A01)
// -----------------------------------------------------------------------------

/**
 * ¿El issue pertenece a una clase pre-autorizada por el operador? El match es
 * por label: si alguno de los labels del issue está en `preauthorized_classes`,
 * el gate hace opt-out (aprueba sin exigir firma). La lista es read-only para el
 * pipeline (sólo el operador la edita en config.yaml, A01).
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
// Lectura + validación del audit hash-chain de firmas (A08)
// -----------------------------------------------------------------------------

/**
 * Lee y valida las firmas del issue desde el audit hash-chain. Devuelve la
 * ÚLTIMA firma del issue (por orden de cadena — la más reciente gana) junto con
 * la validez de la cadena.
 *
 * Lanza Error con:
 *   - code AUDIT_READ_ERROR   si el archivo existe pero no se puede leer.
 *   - code AUDIT_CHAIN_BROKEN si la cadena hash está rota (tamper-evident, A08).
 * Si el archivo no existe → NO lanza; devuelve `{ latest: null, chainOk: true }`
 * (ausencia de firma es un fail normal, no un estado corrupto).
 *
 * @param {number} issueId
 * @param {string} pipelineDir
 * @returns {{ latest: object|null, chainOk: boolean, total: number }}
 */
function readSignatureState(issueId, pipelineDir) {
    const filePath = auditPath(pipelineDir, SIGNOFF_AUDIT_FILE);

    if (!fs.existsSync(filePath)) {
        return { latest: null, chainOk: true, total: 0 };
    }

    // A08 — validar integridad de la cadena ANTES de confiar en cualquier entry.
    // Una línea "firmada" escrita a mano en el FS (bypass) rompe la cadena.
    let chain;
    try {
        chain = auditLog.verifyChain(filePath);
    } catch (e) {
        const err = new Error(`operator-signoff audit chain no verificable: ${e.message}`);
        err.code = ERROR_CODES.AUDIT_READ_ERROR;
        err.cause = e;
        throw err;
    }
    if (!chain.ok) {
        const err = new Error(
            `operator-signoff audit chain rota en línea ${chain.brokenAt}: ${chain.reason}`,
        );
        err.code = ERROR_CODES.AUDIT_CHAIN_BROKEN;
        throw err;
    }

    let entries;
    try {
        entries = auditLog.readAll(filePath);
    } catch (e) {
        const err = new Error(`operator-signoff audit ilegible: ${e.message}`);
        err.code = ERROR_CODES.AUDIT_READ_ERROR;
        err.cause = e;
        throw err;
    }

    // Última firma del issue por orden de cadena (append-only → orden temporal).
    let latest = null;
    let total = 0;
    for (const rec of entries) {
        if (rec && Number(rec.issue_id) === issueId) {
            latest = rec;
            total += 1;
        }
    }
    return { latest, chainOk: true, total };
}

// -----------------------------------------------------------------------------
// Evaluación de la firma (autorización + anti-TOCTOU + verdict)
// -----------------------------------------------------------------------------

/**
 * Evalúa la última firma del issue contra las 3 comprobaciones:
 *   1. Autorización (A01): `signed_by` ∈ authorizedSigners.
 *   2. Anti-TOCTOU (A08): `criteria_hash` === hash del body actual.
 *   3. Verdict (§10.4): signed / re-definition / rejected.
 *
 * @returns {{
 *   pass: boolean, reason: string, verdict: string|null,
 *   route: 're-definition'|'rejected'|null, signed_by?: string,
 *   authorized?: boolean, hash_ok?: boolean
 * }}
 */
function evalSignature(latest, issueId, currentBody, authorizedSigners) {
    if (!latest) {
        return {
            pass: false,
            reason: 'sin firma del operador para la definición',
            verdict: null,
            route: null,
        };
    }

    const signedBy = latest.signed_by == null ? '' : String(latest.signed_by);

    // 1 · Autorización (A01). Fail-closed: authorizedSigners vacío → rechaza.
    const authorized = authorizedSigners.size > 0 && authorizedSigners.has(signedBy);
    if (!authorized) {
        return {
            pass: false,
            reason: authorizedSigners.size === 0
                ? 'firmante no verificable (sin authorizedSigners configurado — fail-closed A01)'
                : `firmante '${signedBy}' no autorizado (A01, confused-deputy)`,
            verdict: latest.verdict || null,
            route: null,
            signed_by: signedBy,
            authorized: false,
        };
    }

    // 2 · Anti-TOCTOU (A08). El body pudo cambiar tras la firma.
    const expectedHash = computeCriteriaHash(currentBody);
    const hashOk = latest.criteria_hash === expectedHash;
    if (!hashOk) {
        return {
            pass: false,
            reason: `firma stale (anti-TOCTOU A08): criteria_hash firmado ≠ body actual — re-solicitar firma`,
            verdict: latest.verdict || null,
            route: null,
            signed_by: signedBy,
            authorized: true,
            hash_ok: false,
        };
    }

    // 3 · Verdict (§10.4).
    const verdict = latest.verdict;
    if (!VERDICTS.includes(verdict)) {
        return {
            pass: false,
            reason: `verdict inválido '${verdict}' (esperado: ${VERDICTS.join('|')})`,
            verdict: verdict || null,
            route: null,
            signed_by: signedBy,
            authorized: true,
            hash_ok: true,
        };
    }
    if (verdict === 'signed') {
        return {
            pass: true,
            reason: 'firma de definición válida y vigente',
            verdict: 'signed',
            route: null,
            signed_by: signedBy,
            authorized: true,
            hash_ok: true,
        };
    }
    // re-definition | rejected → block con ruta diferenciada (§10.4).
    return {
        pass: false,
        reason: verdict === 're-definition'
            ? 'operador marcó re-definición: el spec estaba mal → vuelve a criterios (NO dev-reject)'
            : 'operador rechazó la definición → vuelve a criterios',
        verdict,
        route: verdict, // 're-definition' | 'rejected'
        signed_by: signedBy,
        authorized: true,
        hash_ok: true,
    };
}

// -----------------------------------------------------------------------------
// Evaluación principal (sin kill switch — sirve a tests con enabled forzado)
// -----------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {object} args.issue    - `{ number, createdAt, labels? }`
 * @param {string} args.body     - body actual del issue (anti-TOCTOU).
 * @param {Array}  [args.comments] - aceptado por paridad de contrato (no usado).
 * @param {object} args.config   - `{ enabled, gate_mode, go_live_date, preauthorized_classes }`
 * @param {object} [args.options] - `{ pipelineDir, nowISO, authorizedSigners }`
 * @returns {object}
 */
function evaluateRaw({ issue, body, config, options }) {
    options = options || {};
    config = config || {};
    const pipelineDir = resolvePipelineDir(options);
    const gateMode = config.gate_mode === 'enforce' ? 'enforce' : 'dry-run';
    const authorizedSigners = normalizeAuthorizedSigners(
        options.authorizedSigners != null ? options.authorizedSigners : config.expected_chat_id,
    );

    // R3 — dry-run nunca bloquea efectivamente.
    const effective = (originalDecision) => (gateMode === 'dry-run' ? 'approve' : originalDecision);

    // Validación de issue_id antes de tocar nada.
    let issueId;
    try {
        issueId = validateIssueId(issue && issue.number);
    } catch (e) {
        // issue_id inválido es estado corrupto de input → fail-cerrado/abierto.
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

    // Opt-out por clase pre-autorizada (A01, §4). Antes del grandfathering para
    // que un opt-out explícito gane sobre la fecha.
    const preauth = evalPreauthorized(
        (issue && issue.labels) || [],
        config.preauthorized_classes || [],
    );
    if (preauth.preauthorized) {
        return {
            decision: 'approve',
            original_decision: 'approve',
            reason: `pre-autorizado por clase '${preauth.matched}' (opt-out del operador)`,
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
            reason: 'grandfathered (issue.createdAt < operator_signoff.go_live_date)',
            gate_mode: gateMode,
            verdict: null,
            route: null,
            condition_results: {
                grandfathered: { pass: true, issue_created_at: issue.createdAt, go_live_date: goLiveDate },
            },
            invoked: true,
        };
    }

    // Lectura + validación del audit hash-chain (A08). Estado corrupto →
    // fail-cerrado (enforce) / fail-abierto (dry-run) (A04).
    let sigState;
    try {
        sigState = readSignatureState(issueId, pipelineDir);
    } catch (e) {
        const corrupt = e.code === ERROR_CODES.AUDIT_READ_ERROR
            || e.code === ERROR_CODES.AUDIT_CHAIN_BROKEN;
        if (!corrupt) throw e; // bug real: re-lanzar, no enmascarar.
        const originalDecision = 'block';
        const reason = gateMode === 'enforce'
            ? `fail-cerrado (A04): ${e.message}`
            : `fail-abierto (dry-run, A04): ${e.message}`;
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

    const sigRes = evalSignature(sigState.latest, issueId, body, authorizedSigners);
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
                hash_ok: sigRes.hash_ok,
            },
        },
        invoked: true,
    };
}

// -----------------------------------------------------------------------------
// Evaluación con kill switch (entry point público)
// -----------------------------------------------------------------------------

/**
 * Entry point del gate. Aplica el kill switch (`operator_signoff.enabled !==
 * true` → cortocircuito sin escribir/leer nada) y delega en `evaluateRaw`.
 * @param {object} args - ver `evaluateRaw`.
 * @returns {object}
 */
function evaluate(args) {
    const config = (args && args.config) || {};
    if (config.enabled !== true) {
        return {
            decision: 'approve',
            original_decision: 'approve',
            reason: 'gate disabled (operator_signoff.enabled !== true)',
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
// WRITE path — persistencia del artefacto de firma (CA-11 rate-limit + A01)
// -----------------------------------------------------------------------------

/**
 * Rate-limit por `signed_by` (CA-11): cuenta las firmas del mismo firmante
 * dentro de `windowMs`. Determinístico (recibe `now`), sin estado global.
 *
 * @param {Array<object>} entries - firmas ya persistidas (audit-log.readAll).
 * @param {string} signedBy
 * @param {{ windowMs:number, maxPerWindow:number, now:number }} opts
 * @returns {{ allowed: boolean, countInWindow: number }}
 */
function checkSignatureRateLimit(entries, signedBy, opts = {}) {
    const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : DEFAULT_RATE_LIMIT.windowMs;
    const maxPerWindow = Number.isFinite(opts.maxPerWindow) ? opts.maxPerWindow : DEFAULT_RATE_LIMIT.maxPerWindow;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const since = now - windowMs;
    let count = 0;
    for (const rec of (Array.isArray(entries) ? entries : [])) {
        if (!rec || String(rec.signed_by) !== String(signedBy)) continue;
        const ts = Date.parse(rec.signed_at || '') || Number(rec.created_at) || 0;
        if (ts >= since) count += 1;
    }
    return { allowed: count < maxPerWindow, countInWindow: count };
}

/**
 * Persiste el artefacto de firma en el audit hash-chain (A08 inmutabilidad/
 * no-repudio). Reusa `audit-log.appendChained` (NO agrega writer nuevo). Valida
 * autorización (A01) y rate-limit (CA-11) ANTES de escribir. Este es el punto
 * que invocaría el canal de firma (#4579) al recibir el ✅/✏️/❌ del operador.
 *
 * @param {object} p
 * @param {number|string} p.issueId
 * @param {string} p.signedBy    - `chat_id` del operador (expectedChatId).
 * @param {string} p.body        - body al momento de firmar (para criteria_hash).
 * @param {string} p.verdict     - 'signed' | 're-definition' | 'rejected'.
 * @param {string} p.gateMode    - 'dry-run' | 'enforce'.
 * @param {object} [p.options]   - `{ pipelineDir, authorizedSigners, nowISO, now, rateLimit, fsImpl }`
 * @returns {{ ok:boolean, reason?:string, entry?:object, hash_self?:string }}
 */
function recordDefinitionSignature(p = {}) {
    const options = p.options || {};
    const pipelineDir = resolvePipelineDir(options);
    const issueId = validateIssueId(p.issueId);
    const signedBy = String(p.signedBy == null ? '' : p.signedBy);
    const authorizedSigners = normalizeAuthorizedSigners(options.authorizedSigners);

    // A01 — sólo el operador autorizado firma. Fail-closed sin allowlist.
    if (authorizedSigners.size === 0 || !authorizedSigners.has(signedBy)) {
        return { ok: false, reason: 'firmante no autorizado (A01) — firma rechazada' };
    }
    if (!VERDICTS.includes(p.verdict)) {
        return { ok: false, reason: `verdict inválido '${p.verdict}'` };
    }

    const filePath = auditPath(pipelineDir, SIGNOFF_AUDIT_FILE);

    // CA-11 — rate-limit por firmante.
    let existing = [];
    try {
        existing = fs.existsSync(filePath) ? auditLog.readAll(filePath) : [];
    } catch (_) { existing = []; }
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const rl = checkSignatureRateLimit(existing, signedBy, { ...(options.rateLimit || {}), now });
    if (!rl.allowed) {
        return { ok: false, reason: `rate-limit excedido (CA-11): ${rl.countInWindow} firmas en ventana` };
    }

    const signedAt = options.nowISO || new Date(now).toISOString();
    const entry = {
        issue_id: issueId,
        signed_by: signedBy,
        signed_at: signedAt,
        criteria_hash: computeCriteriaHash(p.body),
        verdict: p.verdict,
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
    evaluate,
    evaluateRaw,
    recordDefinitionSignature,

    // Helpers (exportados para tests + presentador #4579/#4580)
    computeCriteriaHash,
    sanitizeForPresentation,
    validateIssueId,
    normalizeAuthorizedSigners,
    evalPreauthorized,
    readSignatureState,
    evalSignature,
    checkSignatureRateLimit,

    // Constantes
    SIGNOFF_AUDIT_FILE,
    VERDICTS,
    ERROR_CODES,
    DEFAULT_RATE_LIMIT,
};
