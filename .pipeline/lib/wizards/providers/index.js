// =============================================================================
// wizards/providers/index.js — Flow "Configurar / rotar / desactivar provider"
// (#3740, split de #3715 / paraguas #3669).
//
// Wizard de 4 pasos de UI (0-indexados como 0..3 según la base #3724) para la
// operación sensible de ver metadata / rotar / desactivar la API key de un
// provider IA desde el Dashboard V3 — conservando la política
// `feedback_api-keys-terminal-only`: el wizard NO crea keys nuevas, sólo opera
// sobre las ya existentes en `~/.claude/secrets/credentials.json`. El set inicial
// de una key nueva se hace por terminal Windows.
//
// CONTRATO REAL (#3724): la base (`wizard-session.js`) resuelve CSRF (HttpOnly +
// HMAC), Origin/Sec-Fetch allowlist, rate-limit, idempotencia por (session,step),
// timeout 15min y el audit NDJSON de CADA step (con `redact` sobre params). Este
// flow aporta SOLO `{maxStep, validateStep, executeStep}` — NO maneja req/res ni
// tokens. (La receta del architect asumía `registerRoutes(router)` con endpoints
// GET/POST propios; la base mergeada por #3724 los hizo innecesarios, igual que
// en los wizards `pausa` y `descanso`.)
//
// Pasos (0-indexados, mapeados a los 4 pasos de UI del mockup #3737):
//   0 — seleccionar provider.                                   (UI "Paso 1")
//   1 — elegir acción: metadata | rotate | deactivate.          (UI "Paso 2")
//   2 — (rotate) ingresar key → validar regex + preview masked. (UI "Paso 3")
//        (metadata/deactivate) preview sin input.
//   3 — confirmación + apply (file-lock + audit-then-clear).    (UI "Paso 4")
//
// INVARIANTES de seguridad:
//   - La key cruda NUNCA viaja en el `result` devuelto (ni en replays
//     idempotentes): se guarda fuera de `session.steps`, en `session._draftKey`,
//     y se borra tras el apply.
//   - `last4_old` se lee SIEMPRE del disco bajo lock — nunca de `process.env`,
//     que puede estar stale tras rotaciones previas en la misma sesión.
//   - `provider` se valida contra la allowlist derivada de `ENV_MAPPING` (defensa
//     path-traversal / prototype-pollution); `setNested` bloquea segmentos
//     `__proto__|constructor|prototype`.
//   - El audit (last4_old/last4_new) se appendea DESPUÉS del write exitoso, en el
//     MISMO `withLock`. Si la escritura falla, no hay entry fantasma.
//
// Sin deps npm — sólo módulos del pipeline.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const credentials = require('../../credentials');
const fileLock = require('../../file-lock');
const auditLog = require('../../audit-log');
const validator = require('../../providers-key-validator');

const { validateProviderKey, last4Of, maskKey } = validator;

// --- Constantes --------------------------------------------------------------
const FLOW = 'providers';
const MAX_STEP = 3;
const VIA = 'wizard-providers';
const ACTIONS = Object.freeze(['metadata', 'rotate', 'deactivate']);
const LOCK_TIMEOUT_MS = 8000;
const LOCK_MAX_RETRIES = 160;     // ~8s a 50ms/retry.

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

// =============================================================================
// Listado de providers — fuente única `ENV_MAPPING` (sin hardcoding). CA-1.
// =============================================================================

/**
 * Deriva la lista de providers IA configurables desde `ENV_MAPPING`.
 * Filtra los dot-path `providers.*.api_key`. `name` es el 2do segmento.
 * @returns {Array<{name:string, dotPath:string, envVar:string}>}
 */
function listProviders() {
    return Object.entries(credentials.ENV_MAPPING)
        .filter(([dotPath]) => dotPath.startsWith('providers.') && dotPath.endsWith('.api_key'))
        .map(([dotPath, envVar]) => ({
            name: dotPath.split('.')[1],
            dotPath,
            envVar,
        }));
}

/**
 * Lookup del provider por nombre contra la allowlist (defensa path-traversal).
 * Devuelve `null` si no matchea exactamente un nombre conocido.
 * @param {*} name
 * @returns {{name:string, dotPath:string, envVar:string}|null}
 */
function findProvider(name) {
    if (typeof name !== 'string') return null;
    return listProviders().find((p) => p.name === name) || null;
}

// =============================================================================
// Helpers de nested JSON con defensa prototype-pollution
// =============================================================================

/**
 * Setea un valor en un dot-path, bloqueando segmentos peligrosos.
 * @param {object} obj
 * @param {string} dotPath
 * @param {*} value
 */
function setNested(obj, dotPath, value) {
    const segs = dotPath.split('.');
    let cursor = obj;
    for (let i = 0; i < segs.length - 1; i++) {
        const s = segs[i];
        if (FORBIDDEN_SEGMENTS.has(s)) {
            throw new Error('setNested: segmento prohibido');
        }
        if (typeof cursor[s] !== 'object' || cursor[s] === null) cursor[s] = {};
        cursor = cursor[s];
    }
    const leaf = segs[segs.length - 1];
    if (FORBIDDEN_SEGMENTS.has(leaf)) {
        throw new Error('setNested: segmento prohibido');
    }
    cursor[leaf] = value;
}

// =============================================================================
// createFlow — factory inyectable (tests pasan credentialsPath / auditDir / now)
// =============================================================================

/**
 * @param {object} [opts]
 * @param {string} [opts.credentialsPath] — override del JSON de credenciales.
 * @param {string} [opts.auditDir] — override del directorio de audit del wizard.
 * @param {function} [opts.now] — clock inyectable (default Date.now).
 * @param {object} [opts.fileLockImpl] — override de file-lock (tests).
 * @param {object} [opts.auditImpl] — override de audit-log (tests).
 * @returns {{maxStep:number, validateStep:Function, executeStep:Function}}
 */
function createFlow(opts = {}) {
    const credentialsPath = opts.credentialsPath || credentials.CANONICAL_PATH;
    const auditDir = opts.auditDir || path.join(__dirname, '..', '..', '..', 'logs');
    const now = typeof opts.now === 'function' ? opts.now : Date.now;
    const lockImpl = opts.fileLockImpl || fileLock;
    const auditImpl = opts.auditImpl || auditLog;
    const actor = opts.actor || `operator-local:${process.pid}`;

    const auditFile = path.join(auditDir, 'wizard-providers-audit.ndjson');

    // --- Lectura de credenciales (defensiva) ---------------------------------
    function readCredentials() {
        try {
            const raw = fs.readFileSync(credentialsPath, 'utf8');
            const data = JSON.parse(raw);
            return (data && typeof data === 'object') ? data : {};
        } catch {
            // Archivo ausente o JSON inválido → tratamos como "sin credenciales".
            return {};
        }
    }

    /** last4 actual de un provider leyendo del disco (nunca de process.env). */
    function currentLast4(data, dotPath) {
        return last4Of(credentials.getNested(data, dotPath));
    }

    // --- validateStep --------------------------------------------------------
    function validateStep(step, params) {
        const p = params || {};
        const provider = findProvider(p.provider);
        switch (step) {
            case 0:
                return provider != null;
            case 1:
                return provider != null && ACTIONS.includes(p.action);
            case 2: {
                if (provider == null || !ACTIONS.includes(p.action)) return false;
                if (p.action === 'rotate') {
                    return validateProviderKey(provider.name, p.api_key).ok === true;
                }
                return true;
            }
            case 3:
                return provider != null && ACTIONS.includes(p.action) && p.confirm === true;
            default:
                return false;
        }
    }

    // --- executeStep ---------------------------------------------------------
    async function executeStep(session, step, params) {
        const p = params || {};
        const provider = findProvider(p.provider);
        if (!provider) throw new Error('precondition: provider inválido');

        switch (step) {
            case 0: {
                const data = readCredentials();
                const l4 = currentLast4(data, provider.dotPath);
                return {
                    provider: provider.name,
                    configured: l4 != null,
                    masked: maskKey(l4),                // null si no hay key.
                    providers: listProviders().map((pr) => pr.name),
                };
            }

            case 1: {
                return { provider: provider.name, action: p.action };
            }

            case 2: {
                const data = readCredentials();
                const last4Old = currentLast4(data, provider.dotPath);
                if (p.action === 'rotate') {
                    const v = validateProviderKey(provider.name, p.api_key);
                    if (!v.ok) throw new Error('precondition: key inválida');
                    // La key cruda se guarda FUERA de session.steps (no se cachea
                    // ni se devuelve en replays). Se borra tras el apply.
                    session._draftKey = p.api_key;
                    return {
                        provider: provider.name,
                        action: 'rotate',
                        masked_old: maskKey(last4Old),
                        masked_new: maskKey(v.last4),
                    };
                }
                if (p.action === 'deactivate') {
                    return {
                        provider: provider.name,
                        action: 'deactivate',
                        masked_old: maskKey(last4Old),
                        masked_new: null,
                    };
                }
                // metadata
                return {
                    provider: provider.name,
                    action: 'metadata',
                    masked_old: maskKey(last4Old),
                    configured: last4Old != null,
                };
            }

            case 3: {
                const action = p.action;
                // metadata no muta nada (CA-13): sólo devuelve el estado.
                if (action === 'metadata') {
                    const data = readCredentials();
                    const l4 = currentLast4(data, provider.dotPath);
                    return {
                        ok: true,
                        action: 'metadata',
                        provider: provider.name,
                        masked: maskKey(l4),
                        configured: l4 != null,
                    };
                }

                const draftKey = session._draftKey;
                if (action === 'rotate') {
                    // Revalidación defensiva server-side de la key guardada.
                    if (!validateProviderKey(provider.name, draftKey).ok) {
                        throw new Error('precondition: falta key válida del paso 2');
                    }
                }

                let result;
                await lockImpl.withLock(credentialsPath, async () => {
                    const data = readCredentials();
                    const last4Old = currentLast4(data, provider.dotPath);
                    let last4New = null;

                    if (action === 'rotate') {
                        setNested(data, provider.dotPath, draftKey);
                        last4New = draftKey.slice(-4);
                    } else { // deactivate
                        setNested(data, provider.dotPath, null);
                        last4New = null;
                    }

                    // Escritura completa del JSON (preserva campos no-provider).
                    // `JSON.stringify(...,2)` produce LF; 'utf8' explícito evita BOM.
                    fs.writeFileSync(credentialsPath, JSON.stringify(data, null, 2), 'utf8');

                    // Audit DESPUÉS del write exitoso (sin entry fantasma). Sólo
                    // last4 — nunca la key cruda ni el campo api_key.
                    auditImpl.appendChained({
                        file: auditFile,
                        entry: {
                            ts: new Date(now()).toISOString(),
                            actor,
                            via: VIA,
                            wizard_flow: FLOW,
                            action: action === 'rotate' ? 'rotate_provider' : 'deactivate_provider',
                            provider: provider.name,
                            last4_old: last4Old,
                            last4_new: last4New,
                            outcome: 'success',
                        },
                    });

                    result = {
                        ok: true,
                        action,
                        provider: provider.name,
                        masked_old: maskKey(last4Old),
                        masked_new: maskKey(last4New),
                        applied: action === 'rotate' ? 'rotated' : 'deactivated',
                    };
                }, { timeoutMs: LOCK_TIMEOUT_MS, maxRetries: LOCK_MAX_RETRIES, component: 'wizard-providers' });

                // Borrado de la key draft (best-effort) tras el apply.
                try { delete session._draftKey; } catch { /* noop */ }

                return result;
            }

            default:
                throw new Error('step fuera de rango');
        }
    }

    return Object.freeze({ maxStep: MAX_STEP, validateStep, executeStep, auditFile });
}

// =============================================================================
// Registro en la base (#3724). Best-effort: no rompe el boot si falla.
// =============================================================================

/**
 * @param {object} [ws] — módulo wizard-session (inyectable en tests).
 * @param {object} [flowOpts] — opciones para createFlow.
 * @returns {boolean} true si registró.
 */
function register(ws, flowOpts) {
    let mod = ws;
    if (!mod) {
        try { mod = require('../../wizard-session'); } catch { return false; }
    }
    try {
        mod.registerFlow(FLOW, createFlow(flowOpts || {}));
        return true;
    } catch {
        return false;
    }
}

module.exports = {
    FLOW,
    MAX_STEP,
    VIA,
    ACTIONS,
    createFlow,
    register,
    listProviders,
    findProvider,
    setNested,
};
