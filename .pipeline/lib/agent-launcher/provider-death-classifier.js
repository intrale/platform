// =============================================================================
// agent-launcher/provider-death-classifier.js — Clasificación de muerte prematura
// de agente: causa PROVIDER (infra) vs causa AGENTE (crash del código). Issue #4648.
//
// PROBLEMA QUE RESUELVE
// ---------------------
// El handler de muerte prematura del Pulpo (`pulpo.js`, bloque
// `if (code !== 0 && elapsedSec < 15)`) contaba CUALQUIER muerte temprana con
// `code≠0` sin veredicto como fallo del ISSUE, aplicando `registerFastFail` +
// cooldown de hasta 60min al `(skill,issue)`.
//
// Durante la ventana de inactividad de Anthropic, el primary queda gateado y el
// resolver cae a un fallback (ej. `gemini-google`). Si ese fallback "resuelve
// como viable" pero muere al spawn en 4-5s (`code=1`), la causa NO es el issue:
// es INDISPONIBILIDAD del provider. Penalizar al issue lo congela ~1h por algo
// que fue culpa del entorno de providers.
//
// PRINCIPIO RECTOR: una muerte por provider no disponible NUNCA debe penalizar
// al issue. El cooldown por muerte-de-provider va al PROVIDER, no al (skill,issue).
//
// HEURÍSTICA (guru risk#2: basarla en el ESTADO DEL RESOLVER al momento del
// spawn, no sólo en `elapsedSec`):
//   - `source === 'fallback'` ⇒ el primary estaba gateado y el resolver cayó a
//     un fallback. Una muerte inmediata (`code≠0`, `elapsedSec < threshold`) en
//     ese estado degradado es atribuible a la fragilidad de la cadena de
//     providers, no al código del agente ⇒ 'provider-death'.
//   - `source === 'primary'` (o ausente) ⇒ el agente corrió con su provider
//     configurado y disponible. Una muerte temprana es un crash REAL del agente
//     ⇒ 'agent-death' (comportamiento actual preservado — CA-5 del issue).
//
// La clasificación es una función PURA (sin IO, sin estado): recibe las señales
// ya observadas por el caller y devuelve el veredicto. Testeable en aislamiento.
//
// #6238 — TERCERA CAUSA: 'credential-death'
// -----------------------------------------
// La heurística por `source` no alcanza cuando la credencial del provider está
// vencida: el spawn sale por el PRIMARY (source='primary'), el CLI rechaza la
// sesión y el proceso muere en 2s. Eso caía en 'agent-death' ⇒ fast-fail +
// cooldown al `(skill,issue)` ⇒ reintento cada 15 min contra la misma
// credencial muerta, sin salida. Ahora el caller puede pasar `logTail` (la cola
// del log stream-json que YA leyó) y `credential-death-detector` busca la firma
// ESTRUCTURAL top-level del frame del CLI. Esa causa PRECEDE a provider-death y
// a agent-death: una credencial vencida es credencial vencida haya salido por
// primary o por fallback.
//
// La función sigue siendo PURA: el único require nuevo es al detector (mismo
// directorio, también puro y sin IO). El caller le pasa el texto ya leído.
//
// Sin dependencias externas (Node puro).
// =============================================================================
'use strict';

// #6238 — detector estructural de credencial rechazada. Puro, sin IO. Se carga
// defensivamente: si por algún motivo no está disponible, la clasificación cae
// al comportamiento pre-#6238 (fail-closed, nunca 'credential-death' gratis).
let credentialDeathDetector = null;
try {
    credentialDeathDetector = require('./credential-death-detector');
} catch { /* opcional: fail-closed al comportamiento anterior */ }

// Umbral de "muerte prematura" en segundos (paridad con el bloque del Pulpo).
const DEFAULT_PREMATURE_SEC = 15;

/**
 * classifyPrematureDeath — clasifica la causa de una muerte de agente.
 *
 * @param {object} opts
 * @param {number} opts.code            exit code del proceso hijo.
 * @param {number} opts.elapsedSec      segundos de vida del agente.
 * @param {boolean} [opts.hasVerdict]   el agente escribió un YAML con
 *        `resultado: aprobado|rechazado` (terminación legítima, no muerte).
 * @param {string} [opts.source]        origen de la resolución de provider:
 *        'primary' | 'fallback' | 'dispatch-fallback' | 'all-gated' | null.
 * @param {string} [opts.provider]      provider EFECTIVO con el que se spawneó.
 * @param {number} [opts.prematureSec]  umbral de muerte prematura (default 15s).
 * @param {string} [opts.logTail]       #6238 — cola del log stream-json del
 *        agente, YA leída por el caller (la función no hace IO). Opcional: si
 *        falta, la clasificación es idéntica a la pre-#6238.
 * @param {object} [opts.detector]      inyectable en tests (credential-death-detector).
 * @returns {{ kind: 'normal'|'credential-death'|'provider-death'|'agent-death',
 *             reason: string, token?: string, signature?: string }}
 *   - 'normal'           → no es muerte prematura (éxito, veredicto, o vivió ≥ umbral).
 *   - 'credential-death' → #6238: el CLI rechazó la credencial/sesión del
 *                          provider (firma estructural en `logTail`). NO
 *                          penalizar al issue; apagar el provider con TTL.
 *                          PRECEDE a provider-death y agent-death.
 *   - 'provider-death'   → muerte prematura atribuible a infra de providers (NO
 *                          penalizar al issue; backoff al provider).
 *   - 'agent-death'      → muerte prematura por crash real del agente (penalizar
 *                          con fast-fail + cooldown, comportamiento preservado).
 */
function classifyPrematureDeath(opts = {}) {
    const {
        code,
        elapsedSec,
        hasVerdict = false,
        source = null,
        provider = null,
        logTail = null,
    } = opts;
    const prematureSec = Number.isFinite(opts.prematureSec) && opts.prematureSec > 0
        ? opts.prematureSec
        : DEFAULT_PREMATURE_SEC;

    // Terminación legítima con veredicto (#2524): no es muerte prematura.
    if (hasVerdict) return { kind: 'normal', reason: 'verdict' };

    // No cumple el patrón de muerte prematura (exit 0, o vivió el umbral).
    if (!(code !== 0 && Number.isFinite(elapsedSec) && elapsedSec < prematureSec)) {
        return { kind: 'normal', reason: 'not_premature' };
    }

    // #6238 — CREDENCIAL RECHAZADA: precede a provider-death y agent-death.
    // Una credencial vencida es credencial vencida haya salido por primary o
    // por fallback (CA-1), y no se arregla reintentando.
    //
    // Fail-closed (CA-7): si el detector no está, no matchea o TIRA, seguimos
    // con el flujo pre-#6238. Nunca 'credential-death' por defecto.
    const detector = opts.detector || credentialDeathDetector;
    if (detector && typeof detector.detectCredentialDeath === 'function') {
        try {
            const cred = detector.detectCredentialDeath(logTail);
            if (cred && cred.matched === true) {
                return {
                    kind: 'credential-death',
                    reason: `credential_rejected:${cred.token}`,
                    token: cred.token,
                    signature: cred.signature,
                };
            }
        } catch { /* fail-closed: sigue el flujo actual */ }
    }

    // El fallback nunca es 'deterministic' (skill Node puro sin tokens): si por
    // algún camino el provider efectivo fuese deterministic, tratamos como crash
    // del agente (su muerte no es indisponibilidad de un provider LLM externo).
    const spawnedViaFallback = source === 'fallback' || source === 'dispatch-fallback';
    const providerAttributable = spawnedViaFallback
        && typeof provider === 'string'
        && provider.length > 0
        && provider !== 'deterministic';

    if (providerAttributable) {
        return {
            kind: 'provider-death',
            reason: `fallback_spawn_death:${provider}`,
        };
    }

    return { kind: 'agent-death', reason: 'primary_or_unknown_crash' };
}

module.exports = {
    classifyPrematureDeath,
    DEFAULT_PREMATURE_SEC,
};
