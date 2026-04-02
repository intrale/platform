package ar.com.intrale

import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DeliveryOrdersFunctionTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")
    private val repository = DeliveryOrderRepository()
    private val validator = LocalJwtValidator()

    @Test
    fun `GET summary retorna contadores en cero cuando no hay pedidos`() = runBlocking {
        val function = DeliveryOrdersFunction(config, logger, repository, validator)
        val email = "driver@test.com"

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/orders/summary",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET",
                "X-Function-Path" to "delivery/orders/summary"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is DeliveryOrdersSummaryResponse)
        val summary = response as DeliveryOrdersSummaryResponse
        assertEquals(0, summary.pending)
        assertEquals(0, summary.inProgress)
        assertEquals(0, summary.delivered)
    }

    @Test
    fun `GET summary retorna contadores correctos con pedidos asignados`() = runBlocking {
        val function = DeliveryOrdersFunction(config, logger, repository, validator)
        val email = "driver@test.com"

        repository.createOrder("biz", DeliveryOrderPayload(status = "pending", assignedTo = email))
        repository.createOrder("biz", DeliveryOrderPayload(status = "pending", assignedTo = email))
        repository.createOrder("biz", DeliveryOrderPayload(status = "in_transit", assignedTo = email))
        repository.createOrder("biz", DeliveryOrderPayload(status = "delivered", assignedTo = email))

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/orders/summary",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET",
                "X-Function-Path" to "delivery/orders/summary"
            ),
            textBody = ""
        )

        val summary = response as DeliveryOrdersSummaryResponse
        assertEquals(2, summary.pending)
        assertEquals(1, summary.inProgress)
        assertEquals(1, summary.delivered)
    }

    @Test
    fun `GET active retorna solo pedidos activos del repartidor`() = runBlocking {
        val function = DeliveryOrdersFunction(config, logger, repository, validator)
        val email = "driver@test.com"

        repository.createOrder("biz", DeliveryOrderPayload(status = "pending", assignedTo = email))
        repository.createOrder("biz", DeliveryOrderPayload(status = "in_transit", assignedTo = email, businessName = "Pizzeria"))
        repository.createOrder("biz", DeliveryOrderPayload(status = "delivered", assignedTo = email))

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/orders/active",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET",
                "X-Function-Path" to "delivery/orders/active"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is DeliveryOrderListResponse)
        val orders = (response as DeliveryOrderListResponse).orders
        assertEquals(1, orders.size)
        assertEquals("in_transit", orders[0].status)
    }

    @Test
    fun `GET available retorna pedidos sin asignar`() = runBlocking {
        val function = DeliveryOrdersFunction(config, logger, repository, validator)
        val email = "driver@test.com"

        repository.createOrder("biz", DeliveryOrderPayload(status = "pending", assignedTo = null, businessName = "Farmacia"))
        repository.createOrder("biz", DeliveryOrderPayload(status = "pending", assignedTo = "", businessName = "Supermercado"))
        repository.createOrder("biz", DeliveryOrderPayload(status = "pending", assignedTo = email))
        repository.createOrder("biz", DeliveryOrderPayload(status = "in_transit", assignedTo = null))

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/orders/available",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET",
                "X-Function-Path" to "delivery/orders/available"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val orders = (response as DeliveryOrderListResponse).orders
        assertEquals(2, orders.size)
    }

    @Test
    fun `GET order detail retorna el pedido completo`() = runBlocking {
        val function = DeliveryOrdersFunction(config, logger, repository, validator)
        val email = "driver@test.com"

        val created = repository.createOrder("biz", DeliveryOrderPayload(
            status = "pending",
            assignedTo = email,
            businessName = "Pizzeria",
            neighborhood = "Palermo",
            address = "Av. Santa Fe 1234",
            customerName = "Carlos García",
            customerPhone = "+5491155556666",
            items = listOf(DeliveryOrderItemPayload(name = "Pizza grande", quantity = 2))
        ))

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/orders/${created.id}",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET",
                "X-Function-Path" to "delivery/orders/${created.id}"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is DeliveryOrderDetailResponse)
        val detail = response as DeliveryOrderDetailResponse
        assertEquals(created.id, detail.id)
        assertEquals("Pizzeria", detail.businessName)
        assertEquals("Palermo", detail.neighborhood)
        assertEquals("Carlos García", detail.customerName)
        assertEquals(1, detail.items.size)
        assertEquals("Pizza grande", detail.items[0].name)
    }

    @Test
    fun `GET order detail retorna 404 cuando no existe`() = runBlocking {
        val function = DeliveryOrdersFunction(config, logger, repository, validator)
        val email = "driver@test.com"

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/orders/nonexistent-id",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET",
                "X-Function-Path" to "delivery/orders/nonexistent-id"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.NotFound, response.statusCode)
    }

    @Test
    fun `PUT status actualiza el status del pedido`() = runBlocking {
        val function = DeliveryOrdersFunction(config, logger, repository, validator)
        val email = "driver@test.com"

        val created = repository.createOrder("biz", DeliveryOrderPayload(
            status = "pending",
            assignedTo = email
        ))

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/orders/${created.id}/status",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "PUT",
                "X-Function-Path" to "delivery/orders/${created.id}/status"
            ),
            textBody = """{"orderId":"${created.id}","status":"picked_up"}"""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is DeliveryOrderStatusUpdateResponse)
        val updated = response as DeliveryOrderStatusUpdateResponse
        assertEquals(created.id, updated.orderId)
        assertEquals("picked_up", updated.status)
    }

    @Test
    fun `PUT state cambia el estado de entrega del pedido`() = runBlocking {
        val function = DeliveryOrdersFunction(config, logger, repository, validator)
        val email = "driver@test.com"

        val created = repository.createOrder("biz", DeliveryOrderPayload(
            status = "in_transit",
            assignedTo = email
        ))

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/orders/${created.id}/state",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "PUT",
                "X-Function-Path" to "delivery/orders/${created.id}/state"
            ),
            textBody = """{"orderId":"${created.id}","state":"delivered"}"""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is DeliveryStateChangeResponse)
        val changed = response as DeliveryStateChangeResponse
        assertEquals(created.id, changed.orderId)
        assertEquals("delivered", changed.state)
    }

    @Test
    fun `PUT status retorna 404 para pedido inexistente`() = runBlocking {
        val function = DeliveryOrdersFunction(config, logger, repository, validator)
        val email = "driver@test.com"

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/orders/fake-id/status",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "PUT",
                "X-Function-Path" to "delivery/orders/fake-id/status"
            ),
            textBody = """{"orderId":"fake-id","status":"delivered"}"""
        )

        assertEquals(HttpStatusCode.NotFound, response.statusCode)
    }

    @Test
    fun `sin token retorna no autorizado`() = runBlocking {
        val function = DeliveryOrdersFunction(config, logger, repository, validator)

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/orders/summary",
            headers = mapOf(
                "X-Http-Method" to "GET",
                "X-Function-Path" to "delivery/orders/summary"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.Unauthorized, response.statusCode)
    }

    @Test
    fun `pedidos de un negocio no se mezclan con otro`() = runBlocking {
        val configAB = testConfig("biz-a", "biz-b")
        val function = DeliveryOrdersFunction(configAB, logger, repository, validator)
        val email = "driver@test.com"

        repository.createOrder("biz-a", DeliveryOrderPayload(status = "pending", assignedTo = email))
        repository.createOrder("biz-b", DeliveryOrderPayload(status = "pending", assignedTo = email))
        repository.createOrder("biz-b", DeliveryOrderPayload(status = "pending", assignedTo = email))

        val responseA = function.securedExecute(
            business = "biz-a",
            function = "delivery/orders/summary",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET",
                "X-Function-Path" to "delivery/orders/summary"
            ),
            textBody = ""
        ) as DeliveryOrdersSummaryResponse

        val responseB = function.securedExecute(
            business = "biz-b",
            function = "delivery/orders/summary",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET",
                "X-Function-Path" to "delivery/orders/summary"
            ),
            textBody = ""
        ) as DeliveryOrdersSummaryResponse

        assertEquals(1, responseA.pending)
        assertEquals(2, responseB.pending)
    }

    @Test
    fun `GET order detail incluye coordenadas y dirección del negocio para navegación`() = runBlocking {
        val function = DeliveryOrdersFunction(config, logger, repository, validator)
        val email = "driver@test.com"

        val created = repository.createOrder("biz", DeliveryOrderPayload(
            status = "in_transit",
            assignedTo = email,
            businessName = "Heladería Freddo",
            businessAddress = "Av. Corrientes 1500, CABA",
            businessLatitude = -34.6037,
            businessLongitude = -58.3816,
            address = "Av. Santa Fe 3200, Palermo",
            customerLatitude = -34.5875,
            customerLongitude = -58.4099,
            customerName = "María López",
            customerPhone = "+5491144445555"
        ))

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/orders/${created.id}",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET",
                "X-Function-Path" to "delivery/orders/${created.id}"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is DeliveryOrderDetailResponse)
        val detail = response as DeliveryOrderDetailResponse
        assertEquals("Av. Corrientes 1500, CABA", detail.businessAddress)
        assertEquals(-34.6037, detail.businessLatitude)
        assertEquals(-58.3816, detail.businessLongitude)
        assertEquals(-34.5875, detail.customerLatitude)
        assertEquals(-58.4099, detail.customerLongitude)
        assertEquals("Av. Santa Fe 3200, Palermo", detail.address)
        assertEquals("María López", detail.customerName)
    }

    @Test
    fun `GET order detail funciona sin coordenadas para compatibilidad backward`() = runBlocking {
        val function = DeliveryOrdersFunction(config, logger, repository, validator)
        val email = "driver@test.com"

        val created = repository.createOrder("biz", DeliveryOrderPayload(
            status = "pending",
            assignedTo = email,
            businessName = "Kiosco",
            address = "Calle 123"
        ))

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/orders/${created.id}",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET",
                "X-Function-Path" to "delivery/orders/${created.id}"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val detail = response as DeliveryOrderDetailResponse
        assertEquals("Kiosco", detail.businessName)
        assertEquals("Calle 123", detail.address)
        assertEquals(null, detail.businessLatitude)
        assertEquals(null, detail.businessLongitude)
        assertEquals(null, detail.customerLatitude)
        assertEquals(null, detail.customerLongitude)
        assertEquals(null, detail.businessAddress)
    }

    @Test
    fun `GET active incluye pedidos con coordenadas de navegación`() = runBlocking {
        val function = DeliveryOrdersFunction(config, logger, repository, validator)
        val email = "driver@test.com"

        repository.createOrder("biz", DeliveryOrderPayload(
            status = "in_transit",
            assignedTo = email,
            businessName = "Farmacia",
            businessAddress = "Av. Rivadavia 5000",
            businessLatitude = -34.6131,
            businessLongitude = -58.4397,
            address = "Calle Fake 742",
            customerLatitude = -34.6200,
            customerLongitude = -58.4500
        ))

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/orders/active",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET",
                "X-Function-Path" to "delivery/orders/active"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val orders = (response as DeliveryOrderListResponse).orders
        assertEquals(1, orders.size)
        assertEquals(-34.6131, orders[0].businessLatitude)
        assertEquals(-58.4397, orders[0].businessLongitude)
        assertEquals(-34.6200, orders[0].customerLatitude)
        assertEquals(-58.4500, orders[0].customerLongitude)
        assertEquals("Av. Rivadavia 5000", orders[0].businessAddress)
    }

    @Test
    fun `PUT take preserva coordenadas de navegación del pedido`() = runBlocking {
        val function = DeliveryOrdersFunction(config, logger, repository, validator)
        val email = "driver@test.com"

        val created = repository.createOrder("biz", DeliveryOrderPayload(
            status = "pending",
            assignedTo = null,
            businessName = "Supermercado",
            businessAddress = "Av. Cabildo 3000",
            businessLatitude = -34.5550,
            businessLongitude = -58.4600,
            customerLatitude = -34.5700,
            customerLongitude = -58.4700
        ))

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/orders/${created.id}/take",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "PUT",
                "X-Function-Path" to "delivery/orders/${created.id}/take"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)

        // Verificar que las coordenadas persisten después de tomar el pedido
        val detail = repository.getOrder("biz", created.id)!!
        assertEquals(-34.5550, detail.businessLatitude)
        assertEquals(-58.4600, detail.businessLongitude)
        assertEquals("Av. Cabildo 3000", detail.businessAddress)
    }

    @Test
    fun `método no soportado retorna error de validación`() = runBlocking {
        val function = DeliveryOrdersFunction(config, logger, repository, validator)
        val email = "driver@test.com"

        val response = function.securedExecute(
            business = "biz",
            function = "delivery/orders/summary",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "DELETE",
                "X-Function-Path" to "delivery/orders/summary"
            ),
            textBody = ""
        )

        assertEquals(HttpStatusCode.BadRequest, response.statusCode)
    }
}
