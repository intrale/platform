package ar.com.intrale

import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ClientOrdersAnomalyIntegrationTest {

    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")
    private val repository = ClientOrderRepository()
    private val anomalyRepository = OrderAnomalyRepository()
    private val anomalyConfig = AnomalyDetectionConfig()
    private val detector = OrderAnomalyDetector(repository, anomalyRepository, anomalyConfig)
    private val validator = LocalJwtValidator()

    @Test
    fun `crear pedido normal no queda flaggeado`() = runBlocking {
        val function = ClientOrders(config, logger, repository, validator, detector)
        val email = "client@test.com"

        val response = function.securedExecute(
            business = "biz",
            function = "client/orders",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "POST"
            ),
            textBody = """{"items": [{"productId": "p1", "productName": "Producto 1", "quantity": 1, "unitPrice": 10.0}]}"""
        )

        assertEquals(HttpStatusCode.Created, response.statusCode)
        assertTrue(response is CreateOrderAnomalyResponse)
        assertFalse((response as CreateOrderAnomalyResponse).flagged)
        assertTrue(response.anomalies.isEmpty())
    }

    @Test
    fun `crear pedido duplicado queda flaggeado con estado FLAGGED`() = runBlocking {
        val function = ClientOrders(config, logger, repository, validator, detector)
        val email = "client@test.com"

        // Primer pedido
        function.securedExecute(
            business = "biz",
            function = "client/orders",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "POST"
            ),
            textBody = """{"items": [{"productId": "p1", "productName": "Producto 1", "quantity": 1, "unitPrice": 10.0}]}"""
        )

        // Segundo pedido idéntico → debería ser flaggeado
        val response = function.securedExecute(
            business = "biz",
            function = "client/orders",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "POST"
            ),
            textBody = """{"items": [{"productId": "p1", "productName": "Producto 1", "quantity": 1, "unitPrice": 10.0}]}"""
        )

        assertEquals(HttpStatusCode.Created, response.statusCode)
        assertTrue(response is CreateOrderAnomalyResponse)
        assertTrue((response as CreateOrderAnomalyResponse).flagged)
        assertTrue(response.anomalies.any { it.type == "DUPLICATE_ORDER" })

        // Verificar que el pedido quedó con estado FLAGGED
        val orders = repository.listOrders("biz", email)
        assertTrue(orders.any { it.status == "FLAGGED" })
    }

    @Test
    fun `crear pedido sin detector de anomalías funciona normalmente`() = runBlocking {
        // Sin anomalyDetector (backward compatibility)
        val function = ClientOrders(config, logger, repository, validator, null)
        val email = "client@test.com"

        val response = function.securedExecute(
            business = "biz",
            function = "client/orders",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "POST"
            ),
            textBody = """{"items": [{"productId": "p1", "productName": "Producto 1", "quantity": 1, "unitPrice": 10.0}]}"""
        )

        assertEquals(HttpStatusCode.Created, response.statusCode)
        assertTrue(response is CreateOrderAnomalyResponse)
        assertFalse((response as CreateOrderAnomalyResponse).flagged)
    }
}
