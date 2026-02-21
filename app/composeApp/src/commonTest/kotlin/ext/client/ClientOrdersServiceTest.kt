package ext.client

import ext.dto.StatusCodeDTO
import ext.storage.CommKeyValueStorage
import ext.storage.model.ClientProfileCache
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.DefaultRequest
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.header
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

private val ordersJsonHeaders = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString())

private fun ordersMockClient(status: HttpStatusCode, body: String): HttpClient {
    val engine = MockEngine { respond(body, status, ordersJsonHeaders) }
    return HttpClient(engine) {
        install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
        install(DefaultRequest) { header(HttpHeaders.ContentType, ContentType.Application.Json) }
    }
}

private class OrdersFakeStorage(override var token: String? = "Bearer tok") : CommKeyValueStorage {
    override var profileCache: ClientProfileCache? = null
    override var preferredLanguage: String? = null
    override var onboardingCompleted: Boolean = false
}

class ClientOrdersServiceTest {

    // region listOrders

    @Test
    fun `listOrders exitoso con response envolvente retorna lista`() = runTest {
        val body = """{"orders":[{"id":"ord-1","publicId":"PUB-001","shortCode":"SC01","businessName":"Tienda","status":"PENDING","createdAt":"2025-01-01","total":150.0,"itemCount":3}]}"""
        val service = ClientOrdersService(ordersMockClient(HttpStatusCode.OK, body), OrdersFakeStorage())

        val result = service.listOrders()

        assertTrue(result.isSuccess)
        assertEquals(1, result.getOrThrow().size)
        assertEquals("ord-1", result.getOrThrow()[0].id)
    }

    @Test
    fun `listOrders con body vacio retorna lista vacia`() = runTest {
        val service = ClientOrdersService(ordersMockClient(HttpStatusCode.OK, ""), OrdersFakeStorage())

        val result = service.listOrders()

        assertTrue(result.isSuccess)
        assertTrue(result.getOrThrow().isEmpty())
    }

    @Test
    fun `listOrders con lista JSON directa retorna lista`() = runTest {
        val body = """[{"id":"ord-1","publicId":"PUB-001","shortCode":"SC01","businessName":"Tienda","status":"PENDING","createdAt":"2025-01-01","total":100.0,"itemCount":2}]"""
        val service = ClientOrdersService(ordersMockClient(HttpStatusCode.OK, body), OrdersFakeStorage())

        val result = service.listOrders()

        assertTrue(result.isSuccess)
        assertEquals(1, result.getOrThrow().size)
    }

    @Test
    fun `listOrders sin token retorna error 401`() = runTest {
        val service = ClientOrdersService(ordersMockClient(HttpStatusCode.OK, "{}"), OrdersFakeStorage(token = null))

        val result = service.listOrders()

        assertTrue(result.isFailure)
        val exception = result.exceptionOrNull()
        assertTrue(exception is ClientExceptionResponse)
        assertEquals(401, (exception as ClientExceptionResponse).statusCode.value)
    }

    @Test
    fun `listOrders error servidor retorna failure`() = runTest {
        val body = """{"statusCode":{"code":500,"description":"Internal Server Error"},"message":"Error interno"}"""
        val service = ClientOrdersService(ordersMockClient(HttpStatusCode.InternalServerError, body), OrdersFakeStorage())

        val result = service.listOrders()

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is ClientExceptionResponse)
    }

    // endregion

    // region fetchOrderDetail

    @Test
    fun `fetchOrderDetail exitoso con response envolvente retorna detalle`() = runTest {
        val body = """{"order":{"id":"ord-1","publicId":"PUB-001","shortCode":"SC01","businessName":"Tienda","status":"DELIVERED","createdAt":"2025-01-01","total":250.0,"itemCount":2,"items":[{"id":"item-1","name":"Producto A","quantity":2,"unitPrice":125.0,"subtotal":250.0}]}}"""
        val service = ClientOrdersService(ordersMockClient(HttpStatusCode.OK, body), OrdersFakeStorage())

        val result = service.fetchOrderDetail("ord-1")

        assertTrue(result.isSuccess)
        val detail = result.getOrThrow()
        assertEquals("ord-1", detail.id)
        assertEquals(1, detail.items.size)
        assertEquals("Producto A", detail.items[0].name)
    }

    @Test
    fun `fetchOrderDetail con body vacio retorna DTO default`() = runTest {
        val service = ClientOrdersService(ordersMockClient(HttpStatusCode.OK, ""), OrdersFakeStorage())

        val result = service.fetchOrderDetail("ord-1")

        assertTrue(result.isSuccess)
        assertNotNull(result.getOrThrow())
    }

    @Test
    fun `fetchOrderDetail sin token retorna error 401`() = runTest {
        val service = ClientOrdersService(ordersMockClient(HttpStatusCode.OK, "{}"), OrdersFakeStorage(token = null))

        val result = service.fetchOrderDetail("ord-1")

        assertTrue(result.isFailure)
        val exception = result.exceptionOrNull()
        assertTrue(exception is ClientExceptionResponse)
        assertEquals(401, (exception as ClientExceptionResponse).statusCode.value)
    }

    @Test
    fun `fetchOrderDetail error servidor 404 retorna failure`() = runTest {
        val body = """{"statusCode":{"code":404,"description":"Not Found"},"message":"Pedido no encontrado"}"""
        val service = ClientOrdersService(ordersMockClient(HttpStatusCode.NotFound, body), OrdersFakeStorage())

        val result = service.fetchOrderDetail("ord-inexistente")

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is ClientExceptionResponse)
    }

    // endregion
}
