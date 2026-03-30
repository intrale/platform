package ar.com.intrale

import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class OrderAnomalyDetectorTest {

    private val orderRepository = ClientOrderRepository()
    private val anomalyRepository = OrderAnomalyRepository()
    private val config = AnomalyDetectionConfig(
        duplicateWindowMinutes = 5,
        amountMultiplierThreshold = 3.0,
        minOrdersForAverage = 3,
        suspiciousAddressMinAccounts = 2
    )
    private val detector = OrderAnomalyDetector(orderRepository, anomalyRepository, config)

    // --- Pedidos duplicados ---

    @Test
    fun `detecta pedido duplicado cuando mismos productos en menos de 5 minutos`() {
        val email = "user@test.com"
        val business = "tienda"

        // Crear un pedido existente reciente
        orderRepository.createOrder(business, email, ClientOrderPayload(
            status = "PENDING",
            items = listOf(
                ClientOrderItemPayload(productId = "p1", productName = "Producto 1", quantity = 2, unitPrice = 10.0, subtotal = 20.0)
            ),
            total = 20.0
        ))

        // Intentar crear uno idéntico
        val newOrder = ClientOrderPayload(
            status = "PENDING",
            items = listOf(
                ClientOrderItemPayload(productId = "p1", productName = "Producto 1", quantity = 2, unitPrice = 10.0, subtotal = 20.0)
            ),
            total = 20.0
        )

        val anomalies = detector.evaluate(business, email, newOrder)
        assertTrue(anomalies.any { it.type == AnomalyType.DUPLICATE_ORDER })
    }

    @Test
    fun `no detecta duplicado cuando productos son diferentes`() {
        val email = "user@test.com"
        val business = "tienda"

        orderRepository.createOrder(business, email, ClientOrderPayload(
            status = "PENDING",
            items = listOf(
                ClientOrderItemPayload(productId = "p1", productName = "Producto 1", quantity = 2, unitPrice = 10.0, subtotal = 20.0)
            ),
            total = 20.0
        ))

        val newOrder = ClientOrderPayload(
            status = "PENDING",
            items = listOf(
                ClientOrderItemPayload(productId = "p2", productName = "Producto 2", quantity = 1, unitPrice = 30.0, subtotal = 30.0)
            ),
            total = 30.0
        )

        val result = detector.checkDuplicateOrder(business, email, newOrder)
        assertNull(result)
    }

    @Test
    fun `no detecta duplicado cuando no hay pedidos previos`() {
        val newOrder = ClientOrderPayload(
            status = "PENDING",
            items = listOf(
                ClientOrderItemPayload(productId = "p1", productName = "Producto 1", quantity = 1, unitPrice = 10.0, subtotal = 10.0)
            ),
            total = 10.0
        )

        val result = detector.checkDuplicateOrder("tienda", "nuevo@test.com", newOrder)
        assertNull(result)
    }

    // --- Monto inusual ---

    @Test
    fun `detecta monto inusual cuando supera 3x el ticket promedio`() {
        val business = "tienda"

        // Crear historial de pedidos con ticket promedio de ~$20
        repeat(5) { i ->
            orderRepository.createOrder(business, "user$i@test.com", ClientOrderPayload(
                status = "DELIVERED",
                items = listOf(
                    ClientOrderItemPayload(productId = "p1", productName = "Producto", quantity = 1, unitPrice = 20.0, subtotal = 20.0)
                ),
                total = 20.0
            ))
        }

        // Pedido con monto muy alto ($200 > 3x$20 = $60)
        val expensiveOrder = ClientOrderPayload(
            status = "PENDING",
            items = listOf(
                ClientOrderItemPayload(productId = "px", productName = "Producto Caro", quantity = 1, unitPrice = 200.0, subtotal = 200.0)
            ),
            total = 200.0
        )

        val result = detector.checkUnusualAmount(business, expensiveOrder)
        assertNotNull(result)
        assertEquals(AnomalyType.UNUSUAL_AMOUNT, result.type)
        assertEquals(AnomalySeverity.MEDIUM, result.severity)
    }

    @Test
    fun `no detecta monto inusual cuando hay pocos pedidos para calcular promedio`() {
        val business = "nueva-tienda"

        // Solo 2 pedidos (menos que el mínimo de 3)
        repeat(2) { i ->
            orderRepository.createOrder(business, "user$i@test.com", ClientOrderPayload(
                status = "DELIVERED",
                items = listOf(
                    ClientOrderItemPayload(productId = "p1", productName = "Producto", quantity = 1, unitPrice = 10.0, subtotal = 10.0)
                ),
                total = 10.0
            ))
        }

        val expensiveOrder = ClientOrderPayload(
            status = "PENDING",
            items = listOf(
                ClientOrderItemPayload(productId = "px", productName = "Producto Caro", quantity = 1, unitPrice = 500.0, subtotal = 500.0)
            ),
            total = 500.0
        )

        val result = detector.checkUnusualAmount(business, expensiveOrder)
        assertNull(result)
    }

    @Test
    fun `no detecta monto inusual cuando monto esta dentro del rango`() {
        val business = "tienda"

        repeat(5) { i ->
            orderRepository.createOrder(business, "user$i@test.com", ClientOrderPayload(
                status = "DELIVERED",
                items = listOf(
                    ClientOrderItemPayload(productId = "p1", productName = "Producto", quantity = 1, unitPrice = 100.0, subtotal = 100.0)
                ),
                total = 100.0
            ))
        }

        // $250 < 3x$100 = $300 → no debería flaggear
        val normalOrder = ClientOrderPayload(
            status = "PENDING",
            items = listOf(
                ClientOrderItemPayload(productId = "px", productName = "Producto", quantity = 1, unitPrice = 250.0, subtotal = 250.0)
            ),
            total = 250.0
        )

        val result = detector.checkUnusualAmount(business, normalOrder)
        assertNull(result)
    }

    // --- Dirección sospechosa ---

    @Test
    fun `detecta dirección sospechosa cuando multiples cuentas usan la misma`() {
        val business = "tienda"
        val sharedAddress = ClientAddressPayload(
            street = "Av. Corrientes",
            number = "1234",
            city = "Buenos Aires"
        )

        // Dos cuentas distintas con la misma dirección
        orderRepository.createOrder(business, "user1@test.com", ClientOrderPayload(
            status = "DELIVERED",
            items = listOf(ClientOrderItemPayload(productId = "p1", productName = "P1", quantity = 1, unitPrice = 10.0, subtotal = 10.0)),
            total = 10.0,
            deliveryAddress = sharedAddress
        ))
        orderRepository.createOrder(business, "user2@test.com", ClientOrderPayload(
            status = "DELIVERED",
            items = listOf(ClientOrderItemPayload(productId = "p2", productName = "P2", quantity = 1, unitPrice = 20.0, subtotal = 20.0)),
            total = 20.0,
            deliveryAddress = sharedAddress
        ))

        // Tercera cuenta en la misma dirección
        val newOrder = ClientOrderPayload(
            status = "PENDING",
            items = listOf(ClientOrderItemPayload(productId = "p3", productName = "P3", quantity = 1, unitPrice = 15.0, subtotal = 15.0)),
            total = 15.0,
            deliveryAddress = sharedAddress
        )

        val result = detector.checkSuspiciousAddress(business, "user3@test.com", newOrder)
        assertNotNull(result)
        assertEquals(AnomalyType.SUSPICIOUS_ADDRESS, result.type)
    }

    @Test
    fun `no detecta dirección sospechosa cuando solo una cuenta la usa`() {
        val business = "tienda"
        val address = ClientAddressPayload(
            street = "Av. Unica",
            number = "999",
            city = "Rosario"
        )

        orderRepository.createOrder(business, "user1@test.com", ClientOrderPayload(
            status = "DELIVERED",
            items = listOf(ClientOrderItemPayload(productId = "p1", productName = "P1", quantity = 1, unitPrice = 10.0, subtotal = 10.0)),
            total = 10.0,
            deliveryAddress = address
        ))

        val newOrder = ClientOrderPayload(
            status = "PENDING",
            items = listOf(ClientOrderItemPayload(productId = "p2", productName = "P2", quantity = 1, unitPrice = 20.0, subtotal = 20.0)),
            total = 20.0,
            deliveryAddress = address
        )

        val result = detector.checkSuspiciousAddress(business, "user2@test.com", newOrder)
        assertNull(result)
    }

    @Test
    fun `no detecta dirección sospechosa cuando el pedido no tiene dirección`() {
        val newOrder = ClientOrderPayload(
            status = "PENDING",
            items = listOf(ClientOrderItemPayload(productId = "p1", productName = "P1", quantity = 1, unitPrice = 10.0, subtotal = 10.0)),
            total = 10.0,
            deliveryAddress = null
        )

        val result = detector.checkSuspiciousAddress("tienda", "user@test.com", newOrder)
        assertNull(result)
    }

    // --- Evaluación completa ---

    @Test
    fun `evaluate registra anomalías en el repositorio`() {
        val email = "user@test.com"
        val business = "tienda"

        // Crear pedido existente para disparar duplicado
        orderRepository.createOrder(business, email, ClientOrderPayload(
            status = "PENDING",
            items = listOf(
                ClientOrderItemPayload(productId = "p1", productName = "Producto 1", quantity = 1, unitPrice = 10.0, subtotal = 10.0)
            ),
            total = 10.0
        ))

        val newOrder = ClientOrderPayload(
            id = "order-test-id",
            status = "PENDING",
            items = listOf(
                ClientOrderItemPayload(productId = "p1", productName = "Producto 1", quantity = 1, unitPrice = 10.0, subtotal = 10.0)
            ),
            total = 10.0
        )

        val anomalies = detector.evaluate(business, email, newOrder)
        assertTrue(anomalies.isNotEmpty())

        val recorded = anomalyRepository.listByBusiness(business)
        assertTrue(recorded.isNotEmpty())
        assertEquals(email, recorded.first().email)
    }

    @Test
    fun `evaluate retorna lista vacía cuando no hay anomalías`() {
        val newOrder = ClientOrderPayload(
            status = "PENDING",
            items = listOf(
                ClientOrderItemPayload(productId = "p1", productName = "Producto", quantity = 1, unitPrice = 10.0, subtotal = 10.0)
            ),
            total = 10.0
        )

        val anomalies = detector.evaluate("tienda-nueva", "nuevo@test.com", newOrder)
        assertTrue(anomalies.isEmpty())
    }
}
