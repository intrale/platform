package ui.util

import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

class SafeResourceTest {

    @Test
    fun `safeString expone mensaje de deprecacion hacia resStringOr`() {
        assertEquals(
            "Usar resStringOr(...) con fallback explícito",
            SAFE_STRING_DEPRECATION_MESSAGE
        )
    }

    @Test
    fun `resolveOrFallback no altera cadenas similares a codificaciones`() = runTest {
        val payload = "RGFzaGJvYXJk"

        val result = resolveOrFallback(
            resolver = { payload },
            fallback = "fallback"
        ) { error ->
            throw AssertionError("No se esperaba fallo", error)
        }

        assertEquals(payload, result)
    }
}
