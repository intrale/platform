'use strict';

// =============================================================================
// #4413 (Parte 3/3 de #4363) — Stickiness por conversación (D3, obligatoria).
//
// El balanceo ponderado del Commander (#4411/#4412) elige provider POR REQUEST.
// Sin stickiness, dos turnos consecutivos de la MISMA conversación pueden caer
// en providers distintos y perder el contexto conversacional. Este módulo
// "pega" un `chat_id_hash` a un provider dentro de una ventana temporal: el
// selector consulta stickiness ANTES de reelegir y reusa el provider pegado
// mientras siga sano y dentro de la ventana.
//
// Reglas de seguridad (heredadas del análisis de security/guru de #4413):
//   - CONFIDENCIALIDAD: se indexa SIEMPRE por `chat_id_hash` (SHA-256 truncado
//     de `hashFor`), NUNCA por `chat_id` crudo. El módulo NO hashea: recibe el
//     hash ya calculado por el caller (`multi-provider.hashFor`). No materializa
//     PII de Telegram.
//   - EFÍMERO / NO AUTORITATIVO: el estado vive en memoria de proceso (Map).
//     No se persiste a disco (nada de secretos ni PII en el filesystem) y se
//     resetea al reiniciar el pulpo. NO es fuente de decisiones de seguridad:
//     la re-elección forzada al gatearse el provider la decide el balancer.
//   - RE-ELECCIÓN FORZADA (D3): la stickiness NO fija a un provider caído. El
//     integrador (`_resolveViaBalancer`) sólo reusa el sticky si sigue en el
//     conjunto de candidatos SANOS del balancer; si se gateó / perdió cuota /
//     ya no soporta tool-use, reelige. Al expirar la ventana o abrir
//     conversación nueva (hash sin entry), también reelige.
//
// Ventana temporal: default 30 min. Configurable vía
// `balancing.stickiness_window_ms` en `agent-models.json`.
// =============================================================================

// Ventana de continuidad conversacional por default (30 min). Un turno dentro
// de este lapso del anterior se considera la misma conversación.
const DEFAULT_WINDOW_MS = 30 * 60 * 1000;

// GC: entradas más viejas que esto se purgan al escribir para que el Map no
// crezca sin techo en un proceso long-running (pulpo).
const GC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Estado in-memory por default. Map<chatIdHash, { provider, ts }>. Efímero:
// muere con el proceso. Los tests inyectan su propio Map por `store` para
// aislarse.
const _memStore = new Map();

// Un `chat_id_hash` de `hashFor` es SHA-256 truncado a 12 hex. Aceptamos un
// rango (8-64 hex) por robustez, pero rechazamos cualquier cosa que no sea
// hex-only para no aceptar accidentalmente un `chat_id` crudo con formato raro.
// NOTA: un chat_id numérico de Telegram (solo dígitos) podría, en teoría, pasar
// el regex — la garantía real de "sólo hash" la da el integrador, que SIEMPRE
// pasa `hashFor(chatId)`. Este guard es defensa en profundidad de formato.
const HASH_RE = /^[0-9a-f]{8,64}$/;

function _isHash(s) {
    return typeof s === 'string' && HASH_RE.test(s);
}

function _resolveStore(store) {
    return store instanceof Map ? store : _memStore;
}

function _now(now) {
    return Number.isFinite(now) ? now : Date.now();
}

function _windowMs(windowMs) {
    return Number.isFinite(windowMs) && windowMs > 0 ? windowMs : DEFAULT_WINDOW_MS;
}

/**
 * Devuelve el provider pegado a `chatIdHash` si sigue dentro de la ventana, o
 * `null` si no hay entry, la entry expiró o el hash es inválido. Una entry
 * expirada se elimina de paso (lazy expiry).
 *
 * @param {object} params
 * @param {string} params.chatIdHash  hash del chat (de `hashFor`). NUNCA crudo.
 * @param {number} [params.now]       epoch ms (inyectable en tests).
 * @param {number} [params.windowMs]  ventana temporal; default 30 min.
 * @param {Map}    [params.store]     store inyectable (tests). Default in-memory.
 * @returns {string|null}
 */
function getStickyProvider({ chatIdHash, now, windowMs, store } = {}) {
    if (!_isHash(chatIdHash)) return null;
    const m = _resolveStore(store);
    const rec = m.get(chatIdHash);
    if (!rec || typeof rec.provider !== 'string' || !rec.provider) return null;
    if (!Number.isFinite(rec.ts)) { m.delete(chatIdHash); return null; }
    const ts = _now(now);
    if (ts - rec.ts >= _windowMs(windowMs)) {
        m.delete(chatIdHash); // ventana expirada → reelección en el próximo turno
        return null;
    }
    return rec.provider;
}

/**
 * Pega `provider` a `chatIdHash` con timestamp `now`. Renueva la ventana en
 * cada set (sliding window: mientras la conversación siga activa, se mantiene).
 * Ignora silenciosamente hashes/providers inválidos (best-effort, nunca rompe
 * el dispatch).
 *
 * @returns {boolean} true si se guardó.
 */
function setStickyProvider({ chatIdHash, provider, now, store } = {}) {
    if (!_isHash(chatIdHash)) return false;
    if (typeof provider !== 'string' || !provider) return false;
    const m = _resolveStore(store);
    const ts = _now(now);
    m.set(chatIdHash, { provider, ts });
    _gc(m, ts);
    return true;
}

/**
 * Borra la entry de una conversación (p.ej. al cerrar/expirar explícitamente).
 * Best-effort.
 */
function clearStickyProvider({ chatIdHash, store } = {}) {
    if (!_isHash(chatIdHash)) return false;
    return _resolveStore(store).delete(chatIdHash);
}

// Purga entradas viejas para acotar el Map. O(n) sobre el store — el volumen
// de conversaciones concurrentes del Commander es chico, así que es barato.
function _gc(m, now) {
    for (const [k, v] of m) {
        if (!v || !Number.isFinite(v.ts) || now - v.ts > GC_MAX_AGE_MS) {
            m.delete(k);
        }
    }
}

// Reset del store default. Solo para tests (aislar entre casos).
function _resetState(store) {
    _resolveStore(store).clear();
}

module.exports = {
    getStickyProvider,
    setStickyProvider,
    clearStickyProvider,
    DEFAULT_WINDOW_MS,
    // Internos expuestos para tests (patrón provider-balancer.js / credentials-precheck.js).
    _isHash,
    _resetState,
    _memStore,
};
