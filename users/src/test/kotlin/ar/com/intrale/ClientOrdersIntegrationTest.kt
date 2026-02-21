package ar.com.intrale

import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ClientOrdersIntegrationTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")
    private val repository = ClientOrderRepository()
    private val validator = LocalJwtValidator()

    @Test
    fun `listar pedidos retorna lista vacía cuando no hay pedidos`() = runBlocking {
        val function = ClientOrders(config, logger, repository, validator)
        val email = "client@test.com"

        val response = function.securedExecute(
            business = "biz",
            function = "client/orders",
            headers = mapOf("Authorization" to validator.generateToken(email)),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is ClientOrderListResponse)
        assertEquals(0, (response as ClientOrderListResponse).orders.size)
    }

    @Test
    fun `listar pedidos retorna los pedidos del cliente`() = runBlocking {
        val function = ClientOrders(config, logger, repository, validator)
        val email = "client@test.com"

        repository.createOrder("biz", email, ClientOrderPayload(
            status = "pending",
            items = listOf(ClientOrderItemPayload(productId = "p1", productName = "Producto 1", quantity = 2, unitPrice = 10.0, subtotal = 20.0)),
            total = 20.0
        ))
        repository.createOrder("biz", email, ClientOrderPayload(
            status = "delivered",
            items = listOf(ClientOrderItemPayload(productId = "p2", productName = "Producto 2", quantity = 1, unitPrice = 50.0, subtotal = 50.0)),
            total = 50.0
        ))

        val response = function.securedExecute(
            business = "biz",
            function = "client/orders",
            headers = mapOf("Authorization" to validator.generateToken(email)),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is ClientOrderListResponse)
        assertEquals(2, (response as ClientOrderListResponse).orders.size)
    }

    @Test
    fun `listar pedidos sin token retorna no autorizado`() = runBlocking {
        val function = ClientOrders(config, logger, repository, validator)

        val response = function.securedExecute(
            business = "biz",
            function = "client/orders",
            headers = emptyMap(),
            textBody = ""
        )

        assertEquals(HttpStatusCode.Unauthorized, response.statusCode)
    }

    @Test
    fun `pedidos de un negocio no se mezclan con otro`() = runBlocking {
        val function = ClientOrders(config, logger, repository, validator)
        val email = "client@test.com"

        repository.createOrder("biz-a", email, ClientOrderPayload(
            status = "pending",
            items = listOf(ClientOrderItemPayload(productId = "p1", productName = "Producto A", quantity = 1, unitPrice = 10.0, subtotal = 10.0)),
            total = 10.0
        ))
        repository.createOrder("biz-b", email, ClientOrderPayload(
            status = "pending",
            items = listOf(ClientOrderItemPayload(productId = "p2", productName = "Producto B", quantity = 1, unitPrice = 20.0, subtotal = 20.0)),
            total = 20.0
        ))

        val response = function.securedExecute(
            business = "biz-a",
            function = "client/orders",
            headers = mapOf("Authorization" to validator.generateToken(email)),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertEquals(1, (response as ClientOrderListResponse).orders.size)
        assertEquals("Producto A", response.orders.first().items.first().productName)
    }
}
