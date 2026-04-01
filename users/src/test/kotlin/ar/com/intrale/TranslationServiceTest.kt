package ar.com.intrale

import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertNotNull

class TranslationServiceTest {

    @Test
    fun `parseTranslationResponse parsea correctamente cuando no necesita traduccion`() {
        val service = ClaudeTranslationService(apiKey = "test")
        val json = """{"detected_language": "es", "needs_translation": false, "translated_text": null, "target_language": null}"""

        val result = service.parseTranslationResponse(json)

        assertEquals("es", result.detectedLanguage)
        assertNull(result.translatedText)
        assertNull(result.targetLanguage)
    }

    @Test
    fun `parseTranslationResponse parsea correctamente cuando necesita traduccion`() {
        val service = ClaudeTranslationService(apiKey = "test")
        val json = """{"detected_language": "en", "needs_translation": true, "translated_text": "Estoy llegando", "target_language": "es"}"""

        val result = service.parseTranslationResponse(json)

        assertEquals("en", result.detectedLanguage)
        assertEquals("Estoy llegando", result.translatedText)
        assertEquals("es", result.targetLanguage)
    }

    @Test
    fun `parseTranslationResponse maneja JSON envuelto en markdown`() {
        val service = ClaudeTranslationService(apiKey = "test")
        val json = """```json
{"detected_language": "pt", "needs_translation": true, "translated_text": "Estoy llegando", "target_language": "es"}
```"""

        val result = service.parseTranslationResponse(json)

        assertEquals("pt", result.detectedLanguage)
        assertEquals("Estoy llegando", result.translatedText)
    }

    @Test
    fun `parseTranslationResponse retorna unknown cuando el JSON es invalido`() {
        val service = ClaudeTranslationService(apiKey = "test")
        val invalidText = "no es un json valido"

        val result = service.parseTranslationResponse(invalidText)

        assertEquals("unknown", result.detectedLanguage)
        assertNull(result.translatedText)
    }

    @Test
    fun `detectAndTranslate retorna sin traduccion cuando el texto esta vacio`() = runBlocking {
        val service = ClaudeTranslationService(apiKey = "test")

        val result = service.detectAndTranslate("", "es")

        assertEquals("unknown", result.detectedLanguage)
        assertNull(result.translatedText)
    }

    @Test
    fun `detectAndTranslate retorna sin traduccion cuando no hay API key`() = runBlocking {
        val service = ClaudeTranslationService(apiKey = "")

        val result = service.detectAndTranslate("Hello world", "es")

        assertEquals("unknown", result.detectedLanguage)
        assertNull(result.translatedText)
    }
}

/**
 * Fake del servicio de traduccion para tests de ChatFunction.
 */
class FakeTranslationService(
    private val detectedLanguage: String = "es",
    private val translatedText: String? = null,
    private val targetLanguage: String? = null
) : TranslationService {
    var lastText: String? = null
    var lastTargetLanguage: String? = null
    var callCount: Int = 0

    override suspend fun detectAndTranslate(text: String, targetLanguage: String): TranslationResult {
        lastText = text
        lastTargetLanguage = targetLanguage
        callCount++
        return TranslationResult(
            detectedLanguage = detectedLanguage,
            translatedText = translatedText,
            targetLanguage = this.targetLanguage
        )
    }
}
