package ar.com.intrale

import org.slf4j.helpers.NOPLogger
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class OrderAnomalyDetectionServiceTest {

    private val repository = ClientOrderRepository()
    private val logger = NOPLogger.NOP_LOGGER
    private val service = OrderAnomalyDetectionService(repository, logger)

    private fun createOrder(
        business: String,
        email: String,
        items: List<ClientOrderItemPayload> = listOf(
            ClientOrderItemPayload(productId = "prod-1", productName = "Pizza", name = "Pizza", quantity = 1, unitPrice = 1000.0, subtotal = 1000.0)
        ),
        total: Double = items.sumOf { it.subtotal },
        notes: String? = null
    ): ClientOrderPayload {
        val payload = ClientOrderPayload(
            status = "PENDING",
            items = items,
            total = total,
            notes = notes,
            businessName = business
        )
        return repository.createOrder(business, email, payload)
    }

    @Test
    fun `analisis sin anomalias retorna resultado limpio`() {
        val order = createOrder("pizzeria", "user@test.com")
        val result = service.analyze("pizzeria", "user@test.com", order)

        assertEquals(order.id, result.orderId)
        assertTrue(result.anomalies.isEmpty())
        assertFalse(result.flagged)
        assertFalse(result.requiresManualReview)
    }

    @Test
    fun `detecta pedido duplicado dentro de la ventana temporal`() {
        val items = listOf(
            ClientOrderItemPayload(productId = "prod-1", productName = "Pizza", name = "Pizza", quantity = 2, unitPrice = 1000.0, subtotal = 2000.0)
        )
        createOrder("pizzeria", "user@test.com", items)
        val duplicate = createOrder("pizzeria", "user@test.com", items)

        val result = service.analyze("pizzeria", "user@test.com", duplicate)

        assertTrue(result.flagged)
        assertTrue(result.anomalies.any { it.type == AnomalyType.DUPLICATE_ORDER })
        assertEquals(AnomalySeverity.HIGH, result.anomalies.first { it.type == AnomalyType.DUPLICATE_ORDER }.severity)
    }

    @Test
    fun `no detecta duplicado con items diferentes`() {
        val items1 = listOf(
            ClientOrderItemPayload(productId = "prod-1", productName = "Pizza", name = "Pizza", quantity = 1, unitPrice = 1000.0, subtotal = 1000.0)
        )
        val items2 = listOf(
            ClientOrderItemPayload(productId = "prod-2", productName = "Empanada", name = "Empanada", quantity = 3, unitPrice = 500.0, subtotal = 1500.0)
        )
        createOrder("pizzeria", "user@test.com", items1)
        val different = createOrder("pizzeria", "user@test.com", items2)

        val result = service.analyze("pizzeria", "user@test.com", different)

        assertFalse(result.anomalies.any { it.type == AnomalyType.DUPLICATE_ORDER })
    }

    @Test
    fun `detecta monto inusual mayor a 3x el ticket promedio`() {
        // Crear historial de pedidos con ticket promedio de ~1000
        repeat(5) { createOrder("pizzeria", "other@test.com", total = 1000.0) }

        // Crear pedido con monto mucho mayor
        val expensiveItems = listOf(
            ClientOrderItemPayload(productId = "prod-1", productName = "Pizza Premium", name = "Pizza Premium", quantity = 10, unitPrice = 5000.0, subtotal = 50000.0)
        )
        val expensive = createOrder("pizzeria", "user@test.com", expensiveItems, total = 50000.0)

        val result = service.analyze("pizzeria", "user@test.com", expensive)

        assertTrue(result.anomalies.any { it.type == AnomalyType.UNUSUAL_AMOUNT })
    }

    @Test
    fun `no detecta monto inusual si esta dentro del rango`() {
        repeat(5) { createOrder("pizzeria", "other@test.com", total = 1000.0) }

        val normalItems = listOf(
            ClientOrderItemPayload(productId = "prod-1", productName = "Pizza", name = "Pizza", quantity = 2, unitPrice = 1000.0, subtotal = 2000.0)
        )
        val normal = createOrder("pizzeria", "user@test.com", normalItems, total = 2000.0)

        val result = service.analyze("pizzeria", "user@test.com", normal)

        assertFalse(result.anomalies.any { it.type == AnomalyType.UNUSUAL_AMOUNT })
    }

    @Test
    fun `no detecta monto inusual sin datos historicos suficientes`() {
        val expensiveItems = listOf(
            ClientOrderItemPayload(productId = "prod-1", productName = "Item caro", name = "Item caro", quantity = 1, unitPrice = 999999.0, subtotal = 999999.0)
        )
        val order = createOrder("nuevo-negocio", "user@test.com", expensiveItems, total = 999999.0)

        val result = service.analyze("nuevo-negocio", "user@test.com", order)

        assertFalse(result.anomalies.any { it.type == AnomalyType.UNUSUAL_AMOUNT })
    }

    @Test
    fun `detecta frecuencia sospechosa con muchos pedidos por hora`() {
        val config = AnomalyDetectionConfig(maxOrdersPerHour = 3)

        // Crear 4 pedidos del mismo cliente (excede el limite de 3)
        repeat(3) { i ->
            createOrder("pizzeria", "spammer@test.com",
                items = listOf(ClientOrderItemPayload(productId = "prod-$i", productName = "Item $i", name = "Item $i", quantity = 1, unitPrice = 100.0, subtotal = 100.0)),
                total = 100.0
            )
        }
        val lastOrder = createOrder("pizzeria", "spammer@test.com",
            items = listOf(ClientOrderItemPayload(productId = "prod-unique", productName = "Otro", name = "Otro", quantity = 1, unitPrice = 200.0, subtotal = 200.0)),
            total = 200.0
        )

        val result = service.analyze("pizzeria", "spammer@test.com", lastOrder, config)

        assertTrue(result.anomalies.any { it.type == AnomalyType.SUSPICIOUS_FREQUENCY })
    }

    @Test
    fun `config personalizada cambia umbral de deteccion`() {
        val strictConfig = AnomalyDetectionConfig(
            amountThresholdMultiplier = 1.5,
            flagThreshold = 0.3
        )

        repeat(5) { createOrder("tienda", "other@test.com", total = 1000.0) }

        val order = createOrder("tienda", "user@test.com",
            items = listOf(ClientOrderItemPayload(productId = "prod-1", productName = "Item", name = "Item", quantity = 1, unitPrice = 2000.0, subtotal = 2000.0)),
            total = 2000.0
        )

        val result = service.analyze("tienda", "user@test.com", order, strictConfig)

        assertTrue(result.anomalies.any { it.type == AnomalyType.UNUSUAL_AMOUNT })
        assertTrue(result.flagged)
    }

    @Test
    fun `pedido sin anomalias no es flaggeado`() {
        repeat(5) { createOrder("tienda", "buyer@test.com", total = 1000.0) }

        val normalOrder = createOrder("tienda", "user@test.com", total = 1200.0)
        val result = service.analyze("tienda", "user@test.com", normalOrder)

        assertFalse(result.flagged)
        assertFalse(result.requiresManualReview)
    }
}
