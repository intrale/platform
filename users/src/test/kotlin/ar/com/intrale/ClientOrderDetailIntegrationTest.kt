package ar.com.intrale

import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ClientOrderDetailIntegrationTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")
    private val repository = ClientOrderRepository()
    private val validator = LocalJwtValidator()

    @Test
    fun `obtener detalle de pedido existente`() = runBlocking {
        val function = ClientOrderDetail(config, logger, repository, validator)
        val email = "client@test.com"

        val created = repository.createOrder("biz", email, ClientOrderPayload(
            id = "order-123",
            status = "pending",
            items = listOf(ClientOrderItemPayload(productId = "p1", productName = "Producto 1", quantity = 2, unitPrice = 10.0, subtotal = 20.0)),
            total = 20.0,
            notes = "Sin cebolla"
        ))

        val response = function.securedExecute(
            business = "biz",
            function = "client/order-detail/order-123",
            headers = mapOf("Authorization" to validator.generateToken(email)),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is ClientOrderDetailResponse)
        val detail = (response as ClientOrderDetailResponse).order!!
        assertEquals("order-123", detail.id)
        assertEquals("pending", detail.status)
        assertEquals(20.0, detail.total)
        assertEquals("Sin cebolla", detail.notes)
    }

    @Test
    fun `pedido inexistente retorna not found`() = runBlocking {
        val function = ClientOrderDetail(config, logger, repository, validator)
        val email = "client@test.com"

        val response = function.securedExecute(
            business = "biz",
            function = "client/order-detail/nonexistent",
            headers = mapOf("Authorization" to validator.generateToken(email)),
            textBody = ""
        )

        assertEquals(HttpStatusCode.NotFound, response.statusCode)
    }

    @Test
    fun `sin orderId retorna error de validacion`() = runBlocking {
        val function = ClientOrderDetail(config, logger, repository, validator)
        val email = "client@test.com"

        val response = function.securedExecute(
            business = "biz",
            function = "client/order-detail",
            headers = mapOf("Authorization" to validator.generateToken(email)),
            textBody = ""
        )

        assertEquals(HttpStatusCode.BadRequest, response.statusCode)
    }

    @Test
    fun `sin token retorna no autorizado`() = runBlocking {
        val function = ClientOrderDetail(config, logger, repository, validator)

        val response = function.securedExecute(
            business = "biz",
            function = "client/order-detail/order-123",
            headers = emptyMap(),
            textBody = ""
        )

        assertEquals(HttpStatusCode.Unauthorized, response.statusCode)
    }
}
