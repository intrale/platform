package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ConversationalSearchServiceTest {

    private val service = ClaudeConversationalSearchService(apiKey = "")

    @Test
    fun `parseSearchResponse con JSON valido y sugerencias`() {
        val raw = """{
            "suggestions": [
                {"product_id": "p1", "name": "Harina 000", "reason": "Ingrediente basico para pizza", "price": 1500.0, "unit": "kg", "category": "Harinas", "relevance": 0.95},
                {"product_id": "p2", "name": "Salsa de tomate", "reason": "Base para la salsa de pizza", "price": 800.0, "unit": "unidad", "category": "Salsas", "relevance": 0.9}
            ],
            "message": "Encontre estos productos para hacer pizza:",
            "confidence": 0.92
        }"""

        val result = service.parseSearchResponse(raw)

        assertEquals(2, result.suggestions.size)
        assertTrue(result.hasResults)
        assertEquals("Harina 000", result.suggestions[0].name)
        assertEquals("p1", result.suggestions[0].productId)
        assertEquals("Ingrediente basico para pizza", result.suggestions[0].reason)
        assertEquals(0.95, result.suggestions[0].relevance)
        assertEquals("Salsa de tomate", result.suggestions[1].name)
        assertTrue(result.message.contains("pizza"))
        assertEquals(0.92, result.confidence)
    }

    @Test
    fun `parseSearchResponse con JSON sin sugerencias`() {
        val raw = """{
            "suggestions": [],
            "message": "No encontre productos que coincidan con tu busqueda.",
            "confidence": 0.8
        }"""

        val result = service.parseSearchResponse(raw)

        assertTrue(result.suggestions.isEmpty())
        assertFalse(result.hasResults)
        assertTrue(result.message.contains("No encontre"))
    }

    @Test
    fun `parseSearchResponse con JSON en bloque markdown`() {
        val raw = """
            ```json
            {"suggestions": [{"product_id": "p1", "name": "Leche", "reason": "Lacteo basico", "price": 800.0, "unit": "litro", "relevance": 0.9}], "message": "Esto encontre:", "confidence": 0.85}
            ```
        """.trimIndent()

        val result = service.parseSearchResponse(raw)

        assertEquals(1, result.suggestions.size)
        assertTrue(result.hasResults)
        assertEquals("Leche", result.suggestions[0].name)
    }

    @Test
    fun `parseSearchResponse con texto no JSON devuelve resultado vacio`() {
        val raw = "Lo siento, no puedo procesar esa consulta."
        val result = service.parseSearchResponse(raw)

        assertFalse(result.hasResults)
        assertEquals(0.5, result.confidence)
    }

    @Test
    fun `search sin API key devuelve resultado vacio con mensaje`() = kotlinx.coroutines.runBlocking {
        val serviceWithoutKey = ClaudeConversationalSearchService(apiKey = "")
        val products = listOf(
            ProductRecord(id = "p1", name = "Test", basePrice = 100.0, unit = "u", status = "PUBLISHED")
        )

        val result = serviceWithoutKey.search("quiero algo", products, "test-biz")

        assertFalse(result.hasResults)
        assertTrue(result.message.contains("no esta disponible"))
        assertEquals(0.0, result.confidence)
    }

    @Test
    fun `search con catalogo vacio devuelve mensaje informativo`() = kotlinx.coroutines.runBlocking {
        val serviceWithKey = ClaudeConversationalSearchService(apiKey = "fake-key")

        val result = serviceWithKey.search("quiero algo", emptyList(), "test-biz")

        assertFalse(result.hasResults)
        assertTrue(result.message.contains("no tiene productos"))
    }

    @Test
    fun `buildSearchPrompt incluye todos los productos`() {
        val products = listOf(
            ProductRecord(
                id = "p1", name = "Harina 000", shortDescription = "Harina triple cero",
                basePrice = 1500.0, unit = "kg", categoryId = "Harinas",
                status = "PUBLISHED", isAvailable = true
            ),
            ProductRecord(
                id = "p2", name = "Muzzarella", shortDescription = "Queso muzzarella",
                basePrice = 3000.0, unit = "kg", categoryId = "Lacteos",
                status = "PUBLISHED", isAvailable = false, promotionPrice = 2500.0
            )
        )

        val prompt = service.buildSearchPrompt(products, "almacen")

        assertTrue(prompt.contains("almacen"))
        assertTrue(prompt.contains("Harina 000"))
        assertTrue(prompt.contains("Muzzarella"))
        assertTrue(prompt.contains("[NO DISPONIBLE]"))
        assertTrue(prompt.contains("promo: \$2500.0"))
        assertTrue(prompt.contains("ID:p1"))
        assertTrue(prompt.contains("ID:p2"))
        assertTrue(prompt.contains("[Harinas]"))
        assertTrue(prompt.contains("[Lacteos]"))
    }
}
