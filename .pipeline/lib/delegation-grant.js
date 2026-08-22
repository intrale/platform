// =============================================================================
// delegation-grant.js — Capabilities firmadas HMAC-SHA256 para delegar acciones
// operativas del pipeline (issue #4630, split de #4581).
//
// Modelo de seguridad
// -------------------
// Un GRANT es una capability portable que autoriza a un `delegate` a proceder
// sobre una o más CLASES de gate delegables, por tiempo acotado, UNA sola vez.
// El grant es un envelope `{ payload, signature }`:
//   payload = { grantor, delegate, gateClasses[], exp, nonce, secretVersion }
//   signature = HMAC-SHA256( canonicalJson(payload), key(secretVersion) )
//
// Propiedades (OWASP A01/A02/A04/A07/A09):
//   - Solo un operador `primary` puede EMITIR grants (allowlist fail-closed).
//     Un `backup` puede ejercer lo delegado pero NUNCA re-delegar.
//   - La firma cubre EXACTAMENTE el payload público (canonicalizado) — orden de
//     keys irrelevante, firma reproducible.
//   - `exp` corto → expiración.
//   - `nonce` single-use → anti-replay. El consumo es validar-y-marcar ATÓMICO
//     bajo file-lock, así dos consumos concurrentes del mismo nonce no pueden
//     ambos ganar.
//   - `secretVersion` → revocación masiva por rotación: al rotar la versión
//     activa, todos los grants firmados con versiones anteriores quedan inválidos
//     aunque no hayan expirado.
//   - Revocación explícita por nonce → invalida un grant activo no usado.
//   - GATE 1 (Definición) y GATE 2 (Aceptación) NUNCA son delegables: viven en la
//     constante `PERMANENTLY_NON_DELEGABLE_GATE_CLASSES`, no en config editable.
//
// Auditoría (A09): concesión, consumo, rechazo y revocación se registran en un
// audit append-only/tamper-evident reutilizando `.pipeline/lib/audit-log.js`
// (`appendChained` + `verifyChain`). Los eventos NUNCA persisten secretos, la
// firma completa ni HMACs — solo campos públicos y el `nonce` (identificador de
// un solo uso, no material sensible), con el motivo redactado.
//
// Este módulo consume `operator-allowlist` y `audit-log`; NO al revés.
// =============================================================================
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const auditLog = require('./audit-log');
const allowlistModule = require('./operator-allowlist');
const { redactSensitive } = require('./redact');

// -----------------------------------------------------------------------------
// Clases de gate delegables — CONSTANTE CERRADA en código.
//
// Son las acciones operativas de GATE 3 (auto-proceder del kernel), alineadas
// con `kernel-action-policy.js`. GATE 1 y GATE 2 NO están acá y NO pueden
// agregarse por configuración (ver `PERMANENTLY_NON_DELEGABLE_GATE_CLASSES`).
// -----------------------------------------------------------------------------
const DELEGABLE_GATE_CLASSES = Object.freeze([
    'realign-allowlist',
    'reseed-wave',
    'quota-flag',
    'worktree-reset',
    'desync-autoresolve',
    // #4631 (split de #4581) — clase delegable de las acciones rápidas del bloqueo
    // humano (`needs-human`: unblock / mas-contexto / devolver-definicion /
    // priorizar). Un grant firmado que incluye esta clase habilita a un operador
    // delegado a ejercer esas acciones por Telegram, previa validación de identidad
    // server-side en `human-block-action-handler.js`. GATE 1/2 siguen NO delegables.
    'human-block-action',
]);

// Clases PERMANENTEMENTE no delegables. Bloqueadas por constante de código:
// GATE 1 (Definición) y GATE 2 (Aceptación) nunca pueden auto-procederse ni
// delegarse. Aunque alguien las agregara a `DELEGABLE_GATE_CLASSES` por error,
// la validación las rechaza igual (defensa redundante).
const PERMANENTLY_NON_DELEGABLE_GATE_CLASSES = Object.freeze([
    'gate1-definition',
    'gate2-acceptance',
]);

// TTL corto por defecto (SEC: exp corto). 10 minutos.
const DEFAULT_TTL_MS = 10 * 60 * 1000;

// Prefijo de derivación de clave (KDF por versión de secreto).
const KEY_INFO_PREFIX = 'delegation-grant/v1/';

// Causas de rechazo diferenciadas (enum cerrado). Se exponen para que callers y
// tests comparen contra símbolos estables, no strings mágicos.
const REJECT_REASONS = Object.freeze({
    MALFORMED: 'malformed',
    UNKNOWN_OPERATOR: 'unknown-operator',
    NOT_PRIMARY: 'not-primary',
    UNKNOWN_DELEGATE: 'unknown-delegate',
    NON_DELEGABLE_GATE: 'non-delegable-gate',
    BAD_SIGNATURE: 'bad-signature',
    EXPIRED: 'expired',
    VERSION_INVALID: 'version-invalid',
    REVOKED: 'revoked',
    REPLAYED: 'replayed',
    DELEGATE_MISMATCH: 'delegate-mismatch',
    LOCK_FAILED: 'lock-failed',
    AUDIT_FAILED: 'audit-failed',
});

// Eventos de audit (enum cerrado).
const AUDIT_EVENTS = Object.freeze({
    ISSUED: 'grant-issued',
    CONSUMED: 'grant-consumed',
    REJECTED: 'grant-rejected',
    REVOKED: 'grant-revoked',
});

function rej(reason, extra) {
    return { ok: false, reason, ...(extra || {}) };
}

/** @returns {boolean} true si la clase está en la allowlist cerrada y no es GATE1/2. */
function isDelegableGateClass(gc) {
    if (typeof gc !== 'string') return false;
    if (PERMANENTLY_NON_DELEGABLE_GATE_CLASSES.includes(gc)) return false;
    return DELEGABLE_GATE_CLASSES.includes(gc);
}

/**
 * Deriva una clave dedicada por versión de secreto (no reusar el secreto crudo).
 * @param {string} rawSecret
 * @param {string} version
 * @returns {Buffer}
 */
function deriveKey(rawSecret, version) {
    return crypto.createHmac('sha256', String(rawSecret))
        .update(KEY_INFO_PREFIX + String(version))
        .digest();
}

/** Comparación timing-safe de dos firmas hex. Distinta longitud → false. */
function timingSafeEqualHex(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

/**
 * Firma el payload público canonicalizado. La firma cubre EXACTAMENTE el payload
 * (no campos derivados). Reusa `canonicalJsonStringify` de audit-log para orden
 * determinístico de keys.
 */
function signPayload(payload, rawSecret, version) {
    const canonical = auditLog.canonicalJsonStringify(payload);
    const key = deriveKey(rawSecret, version);
    return crypto.createHmac('sha256', key).update(canonical, 'utf8').digest('hex');
}

/**
 * Crea una autoridad de grants con secreto(s), allowlist y stores de estado
 * inyectables (tests herméticos: nunca leen credentials.json ni .env).
 *
 * @param {object} opts
 * @param {Object<string,string>} opts.secrets - map versión→secreto crudo.
 * @param {string} opts.activeSecretVersion - versión activa para firmar/validar.
 * @param {object} [opts.allowlist] - allowlist de operadores (default: módulo prod).
 * @param {number} [opts.ttlMs] - vida del grant (default 10min).
 * @param {function} [opts.now] - clock inyectable (default Date.now).
 * @param {string} [opts.auditFile] - JSONL del audit tamper-evident.
 * @param {string} [opts.nonceFile] - JSONL de nonces consumidos.
 * @param {string} [opts.revocationFile] - JSONL de nonces revocados.
 * @param {function} [opts.nonceGen] - generador de nonce (default random 16 bytes hex).
 */
function createGrantAuthority(opts = {}) {
    const secrets = opts.secrets && typeof opts.secrets === 'object' ? opts.secrets : {};
    const activeSecretVersion = opts.activeSecretVersion;
    if (typeof activeSecretVersion !== 'string' || activeSecretVersion.length === 0) {
        throw new Error('delegation-grant: `activeSecretVersion` requerido (string no vacío).');
    }
    if (!secrets[activeSecretVersion]) {
        throw new Error(`delegation-grant: no hay secreto para la versión activa '${activeSecretVersion}'.`);
    }
    const allowlist = opts.allowlist || allowlistModule;
    const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS;
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    const nonceGen = typeof opts.nonceGen === 'function'
        ? opts.nonceGen
        : () => crypto.randomBytes(16).toString('hex');

    const baseDir = path.join(auditLogDirBase(), 'state');
    const auditFile = opts.auditFile || path.join(auditLogDirBase(), 'audit', 'delegation-grants.jsonl');
    const nonceFile = opts.nonceFile || path.join(baseDir, 'delegation-grants-used.jsonl');
    const revocationFile = opts.revocationFile || path.join(baseDir, 'delegation-grants-revoked.jsonl');

    // -- stores JSONL (nonces consumidos / revocados) ------------------------
    function readNonceSet(file) {
        const set = new Set();
        let raw;
        try { raw = fs.readFileSync(file, 'utf8'); } catch { return set; }
        for (const ln of raw.split('\n')) {
            if (!ln.trim()) continue;
            try {
                const o = JSON.parse(ln);
                if (o && typeof o.n === 'string') set.add(o.n);
            } catch { /* línea corrupta — skip */ }
        }
        return set;
    }
    function isRevoked(nonce) {
        return readNonceSet(revocationFile).has(nonce);
    }
    function isConsumed(nonce) {
        return readNonceSet(nonceFile).has(nonce);
    }
    function appendNonce(file, entry) {
        try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* idempotente */ }
        fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
    }

    // -- audit (tamper-evident, sin material sensible) -----------------------
    function sanitizeAuditFields(fields) {
        const out = {};
        for (const [k, v] of Object.entries(fields || {})) {
            // NUNCA persistir firma/secreto ni el envelope completo.
            if (k === 'signature' || k === 'secret' || k === 'grant' || k === 'payload') continue;
            if (k === 'reason' || k === 'note') {
                out[k] = redactSensitive(String(v == null ? '' : v));
            } else if (k === 'gateClasses' && Array.isArray(v)) {
                out[k] = v.map(String);
            } else {
                out[k] = v;
            }
        }
        return out;
    }
    function audit(event, fields) {
        try {
            auditLog.appendChained({
                file: auditFile,
                entry: { event, ...sanitizeAuditFields(fields) },
            });
            return { ok: true };
        } catch (e) {
            // El caller decide si el evento es obligatorio. Los eventos que
            // crean, consumen o revocan capabilities son fail-closed (A09).
            try { console.error(`[delegation-grant] audit '${event}' falló: ${e.message}`); } catch { /* noop */ }
            return rej(REJECT_REASONS.AUDIT_FAILED);
        }
    }

    // -- emisión --------------------------------------------------------------
    /**
     * Emite un grant firmado. Solo `primary` puede emitir. Valida delegate
     * registrado y gateClasses delegables. Audita concesión o rechazo.
     * @returns {{ok:true, grant:object} | {ok:false, reason:string}}
     */
    function issue({ grantor, delegate, gateClasses, ttlMs: ttlOverride, exp } = {}) {
        // 1. Autoridad del grantor (fail-closed: solo primary).
        const can = allowlist.assertCanGrant(grantor);
        if (!can.ok) {
            audit(AUDIT_EVENTS.REJECTED, { phase: 'issue', grantor, delegate, reason: can.reason });
            return rej(can.reason);
        }
        // 2. Delegate debe estar registrado (no se delega a un desconocido).
        if (typeof delegate !== 'string' || !allowlist.getOperator(delegate)) {
            audit(AUDIT_EVENTS.REJECTED, { phase: 'issue', grantor, delegate, reason: REJECT_REASONS.UNKNOWN_DELEGATE });
            return rej(REJECT_REASONS.UNKNOWN_DELEGATE);
        }
        // 3. gateClasses: array no vacío, todas delegables (GATE1/2 excluidas).
        if (!Array.isArray(gateClasses) || gateClasses.length === 0
            || !gateClasses.every(isDelegableGateClass)) {
            audit(AUDIT_EVENTS.REJECTED, { phase: 'issue', grantor, delegate, gateClasses, reason: REJECT_REASONS.NON_DELEGABLE_GATE });
            return rej(REJECT_REASONS.NON_DELEGABLE_GATE);
        }
        // 4. Construir payload público y firmar con la versión activa.
        const effTtl = Number.isFinite(ttlOverride) ? ttlOverride : ttlMs;
        const payload = {
            grantor,
            delegate,
            gateClasses: gateClasses.map(String),
            exp: Number.isFinite(exp) ? exp : now() + effTtl,
            nonce: nonceGen(),
            secretVersion: activeSecretVersion,
        };
        const signature = signPayload(payload, secrets[activeSecretVersion], activeSecretVersion);
        const auditResult = audit(AUDIT_EVENTS.ISSUED, {
            grantor, delegate, gateClasses: payload.gateClasses,
            exp: payload.exp, nonce: payload.nonce, secretVersion: payload.secretVersion,
        });
        if (!auditResult.ok) return auditResult;
        return { ok: true, grant: { payload, signature } };
    }

    // -- validación (sin consumir) -------------------------------------------
    /**
     * Valida un grant sin consumir el nonce. Devuelve causa diferenciada de
     * rechazo. NO audita (el caller decide; `consume` sí audita).
     * @param {object} grant - envelope { payload, signature }.
     * @returns {{ok:true, payload:object} | {ok:false, reason:string}}
     */
    function validate(grant) {
        if (!grant || typeof grant !== 'object') return rej(REJECT_REASONS.MALFORMED);
        const { payload, signature } = grant;
        if (!payload || typeof payload !== 'object' || typeof signature !== 'string' || !signature) {
            return rej(REJECT_REASONS.MALFORMED);
        }
        const { grantor, delegate, gateClasses, exp, nonce, secretVersion } = payload;
        if (typeof grantor !== 'string' || !grantor) return rej(REJECT_REASONS.MALFORMED);
        if (typeof delegate !== 'string' || !delegate) return rej(REJECT_REASONS.MALFORMED);
        if (!Array.isArray(gateClasses) || gateClasses.length === 0) return rej(REJECT_REASONS.MALFORMED);
        if (!Number.isFinite(exp)) return rej(REJECT_REASONS.MALFORMED);
        if (typeof nonce !== 'string' || !nonce) return rej(REJECT_REASONS.MALFORMED);
        if (typeof secretVersion !== 'string' || !secretVersion) return rej(REJECT_REASONS.MALFORMED);

        // Versión de secreto: solo la activa es válida. Rotar la versión activa
        // invalida grants firmados con versiones anteriores (revocación masiva).
        if (secretVersion !== activeSecretVersion) return rej(REJECT_REASONS.VERSION_INVALID);
        const secret = secrets[secretVersion];
        if (!secret) return rej(REJECT_REASONS.VERSION_INVALID);

        // Firma (timing-safe) sobre el payload canonicalizado. Cualquier
        // manipulación del payload rompe la firma → `bad-signature`.
        const expected = signPayload(payload, secret, secretVersion);
        if (!timingSafeEqualHex(signature, expected)) return rej(REJECT_REASONS.BAD_SIGNATURE);

        // Gate classes: defensa redundante contra GATE1/2 y clases no delegables
        // aunque la firma sea válida (p.ej. una futura clase removida del set).
        if (!gateClasses.every(isDelegableGateClass)) return rej(REJECT_REASONS.NON_DELEGABLE_GATE);

        // Grantor debe seguir siendo primary al momento de validar (la allowlist
        // podría haber cambiado desde la emisión).
        const can = allowlist.assertCanGrant(grantor);
        if (!can.ok) return rej(can.reason);

        // Expiración.
        if (exp <= now()) return rej(REJECT_REASONS.EXPIRED);

        // Revocación explícita.
        if (isRevoked(nonce)) return rej(REJECT_REASONS.REVOKED);

        return { ok: true, payload };
    }

    // -- consumo (validar + marcar usado ATÓMICO) ----------------------------
    /**
     * Valida y CONSUME un grant (un solo uso). El check de nonce y el marcado
     * como usado ocurren dentro de un file-lock exclusivo, así dos consumos
     * concurrentes del mismo nonce no pueden ambos ganar (anti-replay por carrera).
     *
     * @param {object} grant
     * @param {object} [ctx]
     * @param {string} [ctx.delegate] - si se pasa, debe coincidir con el delegate del grant.
     * @returns {{ok:true, payload:object} | {ok:false, reason:string}}
     */
    function consume(grant, ctx = {}) {
        const v = validate(grant);
        if (!v.ok) {
            const p = (grant && grant.payload) || {};
            audit(AUDIT_EVENTS.REJECTED, {
                phase: 'consume', grantor: p.grantor, delegate: p.delegate,
                gateClasses: p.gateClasses, nonce: p.nonce, secretVersion: p.secretVersion,
                reason: v.reason,
            });
            return v;
        }
        const { payload } = v;

        // Binding opcional: quién consume debe ser el delegate del grant.
        if (ctx.delegate !== undefined && ctx.delegate !== payload.delegate) {
            audit(AUDIT_EVENTS.REJECTED, {
                phase: 'consume', grantor: payload.grantor, delegate: payload.delegate,
                nonce: payload.nonce, reason: REJECT_REASONS.DELEGATE_MISMATCH,
            });
            return rej(REJECT_REASONS.DELEGATE_MISMATCH);
        }

        // Sección crítica atómica: lock exclusivo sobre el store de nonces,
        // re-chequeo bajo lock y marcado. Reusa el file-lock de audit-log.
        const lock = auditLog._acquireFileLockSync(nonceFile, fs);
        if (!lock.ok) {
            audit(AUDIT_EVENTS.REJECTED, {
                phase: 'consume', grantor: payload.grantor, delegate: payload.delegate,
                nonce: payload.nonce, reason: REJECT_REASONS.LOCK_FAILED,
            });
            return rej(REJECT_REASONS.LOCK_FAILED);
        }
        let outcome;
        try {
            // Re-chequear revocación y consumo DENTRO del lock (evita TOCTOU).
            if (isRevoked(payload.nonce)) {
                outcome = rej(REJECT_REASONS.REVOKED);
            } else if (isConsumed(payload.nonce)) {
                outcome = rej(REJECT_REASONS.REPLAYED);
            } else {
                const auditResult = audit(AUDIT_EVENTS.CONSUMED, {
                    grantor: payload.grantor, delegate: payload.delegate,
                    gateClasses: payload.gateClasses, nonce: payload.nonce, secretVersion: payload.secretVersion,
                });
                if (auditResult.ok) {
                    appendNonce(nonceFile, { n: payload.nonce, delegate: payload.delegate, ts: new Date(now()).toISOString() });
                    outcome = { ok: true, payload };
                } else {
                    outcome = auditResult;
                }
            }
        } finally {
            auditLog._releaseFileLockSync(lock.lockPath, fs);
        }

        if (!outcome.ok && outcome.reason !== REJECT_REASONS.AUDIT_FAILED) {
            audit(AUDIT_EVENTS.REJECTED, {
                phase: 'consume', grantor: payload.grantor, delegate: payload.delegate,
                nonce: payload.nonce, secretVersion: payload.secretVersion, reason: outcome.reason,
            });
        }
        return outcome;
    }

    // -- revocación -----------------------------------------------------------
    /**
     * Revoca un grant activo no usado por su `nonce`. Idempotente. Audita.
     * @param {object} params
     * @param {string} params.nonce - nonce del grant a revocar.
     * @param {string} [params.revokedBy] - operador que revoca.
     * @param {string} [params.reason] - motivo (se redacta al persistir).
     * @returns {{ok:true} | {ok:false, reason:string}}
     */
    function revoke({ nonce, revokedBy, reason } = {}) {
        if (typeof nonce !== 'string' || !nonce) return rej(REJECT_REASONS.MALFORMED);
        const auditResult = audit(AUDIT_EVENTS.REVOKED, { nonce, revokedBy: revokedBy || null, reason: reason || 'revoked' });
        if (!auditResult.ok) return auditResult;
        appendNonce(revocationFile, { n: nonce, by: revokedBy || null, ts: new Date(now()).toISOString() });
        return { ok: true };
    }

    /** Verifica la integridad del audit chain de grants. */
    function verifyAuditChain() {
        return auditLog.verifyChain(auditFile);
    }

    return {
        issue, validate, consume, revoke,
        verifyAuditChain,
        auditFile, nonceFile, revocationFile,
        activeSecretVersion, ttlMs,
    };
}

/** Base de directorios del pipeline (REPO_ROOT/.pipeline) sin depender de cwd. */
function auditLogDirBase() {
    // `audit-log.js` vive en `.pipeline/lib/`; subimos un nivel → `.pipeline/`.
    return path.resolve(__dirname, '..');
}

module.exports = {
    createGrantAuthority,
    // Constantes y helpers públicos.
    DELEGABLE_GATE_CLASSES,
    PERMANENTLY_NON_DELEGABLE_GATE_CLASSES,
    REJECT_REASONS,
    AUDIT_EVENTS,
    DEFAULT_TTL_MS,
    isDelegableGateClass,
    // Exportados para tests del propio mecanismo de firma.
    deriveKey,
    signPayload,
    timingSafeEqualHex,
};
