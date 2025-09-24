package ui.util

import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull

class ResStringsTest {

    @Test
    fun `resolveOrFallback returns resolved value when resolver succeeds`() = runTest {
        var failureInvoked = false

        val result = resolveOrFallback(
            resolver = { "Texto traducido" },
            fallback = "Texto alternativo"
        ) { failureInvoked = true }

        assertEquals("Texto traducido", result)
        assertFalse(failureInvoked)
    }

    @Test
    fun `resolveOrFallback returns fallback and notifies failure`() = runTest {
        var capturedError: Throwable? = null

        val result = resolveOrFallback(
            resolver = { error("Resolver falló") },
            fallback = "Texto alternativo"
        ) { failure -> capturedError = failure }

        assertEquals("Texto alternativo", result)
        assertNotNull(capturedError)
        assertEquals("Resolver falló", capturedError?.message)
    }
}
