package ui.util

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull

class ResStringsTest {

    @Test
    fun `resolveOrFallback returns resolved value when resolver succeeds`() {
        var failureInvoked = false

        val result = resolveOrFallback(
            identifier = "composeId=test",
            resolver = { "Texto traducido" },
            fallback = RES_ERROR_PREFIX + fb("Texto alternativo"),
        ) { failureInvoked = true }

        assertEquals("Texto traducido", result)
        assertFalse(failureInvoked)
    }

    /*@Test
    fun `resolveOrFallback returns fallback and notifies failure`() {
        var capturedError: Throwable? = null

        val fallback = RES_ERROR_PREFIX + fb("Texto alternativo")
        val result = resolveOrFallback(
            identifier = "composeId=test",
            resolver = { error("Resolver falló") },
            fallback = fallback,
        ) { failure -> capturedError = failure }

        assertEquals(fallback, result)
        assertNotNull(capturedError)
        assertEquals("Resolver falló", capturedError?.message)
    }*/

    @Test
    fun `sanitizeForLog elimina prefijo y caracteres fuera de ASCII`() {
        val sanitized = (RES_ERROR_PREFIX + "Autenticación ⚙").sanitizeForLog()

        assertEquals("Autenticacin", sanitized)
    }
}
