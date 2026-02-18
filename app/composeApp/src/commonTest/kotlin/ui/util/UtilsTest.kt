package ui.util

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull

class UtilsTest {

    // ── PriceFormatter ──────────────────────────────────────────────

    @Test
    fun `formatPrice formatea precio sin unidad`() {
        val result = formatPrice(12.50)
        assertEquals("$12.50", result)
    }

    @Test
    fun `formatPrice formatea precio con unidad`() {
        val result = formatPrice(9.99, "kg")
        assertEquals("$9.99 / kg", result)
    }

    @Test
    fun `formatPrice maneja precio entero sin decimales`() {
        val result = formatPrice(100.0)
        assertEquals("$100.00", result)
    }

    @Test
    fun `formatPrice maneja precio con un decimal`() {
        val result = formatPrice(5.5)
        assertEquals("$5.50", result)
    }

    // ── ResStrings - fb ─────────────────────────────────────────────

    @Test
    fun `fb retorna string ASCII sin cambios`() {
        val input = "Hello World 123"
        assertEquals(input, fb(input))
    }

    // ── ResStrings - sanitizeForLog ─────────────────────────────────

    @Test
    fun `sanitizeForLog remueve prefijo de error`() {
        val input = RES_ERROR_PREFIX + "Texto limpio"
        val result = input.sanitizeForLog()
        assertEquals("Texto limpio", result)
    }

    @Test
    fun `sanitizeForLog remueve caracteres no imprimibles`() {
        val input = "Hola\u0001Mundo\u0002"
        val result = input.sanitizeForLog()
        assertEquals("HolaMundo", result)
    }

    // ── ResStrings - resolveOrFallback ──────────────────────────────

    @Test
    fun `resolveOrFallback retorna valor resuelto cuando exitoso`() {
        var failureInvoked = false

        val result = resolveOrFallback(
            identifier = "composeId=test",
            resolver = { "Valor resuelto" },
            fallback = RES_ERROR_PREFIX + fb("Fallback"),
        ) { failureInvoked = true }

        assertEquals("Valor resuelto", result)
        assertFalse(failureInvoked)
    }

    @Test
    fun `resolveOrFallback retorna fallback cuando falla`() {
        var capturedError: Throwable? = null

        val fallback = RES_ERROR_PREFIX + fb("Texto alternativo")
        val result = resolveOrFallback(
            identifier = "composeId=test",
            resolver = { error("Error forzado") },
            fallback = fallback,
        ) { failure -> capturedError = failure }

        assertEquals(fallback, result)
        assertNotNull(capturedError)
        assertEquals("Error forzado", capturedError?.message)
    }
}
