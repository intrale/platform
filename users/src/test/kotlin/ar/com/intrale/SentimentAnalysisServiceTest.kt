package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals

class SentimentAnalysisServiceTest {

    private val service = ClaudeSentimentAnalysisService(apiKey = "") // Sin API key para tests

    @Test
    fun `parseClassificationResponse parsea JSON valido de sentimiento positivo`() {
        val json = """{"sentiment": "POSITIVE", "themes": ["buena atencion", "productos frescos"], "confidence": 0.95}"""

        val result = service.parseClassificationResponse(json)

        assertEquals("POSITIVE", result.sentiment)
        assertEquals(listOf("buena atencion", "productos frescos"), result.themes)
        assertEquals(0.95, result.confidence)
    }

    @Test
    fun `parseClassificationResponse parsea JSON valido de sentimiento negativo`() {
        val json = """{"sentiment": "NEGATIVE", "themes": ["entrega lenta"], "confidence": 0.88}"""

        val result = service.parseClassificationResponse(json)

        assertEquals("NEGATIVE", result.sentiment)
        assertEquals(listOf("entrega lenta"), result.themes)
        assertEquals(0.88, result.confidence)
    }

    @Test
    fun `parseClassificationResponse parsea JSON envuelto en markdown`() {
        val text = """```json
{"sentiment": "NEUTRAL", "themes": ["precio alto"], "confidence": 0.75}
```"""

        val result = service.parseClassificationResponse(text)

        assertEquals("NEUTRAL", result.sentiment)
        assertEquals(listOf("precio alto"), result.themes)
    }

    @Test
    fun `parseClassificationResponse retorna NEUTRAL con texto invalido`() {
        val result = service.parseClassificationResponse("esto no es json")

        assertEquals("NEUTRAL", result.sentiment)
        assertEquals(emptyList(), result.themes)
        assertEquals(0.0, result.confidence)
    }

    @Test
    fun `parseClassificationResponse normaliza sentimiento invalido a NEUTRAL`() {
        val json = """{"sentiment": "MUY_BUENO", "themes": [], "confidence": 0.5}"""

        val result = service.parseClassificationResponse(json)

        assertEquals("NEUTRAL", result.sentiment)
    }

    @Test
    fun `parseClassificationResponse limita temas a 5`() {
        val json = """{"sentiment": "POSITIVE", "themes": ["t1", "t2", "t3", "t4", "t5", "t6", "t7"], "confidence": 0.9}"""

        val result = service.parseClassificationResponse(json)

        assertEquals(5, result.themes.size)
    }

    @Test
    fun `parseSummaryResponse parsea JSON valido de resumen`() {
        val json = """{"summary": "3 clientes elogiaron la frescura, 2 se quejaron de la entrega", "confidence": 0.9}"""

        val result = service.parseSummaryResponse(json)

        assertEquals("3 clientes elogiaron la frescura, 2 se quejaron de la entrega", result.summary)
        assertEquals(0.9, result.confidence)
    }

    @Test
    fun `parseSummaryResponse con texto no JSON retorna texto directo`() {
        val result = service.parseSummaryResponse("Resumen en texto plano")

        assertEquals("Resumen en texto plano", result.summary)
        assertEquals(0.5, result.confidence)
    }

    @Test
    fun `classifyReview sin API key retorna resultado por defecto`() {
        val result = kotlinx.coroutines.runBlocking {
            service.classifyReview("Una review cualquiera")
        }

        assertEquals("NEUTRAL", result.sentiment)
        assertEquals(emptyList(), result.themes)
        assertEquals(0.0, result.confidence)
    }
}
