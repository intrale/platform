package ar.com.intrale

import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DemandPredictionServiceTest {

    private val service = ClaudeDemandPredictionService(apiKey = "", model = "test")

    @Test
    fun `calculateWeeksOfData retorna 0 para lista vacia`() {
        val result = service.calculateWeeksOfData(emptyList())
        assertEquals(0, result)
    }

    @Test
    fun `calculateWeeksOfData retorna 1 para datos de un solo dia`() {
        val sales = listOf(
            ProductDailySales("Pizza", "2026-03-15", "Domingo", 10, 50000.0)
        )
        val result = service.calculateWeeksOfData(sales)
        assertEquals(1, result)
    }

    @Test
    fun `calculateWeeksOfData retorna semanas correctas para rango de 14 dias`() {
        val sales = listOf(
            ProductDailySales("Pizza", "2026-03-01", "Domingo", 10, 50000.0),
            ProductDailySales("Pizza", "2026-03-14", "Sabado", 15, 75000.0)
        )
        val result = service.calculateWeeksOfData(sales)
        assertEquals(2, result)
    }

    @Test
    fun `parseResponse parsea JSON valido correctamente`() {
        val json = """
        {
          "products": [
            {
              "product_name": "Pizza Muzzarella",
              "expected_quantity": 150,
              "trend": "up",
              "change_percent": 25.0,
              "stock_alert": true,
              "insight": "Los viernes se vende 40% mas"
            },
            {
              "product_name": "Empanadas",
              "expected_quantity": 200,
              "trend": "stable",
              "change_percent": 5.0,
              "stock_alert": false,
              "insight": "Demanda estable"
            }
          ],
          "summary": "Semana con alta demanda de pizzas"
        }
        """.trimIndent()

        val result = service.parseResponse(json, 4)

        assertEquals(2, result.topProducts.size)
        assertEquals("Pizza Muzzarella", result.topProducts[0].productName)
        assertEquals(150, result.topProducts[0].expectedQuantity)
        assertEquals("up", result.topProducts[0].trend)
        assertEquals(25.0, result.topProducts[0].changePercent)
        assertTrue(result.topProducts[0].stockAlert)
        assertEquals("Los viernes se vende 40% mas", result.topProducts[0].insight)
        assertEquals("Semana con alta demanda de pizzas", result.summary)
        assertEquals(4, result.dataWeeksUsed)
    }

    @Test
    fun `parseResponse maneja JSON en bloque markdown`() {
        val rawText = """
        ```json
        {
          "products": [
            {
              "product_name": "Milanesa",
              "expected_quantity": 80,
              "trend": "down",
              "change_percent": -10.0,
              "stock_alert": false,
              "insight": "Tendencia a la baja"
            }
          ],
          "summary": "Semana tranquila"
        }
        ```
        """.trimIndent()

        val result = service.parseResponse(rawText, 3)

        assertEquals(1, result.topProducts.size)
        assertEquals("Milanesa", result.topProducts[0].productName)
        assertEquals("down", result.topProducts[0].trend)
    }

    @Test
    fun `parseResponse retorna resultado vacio con JSON invalido`() {
        val result = service.parseResponse("esto no es json", 2)

        assertTrue(result.topProducts.isEmpty())
        assertTrue(result.summary.contains("Error"))
        assertEquals(2, result.dataWeeksUsed)
    }

    @Test
    fun `parseResponse limita a 5 productos`() {
        val products = (1..8).map { i ->
            """{"product_name": "Producto $i", "expected_quantity": ${i * 10}, "trend": "stable", "change_percent": 0.0, "stock_alert": false, "insight": "ok"}"""
        }.joinToString(",")

        val json = """{"products": [$products], "summary": "Muchos productos"}"""

        val result = service.parseResponse(json, 5)

        assertEquals(5, result.topProducts.size)
    }

    @Test
    fun `buildDemandPredictionPrompt incluye datos del negocio y ventas`() {
        val sales = listOf(
            ProductDailySales("Pizza", "2026-03-15", "Domingo", 10, 50000.0),
            ProductDailySales("Empanada", "2026-03-15", "Domingo", 20, 30000.0)
        )

        val prompt = service.buildDemandPredictionPrompt(
            "pizzeria",
            sales,
            LocalDate.of(2026, 3, 23)
        )

        assertTrue(prompt.contains("pizzeria"))
        assertTrue(prompt.contains("Pizza"))
        assertTrue(prompt.contains("Empanada"))
        assertTrue(prompt.contains("2026-03-23"))
        assertTrue(prompt.contains("2026-03-29"))
        assertTrue(prompt.contains("top 5"))
    }

    @Test
    fun `generatePrediction retorna vacio sin API key`() {
        val noKeyService = ClaudeDemandPredictionService(apiKey = "")

        val result = kotlinx.coroutines.runBlocking {
            noKeyService.generatePrediction(
                "pizzeria",
                listOf(ProductDailySales("Pizza", "2026-03-15", "Domingo", 10, 50000.0)),
                LocalDate.of(2026, 3, 23)
            )
        }

        assertTrue(result.topProducts.isEmpty())
        assertTrue(result.summary.contains("no configurado") || result.summary.contains("No se pudo"))
    }

    @Test
    fun `generatePrediction retorna vacio sin datos de ventas`() {
        // Crear servicio con API key valida para que llegue a la validacion de datos vacios
        val serviceWithKey = ClaudeDemandPredictionService(apiKey = "test-key")

        val result = kotlinx.coroutines.runBlocking {
            serviceWithKey.generatePrediction("pizzeria", emptyList(), LocalDate.of(2026, 3, 23))
        }

        assertTrue(result.topProducts.isEmpty())
        assertTrue(result.summary.contains("No hay"))
        assertEquals(0, result.dataWeeksUsed)
    }
}
