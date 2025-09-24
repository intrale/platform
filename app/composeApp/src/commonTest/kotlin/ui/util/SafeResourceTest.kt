package ui.util

import kotlin.test.Test
import kotlin.test.assertEquals

class SafeResourceTest {

    @Test
    fun `safeString expone mensaje de deprecacion hacia resString`() {
        assertEquals(
            "Usar resString(...) con fb(\"...\") para fallbacks ASCII-safe",
            SAFE_STRING_DEPRECATION_MESSAGE,
        )
    }

    @Test
    fun `resolveOrFallback no altera cadenas similares a codificaciones`() {
        val payload = "RGFzaGJvYXJk"

        val result = resolveOrFallback(
            identifier = "composeId=test",
            resolver = { payload },
            fallback = RES_ERROR_PREFIX + fb("fallback"),
        ) { error ->
            throw AssertionError("No se esperaba fallo", error)
        }

        assertEquals(payload, result)
    }
}
