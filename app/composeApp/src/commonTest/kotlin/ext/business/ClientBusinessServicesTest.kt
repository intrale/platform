package ext.business

import ext.auth.ExceptionResponse
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
import kotlin.test.assertTrue

private val jsonHeaders = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString())
private val jsonConfig = Json { ignoreUnknownKeys = true }

private fun mockClient(status: HttpStatusCode, body: String): HttpClient {
    val engine = MockEngine { respond(body, status, jsonHeaders) }
    return HttpClient(engine) {
        install(ContentNegotiation) { json(jsonConfig) }
        install(DefaultRequest) { header(HttpHeaders.ContentType, ContentType.Application.Json) }
    }
}

private class FakeStorage(override var token: String? = "Bearer test-tok") : CommKeyValueStorage {
    override var profileCache: ClientProfileCache? = null
    override var preferredLanguage: String? = null
}

// region ClientRegisterBusinessService

class ClientRegisterBusinessServiceTest {

    @Test
    fun `registro exitoso retorna RegisterBusinessResponse`() = runTest {
        val service = ClientRegisterBusinessService(mockClient(HttpStatusCode.OK, "{}"))

        val result = service.execute("Negocio", "admin@test.com", "Descripcion")

        assertTrue(result.isSuccess)
    }

    @Test
    fun `registro fallido retorna ExceptionResponse`() = runTest {
        val body = """{"statusCode":{"value":400,"description":"Bad Request"},"message":"Error"}"""
        val service = ClientRegisterBusinessService(mockClient(HttpStatusCode.BadRequest, body))

        val result = service.execute("Negocio", "admin@test.com", "Descripcion")

        assertTrue(result.isFailure)
    }
}

// endregion

// region ClientRequestJoinBusinessService

class ClientRequestJoinBusinessServiceTest {

    @Test
    fun `solicitud exitosa retorna RequestJoinBusinessResponse`() = runTest {
        val body = """{"state":"PENDING"}"""
        val service = ClientRequestJoinBusinessService(mockClient(HttpStatusCode.OK, body))

        val result = service.execute("negocio-1")

        assertTrue(result.isSuccess)
        assertEquals("PENDING", result.getOrThrow().state)
    }

    @Test
    fun `solicitud fallida retorna ExceptionResponse`() = runTest {
        val body = """{"statusCode":{"value":404,"description":"Not Found"},"message":"No encontrado"}"""
        val service = ClientRequestJoinBusinessService(mockClient(HttpStatusCode.NotFound, body))

        val result = service.execute("negocio-1")

        assertTrue(result.isFailure)
    }
}

// endregion

// region ClientReviewJoinBusinessService

class ClientReviewJoinBusinessServiceTest {

    @Test
    fun `revision exitosa retorna ReviewJoinBusinessResponse`() = runTest {
        val service = ClientReviewJoinBusinessService(mockClient(HttpStatusCode.OK, "{}"))

        val result = service.execute("negocio-1", "user@test.com", "approved")

        assertTrue(result.isSuccess)
    }

    @Test
    fun `revision fallida retorna ExceptionResponse`() = runTest {
        val body = """{"statusCode":{"value":400,"description":"Bad Request"},"message":"Error"}"""
        val service = ClientReviewJoinBusinessService(mockClient(HttpStatusCode.BadRequest, body))

        val result = service.execute("negocio-1", "user@test.com", "rejected")

        assertTrue(result.isFailure)
    }
}

// endregion

// region ClientSearchBusinessesService

class ClientSearchBusinessesServiceTest {

    @Test
    fun `busqueda exitosa retorna SearchBusinessesResponse`() = runTest {
        val body = """{"statusCode":{"value":200,"description":"OK"},"businesses":[],"lastKey":null}"""
        val service = ClientSearchBusinessesService(mockClient(HttpStatusCode.OK, body))

        val result = service.execute("test")

        assertTrue(result.isSuccess)
        assertEquals(0, result.getOrThrow().businesses.size)
    }

    @Test
    fun `busqueda fallida retorna ExceptionResponse`() = runTest {
        val body = """{"statusCode":{"value":500,"description":"Error"},"message":"Error"}"""
        val service = ClientSearchBusinessesService(mockClient(HttpStatusCode.InternalServerError, body))

        val result = service.execute("test")

        assertTrue(result.isFailure)
    }
}

// endregion

// region ClientGetBusinessProductsService

class ClientGetBusinessProductsServiceTest {

    @Test
    fun `obtener productos exitoso retorna BusinessProductsResponse`() = runTest {
        val body = """{"statusCode":{"value":200,"description":"OK"},"products":[]}"""
        val service = ClientGetBusinessProductsService(mockClient(HttpStatusCode.OK, body))

        val result = service.execute("biz-1", "ALL")

        assertTrue(result.isSuccess)
        assertEquals(0, result.getOrThrow().products.size)
    }

    @Test
    fun `obtener productos fallido retorna ExceptionResponse`() = runTest {
        val body = """{"statusCode":{"value":500,"description":"Error"},"message":"Error"}"""
        val service = ClientGetBusinessProductsService(mockClient(HttpStatusCode.InternalServerError, body))

        val result = service.execute("biz-1", "ALL")

        assertTrue(result.isFailure)
    }
}

// endregion

// region ClientGetBusinessDashboardSummaryService

class ClientGetBusinessDashboardSummaryServiceTest {

    @Test
    fun `obtener resumen exitoso retorna DTO`() = runTest {
        val body = """{"productsCount":5,"pendingOrders":2,"activeDrivers":1}"""
        val storage = FakeStorage()
        val service = ClientGetBusinessDashboardSummaryService(mockClient(HttpStatusCode.OK, body), storage)

        val result = service.execute("biz-1")

        assertTrue(result.isSuccess)
        assertEquals(5, result.getOrThrow().productsCount)
    }

    @Test
    fun `obtener resumen fallido retorna ExceptionResponse`() = runTest {
        val body = """{"statusCode":{"value":500,"description":"Error"},"message":"Error"}"""
        val storage = FakeStorage()
        val service = ClientGetBusinessDashboardSummaryService(mockClient(HttpStatusCode.InternalServerError, body), storage)

        val result = service.execute("biz-1")

        assertTrue(result.isFailure)
    }
}

// endregion

// region ClientCategoryService

class ClientCategoryServiceTest {

    @Test
    fun `listar categorias exitoso retorna lista`() = runTest {
        val body = """{"categories":[{"id":"1","name":"Cat A"}]}"""
        val storage = FakeStorage()
        val service = ClientCategoryService(mockClient(HttpStatusCode.OK, body), storage)

        val result = service.listCategories("biz-1")

        assertTrue(result.isSuccess)
        assertEquals(1, result.getOrThrow().size)
    }

    @Test
    fun `crear categoria exitoso retorna CategoryDTO`() = runTest {
        val body = """{"id":"new-1","name":"Nueva"}"""
        val storage = FakeStorage()
        val service = ClientCategoryService(mockClient(HttpStatusCode.OK, body), storage)

        val result = service.createCategory("biz-1", CategoryRequest("Nueva"))

        assertTrue(result.isSuccess)
        assertEquals("Nueva", result.getOrThrow().name)
    }

    @Test
    fun `eliminar categoria exitoso retorna Unit`() = runTest {
        val storage = FakeStorage()
        val service = ClientCategoryService(mockClient(HttpStatusCode.OK, "{}"), storage)

        val result = service.deleteCategory("biz-1", "cat-1")

        assertTrue(result.isSuccess)
    }

    @Test
    fun `listar categorias sin token retorna error`() = runTest {
        val storage = FakeStorage(token = null)
        val service = ClientCategoryService(mockClient(HttpStatusCode.OK, "[]"), storage)

        val result = service.listCategories("biz-1")

        assertTrue(result.isFailure)
    }
}

// endregion

// region ClientProductService

class ClientProductServiceTest {

    @Test
    fun `listar productos exitoso retorna lista`() = runTest {
        val body = """{"products":[{"id":"1","name":"Prod","basePrice":10.0,"unit":"u","categoryId":"c1","status":"DRAFT"}]}"""
        val storage = FakeStorage()
        val service = ClientProductService(mockClient(HttpStatusCode.OK, body), storage)

        val result = service.listProducts("biz-1")

        assertTrue(result.isSuccess)
        assertEquals(1, result.getOrThrow().size)
    }

    @Test
    fun `crear producto exitoso retorna ProductDTO`() = runTest {
        val body = """{"id":"new-1","name":"Nuevo","basePrice":5.0,"unit":"kg","categoryId":"c1","status":"DRAFT"}"""
        val storage = FakeStorage()
        val service = ClientProductService(mockClient(HttpStatusCode.OK, body), storage)

        val result = service.createProduct("biz-1", ProductRequest("Nuevo", null, 5.0, "kg", "c1", ProductStatus.Draft))

        assertTrue(result.isSuccess)
        assertEquals("Nuevo", result.getOrThrow().name)
    }

    @Test
    fun `eliminar producto exitoso retorna Unit`() = runTest {
        val storage = FakeStorage()
        val service = ClientProductService(mockClient(HttpStatusCode.OK, "{}"), storage)

        val result = service.deleteProduct("biz-1", "prod-1")

        assertTrue(result.isSuccess)
    }

    @Test
    fun `listar productos sin token retorna error`() = runTest {
        val storage = FakeStorage(token = null)
        val service = ClientProductService(mockClient(HttpStatusCode.OK, "[]"), storage)

        val result = service.listProducts("biz-1")

        assertTrue(result.isFailure)
    }
}

// endregion

// region ClientReviewBusinessRegistrationService

class ClientReviewBusinessRegistrationServiceTest {

    @Test
    fun `revision exitosa retorna RegisterBusinessResponse`() = runTest {
        val body = """{"statusCode":{"value":200,"description":"OK"}}"""
        val service = ClientReviewBusinessRegistrationService(mockClient(HttpStatusCode.OK, body))

        val result = service.execute("pub-1", "approved", "123456", "Bearer tok")

        assertTrue(result.isSuccess)
    }

    @Test
    fun `revision fallida retorna ExceptionResponse`() = runTest {
        val body = """{"statusCode":{"value":403,"description":"Forbidden"},"message":"Sin permisos"}"""
        val service = ClientReviewBusinessRegistrationService(mockClient(HttpStatusCode.Forbidden, body))

        val result = service.execute("pub-1", "rejected", "123456", "Bearer tok")

        assertTrue(result.isFailure)
    }
}

// endregion
