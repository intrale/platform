// =============================================================================
// rate-limit.js — Token bucket por chat_id para la pista determinística
// Issue #3257 · CA-11
//
// Modelo: un bucket por chat_id, capacidad N, refill lineal a rate R por minuto.
// Defaults: 30 req/min, burst 10. Configurables vía opciones del factory.
//
// El rate limit aplica SOLO a la pista determinística — los comandos LLM tienen
// su propio gate de cuota (`quotaNotifier`). El objetivo es proteger al pipeline
// de loops accidentales (script roto que dispara `/status` en cadena) y de
// abuse por parte de un agente que pierda el control.
//
// API:
//   const rl = createRateLimiter({ ratePerMin, burst });
//   const decision = rl.consume(chatId);   → { allowed, retryAfterMs, tokensLeft, recentRequests }
//   rl.recordBlocked(chatId, command);     → para enriquecer la respuesta plantilla
//   rl.getRecentBlocked(chatId);           → últimos comandos bloqueados (para template)
// =============================================================================
'use strict';

function createRateLimiter(opts) {
    const options = opts || {};
    const burst = Number.isFinite(options.burst) ? options.burst : 10;
    const ratePerMin = Number.isFinite(options.ratePerMin) ? options.ratePerMin : 30;
    const now = typeof options.now === 'function' ? options.now : () => Date.now();

    if (burst <= 0 || ratePerMin <= 0) {
        throw new Error('rate-limit: burst y ratePerMin deben ser > 0');
    }

    const refillPerMs = ratePerMin / 60000;   // tokens generados por ms
    const buckets = new Map();                // chatId → { tokens, lastRefillAt }
    const blocked = new Map();                // chatId → [ {command, ts} ]
    const recent = new Map();                 // chatId → [ts] últimas requests en 60s

    function getBucket(chatId) {
        if (!buckets.has(chatId)) {
            buckets.set(chatId, { tokens: burst, lastRefillAt: now() });
        }
        return buckets.get(chatId);
    }

    function refill(bucket) {
        const t = now();
        const elapsed = t - bucket.lastRefillAt;
        if (elapsed <= 0) return;
        const earned = elapsed * refillPerMs;
        bucket.tokens = Math.min(burst, bucket.tokens + earned);
        bucket.lastRefillAt = t;
    }

    function trackRequest(chatId) {
        const t = now();
        const cutoff = t - 60000;
        const arr = recent.get(chatId) || [];
        const trimmed = arr.filter((ts) => ts >= cutoff);
        trimmed.push(t);
        recent.set(chatId, trimmed);
        return trimmed.length;
    }

    /**
     * Intenta consumir 1 token del bucket del chat. Devuelve la decisión.
     * @param {string|number} chatId
     */
    function consume(chatId) {
        const key = String(chatId);
        const bucket = getBucket(key);
        refill(bucket);
        const recentCount = trackRequest(key);
        if (bucket.tokens >= 1) {
            bucket.tokens -= 1;
            return {
                allowed: true,
                tokensLeft: Math.floor(bucket.tokens),
                recentRequests: recentCount,
                retryAfterMs: 0,
            };
        }
        // No alcanza para 1 token — calcular cuánto falta.
        const missing = 1 - bucket.tokens;
        const retryAfterMs = Math.ceil(missing / refillPerMs);
        return {
            allowed: false,
            tokensLeft: 0,
            recentRequests: recentCount,
            retryAfterMs,
        };
    }

    function recordBlocked(chatId, command) {
        const key = String(chatId);
        const arr = blocked.get(key) || [];
        arr.push({ command: String(command || '').slice(0, 60), ts: now() });
        // Mantener solo los últimos 5.
        if (arr.length > 5) arr.splice(0, arr.length - 5);
        blocked.set(key, arr);
    }

    function getRecentBlocked(chatId) {
        return (blocked.get(String(chatId)) || []).slice();
    }

    function reset(chatId) {
        if (chatId === undefined) {
            buckets.clear();
            blocked.clear();
            recent.clear();
        } else {
            const key = String(chatId);
            buckets.delete(key);
            blocked.delete(key);
            recent.delete(key);
        }
    }

    return {
        consume,
        recordBlocked,
        getRecentBlocked,
        reset,
        // metadata para introspección/tests
        _config: { burst, ratePerMin },
    };
}

module.exports = { createRateLimiter };
