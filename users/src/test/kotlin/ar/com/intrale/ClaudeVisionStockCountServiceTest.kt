package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ClaudeVisionStockCountServiceTest {

    private val service = ClaudeVisionStockCountService(apiKey = "")

    @Test
    fun `buildSystemPrompt incluye productos conocidos`() {
        val products = listOf(
            ProductSummary(
                name = "Coca-Cola 500ml",
                shortDescription = "Gaseosa cola",
                basePrice = 1500.0,
                unit = "unidad",
                category = "Bebidas",
                isAvailable = true
            ),
            ProductSummary(
                name = "Pan Lactal",
                shortDescription = null,
                basePrice = 2000.0,
                unit = "unidad",
                category = "Panaderia",
                isAvailable = true
            )
        )

        val prompt = service.buildSystemPrompt(products)

        assertTrue(prompt.contains("Coca-Cola 500ml"))
        assertTrue(prompt.contains("(Gaseosa cola)"))
        assertTrue(prompt.contains("[Bebidas]"))
        assertTrue(prompt.contains("Pan Lactal"))
        assertTrue(prompt.contains("[Panaderia]"))
        assertTrue(prompt.contains("PRODUCTOS CONOCIDOS DEL NEGOCIO"))
        assertTrue(prompt.contains("JSON valido"))
    }

    @Test
    fun `buildSystemPrompt sin productos conocidos no incluye seccion de productos`() {
        val prompt = service.buildSystemPrompt(emptyList())

        assertTrue(!prompt.contains("PRODUCTOS CONOCIDOS DEL NEGOCIO"))
        assertTrue(prompt.contains("JSON valido"))
    }

    @Test
    fun `buildSystemPrompt filtra productos no disponibles`() {
        val products = listOf(
            ProductSummary(
                name = "Disponible",
                basePrice = 100.0,
                unit = "u",
                isAvailable = true
            ),
            ProductSummary(
                name = "No Disponible",
                basePrice = 200.0,
                unit = "u",
                isAvailable = false
            )
        )

        val prompt = service.buildSystemPrompt(products)

        assertTrue(prompt.contains("Disponible"))
        assertTrue(!prompt.contains("No Disponible"))
    }

    @Test
    fun `parseVisionResponse parsea JSON valido correctamente`() {
        val rawText = """{
            "products": [
                {"name": "Coca-Cola 500ml", "quantity": 12, "confidence": 0.95},
                {"name": "Sprite 500ml", "quantity": 8, "confidence": 0.85}
            ],
            "unrecognized_count": 3,
            "notes": "Buena iluminacion"
        }"""

        val knownProducts = listOf(
            ProductSummary(name = "Coca-Cola 500ml", basePrice = 1500.0, unit = "u")
        )

        val result = service.parseVisionResponse(rawText, knownProducts)

        assertEquals(2, result.products.size)
        assertEquals("Coca-Cola 500ml", result.products[0].name)
        assertEquals(12, result.products[0].quantity)
        assertEquals(0.95, result.products[0].confidence)
        assertEquals("Sprite 500ml", result.products[1].name)
        assertEquals(3, result.unrecognizedCount)
        assertEquals("Buena iluminacion", result.notes)
    }

    @Test
    fun `parseVisionResponse parsea JSON envuelto en markdown`() {
        val rawText = """Aqui esta el resultado:
```json
{"products": [{"name": "Fanta", "quantity": 5, "confidence": 0.9}], "unrecognized_count": 0}
```"""

        val result = service.parseVisionResponse(rawText, emptyList())

        assertEquals(1, result.products.size)
        assertEquals("Fanta", result.products[0].name)
        assertEquals(5, result.products[0].quantity)
    }

    @Test
    fun `parseVisionResponse con texto invalido retorna resultado vacio`() {
        val rawText = "No pude procesar la imagen porque esta muy oscura"

        val result = service.parseVisionResponse(rawText, emptyList())

        assertEquals(0, result.products.size)
        assertTrue(result.notes?.contains("No se pudo interpretar") == true)
    }

    @Test
    fun `parseVisionResponse matchea productos conocidos por nombre`() {
        val rawText = """{
            "products": [{"name": "coca cola", "quantity": 10, "confidence": 0.9}],
            "unrecognized_count": 0
        }"""

        val knownProducts = listOf(
            ProductSummary(name = "Coca-Cola 500ml", basePrice = 1500.0, unit = "u"),
            ProductSummary(name = "Sprite 1L", basePrice = 2000.0, unit = "u")
        )

        val result = service.parseVisionResponse(rawText, knownProducts)

        // Deberia matchear con "Coca-Cola 500ml" por match parcial
        assertEquals("Coca-Cola 500ml", result.products[0].name)
        assertEquals("0", result.products[0].matchedProductId)
    }

    @Test
    fun `countStock sin API key retorna resultado con nota de error`() = kotlinx.coroutines.runBlocking {
        val serviceWithoutKey = ClaudeVisionStockCountService(apiKey = "")

        val result = serviceWithoutKey.countStock(
            imageBase64 = "dGVzdA==",
            mediaType = "image/jpeg",
            knownProducts = emptyList()
        )

        assertEquals(0, result.products.size)
        assertTrue(result.notes?.contains("API key") == true)
    }
}
