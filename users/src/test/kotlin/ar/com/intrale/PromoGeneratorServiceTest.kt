package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PromoGeneratorServiceTest {

    private val service = ClaudePromoGeneratorService(apiKey = "")

    @Test
    fun `genera promo por defecto cuando no hay API key`() {
        val product = LowRotationProduct(
            productId = "p1",
            productName = "Pan lactal",
            basePrice = 2500.0,
            unit = "unidad",
            daysSinceLastSale = 15,
            totalSalesInPeriod = 0,
            stockQuantity = 10
        )

        val result = kotlinx.coroutines.runBlocking {
            service.generatePromo("panaderia", product)
        }

        assertEquals("DISCOUNT_PERCENT", result.promoType)
        assertEquals(20, result.discountPercent)
        assertTrue(result.promoText.contains("Pan lactal"))
        assertTrue(result.promoText.contains("20%"))
    }

    @Test
    fun `promo por defecto usa 30 porciento para productos con mas de 30 dias sin venta`() {
        val product = LowRotationProduct(
            productId = "p1",
            productName = "Galletitas",
            basePrice = 1500.0,
            unit = "paquete",
            daysSinceLastSale = 45,
            totalSalesInPeriod = 0,
            stockQuantity = null
        )

        val result = kotlinx.coroutines.runBlocking {
            service.generatePromo("almacen", product)
        }

        assertEquals(30, result.discountPercent)
    }

    @Test
    fun `promo por defecto usa 15 porciento para productos con menos de 14 dias`() {
        val product = LowRotationProduct(
            productId = "p1",
            productName = "Leche",
            basePrice = 900.0,
            unit = "litro",
            daysSinceLastSale = 10,
            totalSalesInPeriod = 0,
            stockQuantity = 5
        )

        val result = kotlinx.coroutines.runBlocking {
            service.generatePromo("almacen", product)
        }

        assertEquals(15, result.discountPercent)
    }

    @Test
    fun `parsePromoResponse parsea JSON valido de Claude`() {
        val rawJson = """{"promo_type": "TWO_FOR_ONE", "discount_percent": null, "promo_text": "Lleva 2 paga 1!", "reason": "Producto estacional", "duration_days": 5}"""
        val product = LowRotationProduct("p1", "Test", 100.0, "u", 10, 0, null)

        val result = service.parsePromoResponse(rawJson, product)

        assertEquals("TWO_FOR_ONE", result.promoType)
        assertEquals("Lleva 2 paga 1!", result.promoText)
        assertEquals("Producto estacional", result.reason)
        assertEquals(5, result.suggestedDurationDays)
    }

    @Test
    fun `parsePromoResponse extrae JSON de markdown`() {
        val rawText = """Aqui va la promo:
```json
{"promo_type": "DISCOUNT_PERCENT", "discount_percent": 25, "promo_text": "25% OFF!", "reason": "Baja rotacion", "duration_days": 7}
```"""
        val product = LowRotationProduct("p1", "Test", 100.0, "u", 10, 0, null)

        val result = service.parsePromoResponse(rawText, product)

        assertEquals("DISCOUNT_PERCENT", result.promoType)
        assertEquals(25, result.discountPercent)
    }

    @Test
    fun `parsePromoResponse limita descuento entre 5 y 50`() {
        val rawJson = """{"promo_type": "DISCOUNT_PERCENT", "discount_percent": 80, "promo_text": "Mega descuento!", "reason": "Test", "duration_days": 7}"""
        val product = LowRotationProduct("p1", "Test", 100.0, "u", 10, 0, null)

        val result = service.parsePromoResponse(rawJson, product)

        assertEquals(50, result.discountPercent)
    }

    @Test
    fun `parsePromoResponse usa promo por defecto con texto invalido`() {
        val rawText = "esto no es json"
        val product = LowRotationProduct("p1", "Producto X", 500.0, "kg", 20, 0, null)

        val result = service.parsePromoResponse(rawText, product)

        assertEquals("DISCOUNT_PERCENT", result.promoType)
        assertTrue(result.promoText.isNotBlank())
    }
}
