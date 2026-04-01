package ar.com.intrale

import kotlinx.coroutines.runBlocking
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Implementacion fake del servicio de envio de mensajes para tests.
 */
class FakeMessageDeliveryService(
    private val shouldSucceed: Boolean = true
) : MessageDeliveryService {
    val sentMessages = mutableListOf<Pair<String, String>>()

    override suspend fun sendMessage(contactId: String, text: String): Boolean {
        sentMessages.add(Pair(contactId, text))
        return shouldSucceed
    }
}

class WeeklyReportServiceTest {

    private val fakeAiService = object : AiResponseService {
        override suspend fun generateResponse(context: BusinessContext, customerQuestion: String): AiResponseResult {
            return AiResponseResult(answer = "respuesta de IA", confidence = 0.9, escalated = false)
        }
    }

    private val fakeTelegram = FakeMessageDeliveryService()
    private val fakeWhatsApp = FakeMessageDeliveryService()

    private val service = DefaultWeeklyReportService(fakeAiService, fakeTelegram, fakeWhatsApp)

    private fun createOrder(
        total: Double,
        daysAgo: Long,
        items: List<ClientOrderItemPayload> = emptyList()
    ): BusinessOrderItem {
        val createdAt = Instant.now().minus(daysAgo, ChronoUnit.DAYS).toString()
        return BusinessOrderItem(
            clientEmail = "cliente@test.com",
            order = ClientOrderPayload(
                id = java.util.UUID.randomUUID().toString(),
                total = total,
                status = "DELIVERED",
                items = items,
                createdAt = createdAt,
                updatedAt = createdAt
            )
        )
    }

    private fun createItem(name: String, quantity: Int, unitPrice: Double): ClientOrderItemPayload {
        return ClientOrderItemPayload(
            id = java.util.UUID.randomUUID().toString(),
            name = name,
            productName = name,
            quantity = quantity,
            unitPrice = unitPrice,
            subtotal = quantity * unitPrice
        )
    }

    @Test
    fun `calculateMetrics calcula correctamente con ordenes de esta semana`() {
        val thisWeekOrders = listOf(
            createOrder(100.0, 1, listOf(createItem("Pizza", 2, 50.0))),
            createOrder(200.0, 2, listOf(createItem("Empanadas", 10, 20.0))),
            createOrder(150.0, 3, listOf(createItem("Pizza", 1, 50.0), createItem("Cerveza", 5, 20.0)))
        )
        val prevWeekOrders = listOf(
            createOrder(80.0, 8),
            createOrder(120.0, 10)
        )

        val metrics = service.calculateMetrics(thisWeekOrders, prevWeekOrders)

        assertEquals(450.0, metrics.totalRevenue)
        assertEquals(3, metrics.orderCount)
        assertEquals(150.0, metrics.averageTicket)
        assertEquals(200.0, metrics.previousWeekRevenue)
        assertEquals(2, metrics.previousWeekOrderCount)
        assertEquals(125.0, metrics.revenueChangePercent) // (450-200)/200*100
        assertEquals(50.0, metrics.orderCountChangePercent) // (3-2)/2*100
        assertTrue(metrics.topProducts.isNotEmpty())
    }

    @Test
    fun `calculateMetrics maneja lista vacia de ordenes`() {
        val metrics = service.calculateMetrics(emptyList(), emptyList())

        assertEquals(0.0, metrics.totalRevenue)
        assertEquals(0, metrics.orderCount)
        assertEquals(0.0, metrics.averageTicket)
        assertEquals(0.0, metrics.revenueChangePercent)
        assertTrue(metrics.topProducts.isEmpty())
    }

    @Test
    fun `calculateMetrics calcula top 5 productos correctamente`() {
        val orders = listOf(
            createOrder(100.0, 1, listOf(
                createItem("Pizza", 10, 10.0),
                createItem("Empanadas", 8, 5.0),
                createItem("Cerveza", 6, 8.0),
                createItem("Agua", 4, 3.0),
                createItem("Postre", 3, 15.0),
                createItem("Cafe", 1, 5.0)
            ))
        )

        val metrics = service.calculateMetrics(orders, emptyList())

        assertEquals(5, metrics.topProducts.size)
        assertEquals("Pizza", metrics.topProducts[0].name)
        assertEquals(10, metrics.topProducts[0].quantity)
        assertEquals("Empanadas", metrics.topProducts[1].name)
    }

    @Test
    fun `buildFallbackReport genera reporte con formato HTML`() {
        val metrics = WeeklyMetrics(
            totalRevenue = 1500.0,
            orderCount = 25,
            averageTicket = 60.0,
            previousWeekRevenue = 1200.0,
            previousWeekOrderCount = 20,
            revenueChangePercent = 25.0,
            orderCountChangePercent = 25.0,
            topProducts = listOf(
                TopProduct("Pizza", 15, 750.0),
                TopProduct("Empanadas", 10, 200.0)
            )
        )

        val report = service.buildFallbackReport("MiNegocio", metrics)

        assertTrue(report.contains("<b>Reporte Semanal"))
        assertTrue(report.contains("MiNegocio"))
        assertTrue(report.contains("1500"))
        assertTrue(report.contains("25"))
        assertTrue(report.contains("Pizza"))
        assertTrue(report.contains("Empanadas"))
        assertTrue(report.contains("href="))
    }

    @Test
    fun `generateReport envia por Telegram cuando esta configurado`() = runBlocking {
        val business = Business().apply {
            name = "biz"
            weeklyReportEnabled = true
            weeklyReportContactType = "telegram"
            weeklyReportContactId = "123456789"
        }

        val orders = listOf(
            createOrder(100.0, 1, listOf(createItem("Pizza", 2, 50.0)))
        )

        val result = service.generateReport(business, "biz", orders)

        assertTrue(result.sent)
        assertEquals("telegram:123456789", result.sentTo)
        assertEquals(1, fakeTelegram.sentMessages.size)
        assertEquals("123456789", fakeTelegram.sentMessages[0].first)
    }

    @Test
    fun `generateReport no envia cuando reportes estan desactivados`() = runBlocking {
        val business = Business().apply {
            name = "biz"
            weeklyReportEnabled = false
        }

        val result = service.generateReport(business, "biz", emptyList())

        assertFalse(result.sent)
        assertEquals(0, fakeTelegram.sentMessages.size)
    }

    @Test
    fun `generateReport no envia cuando contactId esta vacio`() = runBlocking {
        val business = Business().apply {
            name = "biz"
            weeklyReportEnabled = true
            weeklyReportContactType = "telegram"
            weeklyReportContactId = null
        }

        val result = service.generateReport(business, "biz", emptyList())

        assertFalse(result.sent)
    }
}
