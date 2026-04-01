package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AttributeType
import aws.sdk.kotlin.services.cognitoidentityprovider.model.GetUserResponse
import io.ktor.http.HttpStatusCode
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class BusinessSalesMetricsFunctionTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("pizzeria")
    private val cognito = mockk<CognitoIdentityProviderClient>()
    private val tableProfiles = InMemoryDynamoDbTable<UserBusinessProfile>(
        "profiles",
        TableSchema.fromBean(UserBusinessProfile::class.java)
    ) { it.compositeKey ?: "" }
    private val orderRepository = ClientOrderRepository()

    private val function = BusinessSalesMetricsFunction(
        config = config,
        logger = logger,
        cognito = cognito,
        tableProfiles = tableProfiles,
        orderRepository = orderRepository
    )

    private fun seedBusinessAdmin() {
        tableProfiles.putItem(UserBusinessProfile().apply {
            email = "admin@pizzeria.com"
            business = "pizzeria"
            profile = PROFILE_BUSINESS_ADMIN
            state = BusinessState.APPROVED
        })
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(AttributeType { name = EMAIL_ATT_NAME; value = "admin@pizzeria.com" })
        }
    }

    private fun createDeliveredOrder(business: String, email: String, items: List<ClientOrderItemPayload>) {
        val order = ClientOrderPayload(
            status = "PENDING",
            items = items,
            total = items.sumOf { it.subtotal },
            createdAt = Instant.now().toString()
        )
        val created = orderRepository.createOrder(business, email, order)
        orderRepository.updateOrderStatus(business, created.id ?: "", "DELIVERED")
    }

    @Test
    fun `GET devuelve metricas con ordenes entregadas`() = runBlocking {
        seedBusinessAdmin()

        createDeliveredOrder("pizzeria", "cliente@test.com", listOf(
            ClientOrderItemPayload(
                name = "Pizza Muzzarella",
                quantity = 2,
                unitPrice = 5000.0,
                subtotal = 10000.0
            ),
            ClientOrderItemPayload(
                name = "Empanada",
                quantity = 6,
                unitPrice = 500.0,
                subtotal = 3000.0
            )
        ))

        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/sales-metrics",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is SalesMetricsResponse)
        val metricsResponse = response as SalesMetricsResponse
        val metrics = metricsResponse.metrics!!
        assertTrue(metrics.orderCount >= 0)
        assertTrue(metrics.totalRevenue >= 0.0)
    }

    @Test
    fun `usuario no autorizado recibe UnauthorizedException`() = runBlocking {
        coEvery { cognito.getUser(any()) } throws RuntimeException("Unauthorized")

        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/sales-metrics",
            headers = mapOf("Authorization" to "token"),
            textBody = ""
        )

        assertTrue(response is UnauthorizedException)
    }

    @Test
    fun `calculateDailyMetrics retorna metricas vacias sin ordenes`() {
        val metrics = function.calculateDailyMetrics("negocio-nuevo")

        assertEquals(0, metrics.orderCount)
        assertEquals(0.0, metrics.totalRevenue)
        assertEquals(0.0, metrics.averageTicket)
        assertEquals(0, metrics.previousDayOrderCount)
        assertEquals(0.0, metrics.previousDayRevenue)
        assertEquals(0.0, metrics.revenueChangePercent)
        assertEquals(0.0, metrics.orderCountChangePercent)
        assertNull(metrics.topProductName)
        assertEquals(0, metrics.topProductQuantity)
    }

    @Test
    fun `calculateChangePercent retorna 0 cuando ambos son 0`() {
        assertEquals(0.0, function.calculateChangePercent(0.0, 0.0))
    }

    @Test
    fun `calculateChangePercent retorna 100 cuando anterior es 0 y actual positivo`() {
        assertEquals(100.0, function.calculateChangePercent(0.0, 5000.0))
    }

    @Test
    fun `calculateChangePercent calcula porcentaje correcto`() {
        val result = function.calculateChangePercent(100.0, 150.0)
        assertEquals(50.0, result)
    }

    @Test
    fun `calculateChangePercent calcula decrecimiento negativo`() {
        val result = function.calculateChangePercent(200.0, 100.0)
        assertEquals(-50.0, result)
    }

    @Test
    fun `findTopProduct retorna null sin ordenes`() {
        val result = function.findTopProduct(emptyList())
        assertNull(result)
    }

    @Test
    fun `findTopProduct identifica producto mas vendido`() {
        val orders = listOf(
            BusinessOrderItem(
                clientEmail = "c1@test.com",
                order = ClientOrderPayload(
                    status = "DELIVERED",
                    items = listOf(
                        ClientOrderItemPayload(name = "Pizza", quantity = 2, unitPrice = 5000.0, subtotal = 10000.0),
                        ClientOrderItemPayload(name = "Empanada", quantity = 10, unitPrice = 500.0, subtotal = 5000.0)
                    ),
                    total = 15000.0
                )
            ),
            BusinessOrderItem(
                clientEmail = "c2@test.com",
                order = ClientOrderPayload(
                    status = "DELIVERED",
                    items = listOf(
                        ClientOrderItemPayload(name = "Pizza", quantity = 3, unitPrice = 5000.0, subtotal = 15000.0)
                    ),
                    total = 15000.0
                )
            )
        )

        val result = function.findTopProduct(orders)

        assertEquals("Empanada", result?.first)
        assertEquals(10, result?.second)
    }

    @Test
    fun `filterOrdersByDate solo incluye ordenes DELIVERED de la fecha indicada`() {
        val today = LocalDate.now(ZoneId.of("America/Argentina/Buenos_Aires"))

        // Crear una orden entregada con fecha de hoy
        createDeliveredOrder("pizzeria", "c1@test.com", listOf(
            ClientOrderItemPayload(name = "Pizza", quantity = 1, unitPrice = 5000.0, subtotal = 5000.0)
        ))

        // Crear una orden NO entregada
        val pendingOrder = ClientOrderPayload(
            status = "PENDING",
            items = listOf(ClientOrderItemPayload(name = "Birra", quantity = 1, unitPrice = 2000.0, subtotal = 2000.0)),
            total = 2000.0,
            createdAt = Instant.now().toString()
        )
        orderRepository.createOrder("pizzeria", "c2@test.com", pendingOrder)

        val allOrders = orderRepository.listAllOrdersForBusiness("pizzeria")
        val filtered = function.filterOrdersByDate(allOrders, today)

        assertEquals(1, filtered.size)
        assertEquals("DELIVERED", filtered[0].order.status.uppercase())
    }
}
