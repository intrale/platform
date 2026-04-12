package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

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
        assertEquals("Pizzas", result.suggestedCategory)
        assertEquals(0.95, result.confidence)
    }

    @Test
    fun `parseAnalysisResponse con texto invalido retorna resultado vacio`() {
        val result = analyzer.parseAnalysisResponse("esto no es json")

        assertEquals("", result.suggestedName)
        assertEquals("", result.suggestedDescription)
        assertEquals("", result.suggestedCategory)
        assertEquals(0.0, result.confidence)
    }

    @Test
    fun `parseAnalysisResponse con JSON rodeado de texto retorna resultado`() {
        val text = """Aqui esta el analisis del producto:
{"name": "Alfajor", "description": "Alfajor de chocolate", "category": "Golosinas", "confidence": 0.75}
Espero que sea util."""

        val result = analyzer.parseAnalysisResponse(text)

        assertEquals("Alfajor", result.suggestedName)
        assertEquals("Alfajor de chocolate", result.suggestedDescription)
        assertEquals("Golosinas", result.suggestedCategory)
        assertEquals(0.75, result.confidence)
    }

    @Test
    fun `parseAnalysisResponse con bloque markdown sin etiqueta json retorna resultado`() {
        val text = """```
{"name": "Vino", "description": "Vino tinto Malbec", "category": "Bebidas", "confidence": 0.80}
```"""

        val result = analyzer.parseAnalysisResponse(text)

        assertEquals("Vino", result.suggestedName)
        assertEquals("Bebidas", result.suggestedCategory)
    }

    @Test
    fun `analyze sin API key retorna resultado vacio`() {
        val result = analyzer.analyze(
            imageBase64 = "data",
            mediaType = "image/jpeg",
            existingCategories = emptyList()
        )

        assertEquals("", result.suggestedName)
        assertEquals("", result.suggestedDescription)
        assertEquals("", result.suggestedCategory)
        assertEquals(0.0, result.confidence)
    }

    @Test
    fun `analyze sin API key con categorias existentes retorna resultado vacio`() {
        val result = analyzer.analyze(
            imageBase64 = "data",
            mediaType = "image/png",
            existingCategories = listOf("Panaderia", "Bebidas", "Carnes")
        )

        assertEquals("", result.suggestedName)
        assertEquals(0.0, result.confidence)
    }

    @Test
    fun `DTOs de Vision API se construyen correctamente`() {
        val source = VisionImageSource(type = "base64", mediaType = "image/jpeg", data = "abc123")
        assertEquals("base64", source.type)
        assertEquals("image/jpeg", source.mediaType)
        assertEquals("abc123", source.data)

        val contentImage = VisionContentBlock(type = "image", source = source)
        assertEquals("image", contentImage.type)
        assertEquals("abc123", contentImage.source?.data)

        val contentText = VisionContentBlock(type = "text", text = "Hola")
        assertEquals("text", contentText.type)
        assertEquals("Hola", contentText.text)

        val message = VisionClaudeMessage(role = "user", content = listOf(contentImage, contentText))
        assertEquals("user", message.role)
        assertEquals(2, message.content.size)

        val request = VisionClaudeRequest(
            model = "claude-sonnet-4-20250514",
            maxTokens = 512,
            system = "Sos un asistente",
            messages = listOf(message)
        )
        assertEquals("claude-sonnet-4-20250514", request.model)
        assertEquals(512, request.maxTokens)
        assertEquals("Sos un asistente", request.system)
        assertEquals(1, request.messages.size)
    }

    @Test
    fun `ProductPhotoAnalysisResult se construye correctamente`() {
        val result = ProductPhotoAnalysisResult(
            suggestedName = "Pan",
            suggestedDescription = "Pan casero",
            suggestedCategory = "Panaderia",
            confidence = 0.99
        )
        assertEquals("Pan", result.suggestedName)
        assertEquals("Pan casero", result.suggestedDescription)
        assertEquals("Panaderia", result.suggestedCategory)
        assertEquals(0.99, result.confidence)
    }

    @Test
    fun `PhotoAnalysisStructured tiene valores por defecto`() {
        val parsed = PhotoAnalysisStructured()
        assertEquals("", parsed.name)
        assertEquals("", parsed.description)
        assertEquals("", parsed.category)
        assertEquals(0.0, parsed.confidence)
    }
}
