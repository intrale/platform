package ar.com.intrale

import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class BusinessOrdersFunctionTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("pizzeria")
    private val repository = ClientOrderRepository()
    private val deliveryProfileRepository = DeliveryProfileRepository()
    private val validator = LocalJwtValidator()

    @Test
    fun `GET retorna lista vacía cuando el negocio no tiene pedidos`() = runBlocking {
        val function = BusinessOrdersFunction(config, logger, repository, deliveryProfileRepository, validator)
        val email = "admin@pizzeria.com"

        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/orders",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is BusinessOrderListResponse)
        assertTrue((response as BusinessOrderListResponse).orders.isEmpty())
    }

    @Test
    fun `GET retorna todos los pedidos del negocio con datos correctos`() = runBlocking {
        val function = BusinessOrdersFunction(config, logger, repository, deliveryProfileRepository, validator)
        val email = "admin@pizzeria.com"

        repository.createOrder("pizzeria", "cliente1@test.com", ClientOrderPayload(
            status = "PENDING", total = 1500.0
        ))
        repository.createOrder("pizzeria", "cliente2@test.com", ClientOrderPayload(
            status = "PREPARING", total = 3200.0
        ))

        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/orders",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val orders = (response as BusinessOrderListResponse).orders
        assertEquals(2, orders.size)
    }

    @Test
    fun `GET pedidos de un negocio no incluye pedidos de otro negocio`() = runBlocking {
        val configMulti = testConfig("pizzeria", "farmacia")
        val function = BusinessOrdersFunction(configMulti, logger, repository, deliveryProfileRepository, validator)
        val email = "admin@pizzeria.com"

        repository.createOrder("pizzeria", "cliente1@test.com", ClientOrderPayload(status = "PENDING", total = 1000.0))
        repository.createOrder("farmacia", "cliente2@test.com", ClientOrderPayload(status = "PENDING", total = 500.0))

        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/orders",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val orders = (response as BusinessOrderListResponse).orders
        assertEquals(1, orders.size)
        assertEquals(1000.0, orders[0].total)
    }

    @Test
    fun `GET sin autenticación retorna 401`() = runBlocking {
        val function = BusinessOrdersFunction(config, logger, repository, deliveryProfileRepository, validator)

        // Llamar a execute (no securedExecute) para que se aplique la validación JWT
        val response = function.execute(
            business = "pizzeria",
            function = "business/orders",
            headers = mapOf("X-Http-Method" to "GET"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.Unauthorized, response.statusCode)
    }

    @Test
    fun `método no soportado retorna 400`() = runBlocking {
        val function = BusinessOrdersFunction(config, logger, repository, deliveryProfileRepository, validator)
        val email = "admin@pizzeria.com"

        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/orders",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "DELETE"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.BadRequest, response.statusCode)
    }

    @Test
    fun `GET retorna pedidos con clientEmail correcto`() = runBlocking {
        val function = BusinessOrdersFunction(config, logger, repository, deliveryProfileRepository, validator)
        val email = "admin@pizzeria.com"

        repository.createOrder("pizzeria", "juan@test.com", ClientOrderPayload(
            status = "PENDING", total = 750.0
        ))

        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/orders",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET"
            ),
            textBody = ""
        )

        val orders = (response as BusinessOrderListResponse).orders
        assertEquals(1, orders.size)
        assertEquals("juan@test.com", orders[0].clientEmail)
        assertEquals("PENDING", orders[0].status.uppercase())
        assertEquals(750.0, orders[0].total)
    }
}
