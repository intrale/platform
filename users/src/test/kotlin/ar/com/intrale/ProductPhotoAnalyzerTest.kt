package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals

class ProductPhotoAnalyzerTest {

    private val analyzer = ProductPhotoAnalyzer(apiKey = "", model = "test")

    @Test
    fun `parseAnalysisResponse con JSON valido retorna resultado correcto`() {
        val json = """{"name": "Empanadas", "description": "Empanadas de carne", "category": "Comidas", "confidence": 0.88}"""

        val result = analyzer.parseAnalysisResponse(json)

        assertEquals("Empanadas", result.suggestedName)
        assertEquals("Empanadas de carne", result.suggestedDescription)
        assertEquals("Comidas", result.suggestedCategory)
        assertEquals(0.88, result.confidence)
    }

    @Test
    fun `parseAnalysisResponse con JSON en bloque markdown retorna resultado`() {
        val text = """```json
{"name": "Pizza", "description": "Pizza napolitana", "category": "Pizzas", "confidence": 0.95}
```"""

        val result = analyzer.parseAnalysisResponse(text)

        assertEquals("Pizza", result.suggestedName)
        assertEquals("Pizza napolitana", result.suggestedDescription)
    }

    @Test
    fun `parseAnalysisResponse con texto invalido retorna resultado vacio`() {
        val result = analyzer.parseAnalysisResponse("esto no es json")

        assertEquals("", result.suggestedName)
        assertEquals("", result.suggestedDescription)
        assertEquals(0.0, result.confidence)
    }

    @Test
    fun `analyze sin API key retorna resultado vacio`() {
        val result = analyzer.analyze(
            imageBase64 = "data",
            mediaType = "image/jpeg",
            existingCategories = emptyList()
        )

        assertEquals("", result.suggestedName)
        assertEquals(0.0, result.confidence)
    }
}
