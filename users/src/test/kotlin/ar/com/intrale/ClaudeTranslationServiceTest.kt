package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ClaudeTranslationServiceTest {

    private val service = ClaudeTranslationService(
        apiKey = "", // Sin API key para tests unitarios
        model = "claude-sonnet-4-20250514"
    )

    @Test
    fun `parseTranslationResponse parsea JSON valido correctamente`() {
        val json = """{"translations": [{"index": 0, "text": "Beef empanadas"}, {"index": 1, "text": "Homemade empanadas"}]}"""
        val result = service.parseTranslationResponse(json, 2)
        assertTrue(result.isSuccess)
        assertEquals(listOf("Beef empanadas", "Homemade empanadas"), result.getOrThrow())
    }

    @Test
    fun `parseTranslationResponse maneja JSON en bloque markdown`() {
        val json = """
            Aqui esta la traduccion:
            ```json
            {"translations": [{"index": 0, "text": "Croissants"}, {"index": 1, "text": "Butter croissants"}]}
            ```
        """.trimIndent()
        val result = service.parseTranslationResponse(json, 2)
        assertTrue(result.isSuccess)
        assertEquals("Croissants", result.getOrThrow()[0])
        assertEquals("Butter croissants", result.getOrThrow()[1])
    }

    @Test
    fun `parseTranslationResponse ordena por indice`() {
        val json = """{"translations": [{"index": 1, "text": "Second"}, {"index": 0, "text": "First"}]}"""
        val result = service.parseTranslationResponse(json, 2)
        assertTrue(result.isSuccess)
        assertEquals(listOf("First", "Second"), result.getOrThrow())
    }

    @Test
    fun `parseTranslationResponse falla con respuesta vacia`() {
        val json = """{"translations": []}"""
        val result = service.parseTranslationResponse(json, 2)
        assertTrue(result.isFailure)
    }

    @Test
    fun `parseTranslationResponse falla con texto no JSON`() {
        val result = service.parseTranslationResponse("no es json", 2)
        assertTrue(result.isFailure)
    }

    @Test
    fun `SUPPORTED_LOCALES contiene los idiomas requeridos`() {
        assertTrue(ClaudeTranslationService.SUPPORTED_LOCALES.contains("es"))
        assertTrue(ClaudeTranslationService.SUPPORTED_LOCALES.contains("en"))
        assertTrue(ClaudeTranslationService.SUPPORTED_LOCALES.contains("pt"))
    }
}
