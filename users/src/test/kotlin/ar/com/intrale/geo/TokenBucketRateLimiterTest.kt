package ar.com.intrale.geo

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TokenBucketRateLimiterTest {

    @Test
    fun `permite las primeras N requests donde N es la capacidad`() {
        val limiter = TokenBucketRateLimiter(capacity = 5, refillPerSecond = 0.0, clock = { 0L })
        repeat(5) {
            assertTrue(limiter.tryAcquire("ip1"), "se esperaba permitir request $it")
        }
        assertFalse(limiter.tryAcquire("ip1"), "la 6ta debe ser rechazada")
    }

    @Test
    fun `15 requests con capacidad 10 producen 5 rechazos`() {
        val limiter = TokenBucketRateLimiter(capacity = 10, refillPerSecond = 0.0, clock = { 0L })
        var allowed = 0
        var rejected = 0
        repeat(15) {
            if (limiter.tryAcquire("ip1")) allowed++ else rejected++
        }
        assertTrue(allowed == 10, "permitidos esperados=10, actuales=$allowed")
        assertTrue(rejected == 5, "rechazados esperados=5, actuales=$rejected")
    }

    @Test
    fun `clave distinta tiene su propio bucket`() {
        val limiter = TokenBucketRateLimiter(capacity = 1, refillPerSecond = 0.0, clock = { 0L })
        assertTrue(limiter.tryAcquire("ip1"))
        assertFalse(limiter.tryAcquire("ip1"))
        // Otra IP debe arrancar con su capacidad llena
        assertTrue(limiter.tryAcquire("ip2"))
    }

    @Test
    fun `el refill por segundo recarga el bucket en el tiempo`() {
        var nanos = 0L
        val limiter = TokenBucketRateLimiter(capacity = 2, refillPerSecond = 10.0, clock = { nanos })
        assertTrue(limiter.tryAcquire("ip1"))
        assertTrue(limiter.tryAcquire("ip1"))
        assertFalse(limiter.tryAcquire("ip1"))
        // Avanzamos 200ms → deberia haber 2 tokens nuevos
        nanos += 200_000_000L
        assertTrue(limiter.tryAcquire("ip1"))
        assertTrue(limiter.tryAcquire("ip1"))
        assertFalse(limiter.tryAcquire("ip1"))
    }
}
