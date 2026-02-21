package ui.util

import kotlin.test.Test
import kotlin.test.assertEquals

class SafeResourceTest {

    @Test
    fun `safeString expone mensaje de deprecacion hacia Txt`() {
        assertEquals(
            "Usar Txt(MessageKey, params)",
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
