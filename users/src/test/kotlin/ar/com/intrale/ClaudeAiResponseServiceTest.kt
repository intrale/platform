package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ClaudeAiResponseServiceTest {

    private val service = ClaudeAiResponseService(apiKey = "", confidenceThreshold = 0.7)

    @Test
    fun `parseStructuredResponse con JSON valido de alta confianza`() {
        val raw = """{"answer": "Abrimos de 9 a 18hs", "confidence": 0.95, "escalate": false}"""
        val result = service.parseStructuredResponse(raw)

        assertEquals("Abrimos de 9 a 18hs", result.answer)
        assertEquals(0.95, result.confidence)
        assertFalse(result.escalated)
    }

    @Test
    fun `parseStructuredResponse con JSON en bloque markdown`() {
        val raw = """
            ```json
            {"answer": "Aceptamos efectivo y tarjeta", "confidence": 0.9, "escalate": false}
            ```
        """.trimIndent()
        val result = service.parseStructuredResponse(raw)

        assertEquals("Aceptamos efectivo y tarjeta", result.answer)
        assertFalse(result.escalated)
    }

    @Test
    fun `parseStructuredResponse escala cuando confianza es baja`() {
        val raw = """{"answer": "No estoy seguro", "confidence": 0.4, "escalate": false}"""
        val result = service.parseStructuredResponse(raw)

        assertTrue(result.escalated)
        assertEquals("", result.answer)
    }

    @Test
    fun `parseStructuredResponse escala cuando escalate es true`() {
        val raw = """{"answer": "", "confidence": 0.9, "escalate": true}"""
        val result = service.parseStructuredResponse(raw)

        assertTrue(result.escalated)
    }

    @Test
    fun `parseStructuredResponse con texto no JSON escala al humano`() {
        val raw = "Lo siento, no puedo responder a esa pregunta."
        val result = service.parseStructuredResponse(raw)

        assertTrue(result.escalated)
        assertEquals(0.5, result.confidence)
    }

    @Test
    fun `generateResponse sin API key escala al humano`() = kotlinx.coroutines.runBlocking {
        val serviceWithoutKey = ClaudeAiResponseService(apiKey = "")
        val context = BusinessContext(businessName = "test")

        val result = serviceWithoutKey.generateResponse(context, "Hola")

        assertTrue(result.escalated)
        assertEquals(0.0, result.confidence)
    }
}
