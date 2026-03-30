package ar.com.intrale

import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class BusinessSalesMetricsFunctionTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("pizzeria")
    private val validator = LocalJwtValidator()
    private val zoneId = ZoneId.of("America/Argentina/Buenos_Aires")

    private fun todayInstant(hour: Int = 12): String {
        val today = LocalDate.now(zoneId)
        return ZonedDateTime.of(today.year, today.monthValue, today.dayOfMonth, hour, 0, 0, 0, zoneId)
            .toInstant().toString()
    }

    private fun yesterdayInstant(hour: Int = 12): String {
        val yesterday = LocalDate.now(zoneId).minusDays(1)
        return ZonedDateTime.of(yesterday.year, yesterday.monthValue, yesterday.dayOfMonth, hour, 0, 0, 0, zoneId)
            .toInstant().toString()
    }

    private fun createFunction(repository: ClientOrderRepository): BusinessSalesMetricsFunction =
        BusinessSalesMetricsFunction(config, logger, repository, validator)

    private fun executeMetrics(function: BusinessSalesMetricsFunction): Response = runBlocking {
        function.securedExecute(
            business = "pizzeria",
            function = "business/sales-metrics",
            headers = mapOf(
                "Authorization" to validator.generateToken("admin@pizzeria.com"),
                "X-Http-Method" to "GET"
            ),
            textBody = ""
        )
    }

    /**
     * Helper: crea un pedido DELIVERED con timestamp específico.
     */
    private fun createDeliveredOrder(
        repository: ClientOrderRepository,
        business: String = "pizzeria",
        email: String = "cliente@test.com",
        total: Double = 1000.0,
        createdAt: String = todayInstant(),
        items: List<ClientOrderItemPayload> = emptyList()
    ) {
        val created = FakeOrderHelper.createOrderWithTimestamp(
            repository = repository,
            business = business,
            email = email,
            payload = ClientOrderPayload(status = "PENDING", total = total, items = items),
            createdAt = createdAt
        )
        repository.updateOrderStatus(business, created.id!!, "DELIVERED")
    }

    @Test
    fun `retorna métricas vacías cuando no hay pedidos`() {
        val repository = ClientOrderRepository()
        val function = createFunction(repository)
        val response = executeMetrics(function)

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is DailySalesMetricsResponse)
        val metrics = response as DailySalesMetricsResponse
        assertEquals(0, metrics.orderCount)
        assertEquals(0.0, metrics.totalRevenue)
        assertEquals(0.0, metrics.averageTicket)
        assertNull(metrics.topProductName)
    }

    @Test
    fun `solo cuenta pedidos con estado DELIVERED del día`() {
        val repository = ClientOrderRepository()
        val function = createFunction(repository)

        // Pedido DELIVERED hoy
        createDeliveredOrder(repository, total = 1000.0, createdAt = todayInstant(10))

        // Pedido PENDING hoy (no debería contar)
        FakeOrderHelper.createOrderWithTimestamp(
            repository, "pizzeria", "b@test.com",
            ClientOrderPayload(status = "PENDING", total = 2000.0),
            createdAt = todayInstant(11)
        )

        val response = executeMetrics(function)
        val metrics = response as DailySalesMetricsResponse
        assertEquals(1, metrics.orderCount)
        assertEquals(1000.0, metrics.totalRevenue)
        assertEquals(1000.0, metrics.averageTicket)
    }

    @Test
    fun `calcula ticket promedio correctamente con múltiples pedidos`() {
        val repository = ClientOrderRepository()
        val function = createFunction(repository)

        createDeliveredOrder(repository, email = "a@test.com", total = 1500.0, createdAt = todayInstant(10))
        createDeliveredOrder(repository, email = "b@test.com", total = 2500.0, createdAt = todayInstant(11))

        val response = executeMetrics(function)
        val metrics = response as DailySalesMetricsResponse
        assertEquals(2, metrics.orderCount)
        assertEquals(4000.0, metrics.totalRevenue)
        assertEquals(2000.0, metrics.averageTicket)
    }

    @Test
    fun `calcula comparación porcentual con el día anterior`() {
        val repository = ClientOrderRepository()
        val function = createFunction(repository)

        // Pedido de ayer
        createDeliveredOrder(repository, email = "d@test.com", total = 1000.0, createdAt = yesterdayInstant())

        // Pedido de hoy con el doble
        createDeliveredOrder(repository, email = "e@test.com", total = 2000.0, createdAt = todayInstant())

        val response = executeMetrics(function)
        val metrics = response as DailySalesMetricsResponse
        assertEquals(1, metrics.orderCount)
        assertEquals(2000.0, metrics.totalRevenue)
        assertEquals(1, metrics.previousDayOrderCount)
        assertEquals(1000.0, metrics.previousDayRevenue)
        assertEquals(100.0, metrics.revenueChangePercent)
    }

    @Test
    fun `identifica el producto más vendido del día por cantidad`() {
        val repository = ClientOrderRepository()
        val function = createFunction(repository)

        createDeliveredOrder(
            repository, total = 3000.0, createdAt = todayInstant(),
            items = listOf(
                ClientOrderItemPayload(name = "Pizza Muzzarella", quantity = 3, unitPrice = 500.0, subtotal = 1500.0),
                ClientOrderItemPayload(name = "Empanadas", quantity = 6, unitPrice = 250.0, subtotal = 1500.0)
            )
        )

        val response = executeMetrics(function)
        val metrics = response as DailySalesMetricsResponse
        assertEquals("Empanadas", metrics.topProductName)
        assertEquals(6, metrics.topProductQuantity)
    }

    @Test
    fun `no mezcla pedidos de otros negocios`() {
        val repository = ClientOrderRepository()
        val function = createFunction(repository)

        // Pedido DELIVERED de otro negocio
        createDeliveredOrder(repository, business = "heladeria", total = 5000.0, createdAt = todayInstant())

        val response = executeMetrics(function)
        val metrics = response as DailySalesMetricsResponse
        assertEquals(0, metrics.orderCount)
        assertEquals(0.0, metrics.totalRevenue)
    }

    @Test
    fun `variación es 100 porciento cuando ayer no hubo ventas y hoy sí`() {
        val repository = ClientOrderRepository()
        val function = createFunction(repository)

        createDeliveredOrder(repository, total = 1000.0, createdAt = todayInstant())

        val response = executeMetrics(function)
        val metrics = response as DailySalesMetricsResponse
        assertEquals(100.0, metrics.revenueChangePercent)
        assertEquals(100.0, metrics.orderCountChangePercent)
        assertEquals(0, metrics.previousDayOrderCount)
    }

    @Test
    fun `variación es 0 cuando no hay ventas ni hoy ni ayer`() {
        val repository = ClientOrderRepository()
        val function = createFunction(repository)

        val response = executeMetrics(function)
        val metrics = response as DailySalesMetricsResponse
        assertEquals(0.0, metrics.revenueChangePercent)
        assertEquals(0.0, metrics.orderCountChangePercent)
    }
}
