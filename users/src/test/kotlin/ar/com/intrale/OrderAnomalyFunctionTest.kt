package ar.com.intrale

import com.google.gson.Gson
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class OrderAnomalyFunctionTest {

    private val logger = NOPLogger.NOP_LOGGER
    private val orderRepository = ClientOrderRepository()
    private val anomalyRepository = AnomalyRepository()
    private val detectionService = OrderAnomalyDetectionService(orderRepository, logger)
    private val gson = Gson()
    private val config = testConfig("pizzeria")
    private val validator = LocalJwtValidator()

    private val function = OrderAnomalyFunction(
        config = config,
        logger = logger,
        detectionService = detectionService,
        anomalyRepository = anomalyRepository,
        orderRepository = orderRepository,
        jwtValidator = validator
    )

    private val email = "admin@pizzeria.com"

    private fun createTestOrder(business: String, clientEmail: String, total: Double = 1000.0): ClientOrderPayload {
        val items = listOf(
            ClientOrderItemPayload(
                productId = "prod-1", productName = "Pizza", name = "Pizza",
                quantity = 1, unitPrice = total, subtotal = total
            )
        )
        val payload = ClientOrderPayload(
            status = "PENDING",
            items = items,
            total = total,
            businessName = business
        )
        return orderRepository.createOrder(business, clientEmail, payload)
    }

    @Test
    fun `POST analyze con pedido valido retorna analisis`() = runBlocking {
        val order = createTestOrder("pizzeria", "user@test.com")

        val body = AnalyzeOrderRequest(orderId = order.id!!, clientEmail = "user@test.com")
        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/anomalies/analyze",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "POST"
            ),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is AnomalyAnalysisResponse)
        val analysis = response as AnomalyAnalysisResponse
        assertEquals(order.id, analysis.orderId)
    }

    @Test
    fun `POST analyze con orderId vacio retorna error de validacion`() = runBlocking {
        val body = AnalyzeOrderRequest(orderId = "", clientEmail = "user@test.com")
        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/anomalies/analyze",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "POST"
            ),
            textBody = gson.toJson(body)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST analyze con pedido inexistente retorna NotFound`() = runBlocking {
        val body = AnalyzeOrderRequest(orderId = "no-existe", clientEmail = "user@test.com")
        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/anomalies/analyze",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "POST"
            ),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.NotFound, response.statusCode)
    }

    @Test
    fun `GET lista pedidos flaggeados pendientes`() = runBlocking {
        anomalyRepository.save(
            AnomalyRecord(
                orderId = "order-1",
                shortCode = "ABC123",
                clientEmail = "user@test.com",
                business = "pizzeria",
                total = 50000.0,
                anomalies = listOf(
                    DetectedAnomaly(AnomalyType.UNUSUAL_AMOUNT, AnomalySeverity.HIGH, "Monto inusual", 0.9)
                ),
                flaggedAt = java.time.Instant.now().toString()
            )
        )

        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/anomalies",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is FlaggedOrdersResponse)
        val flagged = response as FlaggedOrdersResponse
        assertEquals(1, flagged.totalFlagged)
        assertEquals("order-1", flagged.orders.first().orderId)
    }

    @Test
    fun `GET history retorna historial completo`() = runBlocking {
        anomalyRepository.save(
            AnomalyRecord(
                orderId = "order-old",
                clientEmail = "old@test.com",
                business = "pizzeria",
                total = 30000.0,
                anomalies = listOf(
                    DetectedAnomaly(AnomalyType.DUPLICATE_ORDER, AnomalySeverity.HIGH, "Duplicado", 0.9)
                ),
                flaggedAt = java.time.Instant.now().toString(),
                resolved = true,
                resolution = "approve: Verificado por el negocio"
            )
        )

        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/anomalies/history",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is AnomalyHistoryResponse)
        val history = response as AnomalyHistoryResponse
        assertTrue(history.history.isNotEmpty())
    }

    @Test
    fun `GET config retorna configuracion por defecto`() = runBlocking {
        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/anomalies/config",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is AnomalyConfigResponse)
        val configResp = response as AnomalyConfigResponse
        assertEquals(5L, configResp.config.duplicateWindowMinutes)
        assertEquals(3.0, configResp.config.amountThresholdMultiplier)
    }

    @Test
    fun `PUT config actualiza configuracion de sensibilidad`() = runBlocking {
        val updateBody = UpdateAnomalyConfigRequest(
            duplicateWindowMinutes = 10,
            amountThresholdMultiplier = 5.0,
            maxOrdersPerHour = 10,
            flagThreshold = 0.7
        )

        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/anomalies/config",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "PUT"
            ),
            textBody = gson.toJson(updateBody)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is AnomalyConfigResponse)
        val configResp = response as AnomalyConfigResponse
        assertEquals(10L, configResp.config.duplicateWindowMinutes)
        assertEquals(5.0, configResp.config.amountThresholdMultiplier)
    }

    @Test
    fun `PUT config con valores fuera de rango retorna error`() = runBlocking {
        val invalidBody = UpdateAnomalyConfigRequest(
            duplicateWindowMinutes = 100
        )

        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/anomalies/config",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "PUT"
            ),
            textBody = gson.toJson(invalidBody)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `PUT resolve aprueba un pedido flaggeado`() = runBlocking {
        anomalyRepository.save(
            AnomalyRecord(
                orderId = "order-flag",
                clientEmail = "user@test.com",
                business = "pizzeria",
                total = 50000.0,
                anomalies = listOf(
                    DetectedAnomaly(AnomalyType.UNUSUAL_AMOUNT, AnomalySeverity.HIGH, "Monto alto", 0.9)
                ),
                flaggedAt = java.time.Instant.now().toString()
            )
        )

        val resolveBody = ResolveAnomalyRequest(
            orderId = "order-flag",
            action = "approve",
            reason = "Pedido verificado telefonicamente"
        )

        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/anomalies/resolve",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "PUT"
            ),
            textBody = gson.toJson(resolveBody)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is ResolveAnomalyResponse)
        val resolve = response as ResolveAnomalyResponse
        assertEquals("approve", resolve.action)
        assertEquals("Pedido aprobado manualmente", resolve.message)

        val record = anomalyRepository.findByOrderId("pizzeria", "order-flag")
        assertTrue(record!!.resolved)
    }

    @Test
    fun `PUT resolve con action invalida retorna error`() = runBlocking {
        val resolveBody = ResolveAnomalyRequest(
            orderId = "order-flag",
            action = "invalid"
        )

        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/anomalies/resolve",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "PUT"
            ),
            textBody = gson.toJson(resolveBody)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `PUT resolve a anomalia ya resuelta retorna error`() = runBlocking {
        anomalyRepository.save(
            AnomalyRecord(
                orderId = "order-resolved",
                clientEmail = "user@test.com",
                business = "pizzeria",
                total = 50000.0,
                anomalies = emptyList(),
                flaggedAt = java.time.Instant.now().toString(),
                resolved = true,
                resolution = "approve: Ya aprobado"
            )
        )

        val resolveBody = ResolveAnomalyRequest(
            orderId = "order-resolved",
            action = "approve"
        )

        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/anomalies/resolve",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "PUT"
            ),
            textBody = gson.toJson(resolveBody)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST analyze pedido duplicado genera flaggeo y se registra en repositorio`() = runBlocking {
        val items = listOf(
            ClientOrderItemPayload(
                productId = "prod-1", productName = "Pizza", name = "Pizza",
                quantity = 2, unitPrice = 1000.0, subtotal = 2000.0
            )
        )
        val payload = ClientOrderPayload(status = "PENDING", items = items, total = 2000.0, businessName = "pizzeria")
        orderRepository.createOrder("pizzeria", "user@test.com", payload)
        val duplicate = orderRepository.createOrder("pizzeria", "user@test.com", payload)

        val body = AnalyzeOrderRequest(orderId = duplicate.id!!, clientEmail = "user@test.com")
        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/anomalies/analyze",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "POST"
            ),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val analysis = response as AnomalyAnalysisResponse
        assertTrue(analysis.flagged)
        assertTrue(analysis.anomalies.any { it.type == "DUPLICATE_ORDER" })

        val saved = anomalyRepository.findByOrderId("pizzeria", duplicate.id!!)
        assertTrue(saved != null)
        assertFalse(saved.resolved)
    }
}
