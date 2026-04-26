package ar.com.intrale.geo

import java.util.concurrent.ConcurrentHashMap

/**
 * Rate limiter token-bucket en memoria, keyed por IP.
 *
 * IMPORTANTE: en AWS Lambda cada cold start resetea el estado. Esto es un
 * guardrail de codigo (mitigacion parcial); en produccion se complementa con
 * API Gateway throttling — ver `docs/arquitectura-backend.md` (historia
 * separada para infra).
 *
 * Algoritmo: token bucket clasico con `capacity` tokens y refill a razon de
 * `refillPerSecond` por segundo. Cada request consume 1 token; si no hay
 * tokens disponibles, devuelve `false`.
 */
class TokenBucketRateLimiter(
    private val capacity: Int,
    private val refillPerSecond: Double,
    private val clock: () -> Long = { System.nanoTime() },
) {

    private data class Bucket(
        var tokens: Double,
        var lastRefillNanos: Long,
    )

    private val buckets = ConcurrentHashMap<String, Bucket>()

    /**
     * Intenta consumir 1 token para la `key` (IP). Retorna `true` si fue
     * permitido, `false` si se excedio el limite.
     */
    fun tryAcquire(key: String): Boolean {
        val now = clock()
        var allowed = false
        buckets.compute(key) { _, existing ->
            val bucket = existing ?: Bucket(tokens = capacity.toDouble(), lastRefillNanos = now)
            if (existing != null) refill(bucket, now)
            if (bucket.tokens >= 1.0) {
                bucket.tokens -= 1.0
                allowed = true
            } else {
                allowed = false
            }
            bucket
        }
        return allowed
    }

    private fun refill(bucket: Bucket, now: Long) {
        val elapsedSeconds = (now - bucket.lastRefillNanos) / 1_000_000_000.0
        if (elapsedSeconds <= 0) return
        bucket.tokens = (bucket.tokens + elapsedSeconds * refillPerSecond)
            .coerceAtMost(capacity.toDouble())
        bucket.lastRefillNanos = now
    }

    /** Solo para tests. */
    fun reset() {
        buckets.clear()
    }
}
