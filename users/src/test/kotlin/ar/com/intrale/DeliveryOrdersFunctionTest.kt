package ar.com.intrale

import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
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

        repository.createOrder("biz", DeliveryOrderPayload(status = "assigned", assignedTo = email))
        repository.createOrder("biz", DeliveryOrderPayload(status = "assigned", assignedTo = email))
        repository.createOrder("biz", DeliveryOrderPayload(status = "heading_to_client", assignedTo = email))
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

        repository.createOrder("biz", DeliveryOrderPayload(status = "assigned", assignedTo = email))
        repository.createOrder("biz", DeliveryOrderPayload(status = "heading_to_client", assignedTo = email, businessName = "Pizzeria"))
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
        // assigned + heading_to_client son ambos activos
        assertEquals(2, orders.size)
    }

    @Test
    fun `GET available retorna pedidos sin asignar`() = runBlocking {
        val function = DeliveryOrdersFunction(config, logger, repository, validator)
        val email = "driver@test.com"

        repository.createOrder("biz", DeliveryOrderPayload(status = "assigned", assignedTo = null, businessName = "Farmacia"))
        repository.createOrder("biz", DeliveryOrderPayload(status = "assigned", assignedTo = "", businessName = "Supermercado"))
        repository.createOrder("biz", DeliveryOrderPayload(status = "assigned", assignedTo = email))
        repository.createOrder("biz", DeliveryOrderPayload(status = "heading_to_client", assignedTo = null))

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
    fun `GET order detail retorna el pedido completo con historial`() = runBlocking {
        val function = DeliveryOrdersFunction(config, logger, repository, validator)
        val email = "driver@test.com"

        val created = repository.createOrder("biz", DeliveryOrderPayload(
            status = "assigned",
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
        // El historial debe tener al menos la entrada inicial
        assertTrue(detail.statusHistory.isNotEmpty(), "El historial debe contener el estado inicial")
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
    fun `PUT status actualiza el status del pedido con transicion valida`() = runBlocking {
        val function = DeliveryOrdersFunction(config, logger, repository, validator)
        val email = "driver@test.com"

        val created = repository.createOrder("biz", DeliveryOrderPayload(
            status = "assigned",
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
            textBody = """{"orderId":"${created.id}","status":"heading_to_business"}"""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is DeliveryOrderStatusUpdateResponse)
        val updated = response as DeliveryOrderStatusUpdateResponse
        assertEquals(created.id, updated.orderId)
        assertEquals("heading_to_business", updated.status)
    }

    @Test
    fun `PUT status retorna 409 para transicion invalida — saltar estados`() = runBlocking {
        val function = DeliveryOrdersFunction(config, logger, repository, validator)
        val email = "driver@test.com"

        val created = repository.createOrder("biz", DeliveryOrderPayload(
            status = "assigned",
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
            textBody = """{"orderId":"${created.id}","status":"delivered"}"""
        )

        assertEquals(HttpStatusCode.Conflict, response.statusCode)
    }

    @Test
    fun `PUT status retorna 409 para pedido en estado terminal`() = runBlocking {
        val function = DeliveryOrdersFunction(config, logger, repository, validator)
        val email = "driver@test.com"

        val created = repository.createOrder("biz", DeliveryOrderPayload(
            status = "delivered",
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
            textBody = """{"orderId":"${created.id}","status":"heading_to_client"}"""
        )

        assertEquals(HttpStatusCode.Conflict, response.statusCode)
    }

    @Test
    fun `PUT state cambia el estado de entrega del pedido con transicion valida`() = runBlocking {
        val function = DeliveryOrdersFunction(config, logger, repository, validator)
        val email = "driver@test.com"

        val created = repository.createOrder("biz", DeliveryOrderPayload(
            status = "heading_to_client",
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
    fun `PUT state registra historial de cambios de estado`() = runBlocking {
        val function = DeliveryOrdersFunction(config, logger, repository, validator)
        val email = "driver@test.com"

        val created = repository.createOrder("biz", DeliveryOrderPayload(
            status = "assigned",
            assignedTo = email
        ))

        // Avanzar al siguiente estado
        function.securedExecute(
            business = "biz",
            function = "delivery/orders/${created.id}/status",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "PUT",
                "X-Function-Path" to "delivery/orders/${created.id}/status"
            ),
            textBody = """{"orderId":"${created.id}","status":"heading_to_business"}"""
        )

        // Consultar detalle para verificar historial
        val detailResponse = function.securedExecute(
            business = "biz",
            function = "delivery/orders/${created.id}",
            headers = mapOf(
                "Authorization" to validator.generateToken(email),
                "X-Http-Method" to "GET",
                "X-Function-Path" to "delivery/orders/${created.id}"
            ),
            textBody = ""
        ) as DeliveryOrderDetailResponse

        assertTrue(detailResponse.statusHistory.size >= 2,
            "Debe haber al menos 2 entradas en el historial (initial + cambio)")
        assertEquals("heading_to_business", detailResponse.statusHistory.last().status)
        assertTrue(detailResponse.statusHistory.last().timestamp.isNotBlank(),
            "El timestamp del ultimo cambio debe estar presente")
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
            textBody = """{"orderId":"fake-id","status":"heading_to_business"}"""
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

        repository.createOrder("biz-a", DeliveryOrderPayload(status = "assigned", assignedTo = email))
        repository.createOrder("biz-b", DeliveryOrderPayload(status = "assigned", assignedTo = email))
        repository.createOrder("biz-b", DeliveryOrderPayload(status = "assigned", assignedTo = email))

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
