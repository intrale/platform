package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ClaudePricingAnalysisServiceTest {

    private val service = ClaudePricingAnalysisService(apiKey = "")

    @Test
    fun `parseSuggestions parsea JSON valido correctamente`() {
        val json = """
        {
            "suggestions": [
                {
                    "product_name": "Pizza Grande",
                    "current_price": 1500.0,
                    "suggested_price": 1650.0,
                    "change_percent": 10.0,
                    "reason": "Alta demanda domingos mediodia",
                    "data_insight": "Vendes 2x los domingos 12-14hs vs promedio semanal",
                    "time_slot": "12:00-14:00",
                    "day_of_week": "domingo"
                },
                {
                    "product_name": "Helado 1kg",
                    "current_price": 800.0,
                    "suggested_price": 640.0,
                    "change_percent": -20.0,
                    "reason": "Baja demanda martes noche",
                    "data_insight": "Martes 20-00hs solo vendes 1 unidad promedio",
                    "time_slot": "20:00-00:00",
                    "day_of_week": "martes"
                }
            ]
        }
        """.trimIndent()

        val result = service.parseSuggestions(json)
        assertEquals(2, result.size)

        assertEquals("Pizza Grande", result[0].productName)
        assertEquals(1500.0, result[0].currentPrice)
        assertEquals(1650.0, result[0].suggestedPrice)
        assertEquals(10.0, result[0].changePercent)
        assertEquals("12:00-14:00", result[0].timeSlot)
        assertEquals("domingo", result[0].dayOfWeek)

        assertEquals("Helado 1kg", result[1].productName)
        assertEquals(-20.0, result[1].changePercent)
    }

    @Test
    fun `parseSuggestions con JSON envuelto en markdown`() {
        val json = """
        ```json
        {"suggestions": [{"product_name": "Empanada", "current_price": 200, "suggested_price": 220, "change_percent": 10, "reason": "Popular", "data_insight": "Top seller", "time_slot": null, "day_of_week": null}]}
        ```
        """.trimIndent()

        val result = service.parseSuggestions(json)
        assertEquals(1, result.size)
        assertEquals("Empanada", result[0].productName)
    }

    @Test
    fun `parseSuggestions con texto invalido retorna lista vacia`() {
        val result = service.parseSuggestions("esto no es JSON")
        assertTrue(result.isEmpty())
    }

    @Test
    fun `parseSuggestions con JSON vacio retorna lista vacia`() {
        val result = service.parseSuggestions("""{"suggestions": []}""")
        assertTrue(result.isEmpty())
    }

    @Test
    fun `analyzePricing sin API key retorna lista vacia`() = kotlinx.coroutines.runBlocking {
        val result = service.analyzePricing(
            businessName = "test",
            salesData = listOf(
                SalesSlotData("Pizza", "lunes", "12-14", 5.0, 7500.0, 1500.0)
            ),
            products = listOf(
                ProductSummary("Pizza", null, 1500.0, "unidad")
            )
        )
        assertTrue(result.isEmpty())
    }

    @Test
    fun `analyzePricing sin datos de ventas retorna lista vacia`() = kotlinx.coroutines.runBlocking {
        val result = service.analyzePricing(
            businessName = "test",
            salesData = emptyList(),
            products = listOf(
                ProductSummary("Pizza", null, 1500.0, "unidad")
            )
        )
        assertTrue(result.isEmpty())
    }
}
