package ext.signup

import ext.auth.ExceptionResponse
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
import kotlin.test.assertTrue

private val jsonHeaders = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString())

private fun mockClient(status: HttpStatusCode, body: String): HttpClient {
    val engine = MockEngine { respond(body, status, jsonHeaders) }
    return HttpClient(engine) {
        install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
        install(DefaultRequest) { header(HttpHeaders.ContentType, ContentType.Application.Json) }
    }
}

// region ClientSignUpService

class ClientSignUpServiceTest {

    @Test
    fun `signup exitoso retorna SignUpResponse`() = runTest {
        val service = ClientSignUpService(mockClient(HttpStatusCode.OK, "{}"))
        val result = service.execute("user@test.com")
        assertTrue(result.isSuccess)
    }

    @Test
    fun `signup fallido retorna ExceptionResponse`() = runTest {
        val body = """{"statusCode":{"value":409,"description":"Conflict"},"message":"Email ya registrado"}"""
        val service = ClientSignUpService(mockClient(HttpStatusCode.Conflict, body))
        val result = service.execute("user@test.com")
        assertTrue(result.isFailure)
    }
}

// endregion

// region ClientSignUpDeliveryService

class ClientSignUpDeliveryServiceTest {

    @Test
    fun `signup delivery exitoso retorna SignUpResponse`() = runTest {
        val service = ClientSignUpDeliveryService(mockClient(HttpStatusCode.OK, "{}"))
        val result = service.execute("negocio-1", "driver@test.com")
        assertTrue(result.isSuccess)
    }

    @Test
    fun `signup delivery fallido retorna ExceptionResponse`() = runTest {
        val body = """{"statusCode":{"value":400,"description":"Bad Request"},"message":"Error"}"""
        val service = ClientSignUpDeliveryService(mockClient(HttpStatusCode.BadRequest, body))
        val result = service.execute("negocio-1", "driver@test.com")
        assertTrue(result.isFailure)
    }
}

// endregion

// region ClientSignUpPlatformAdminService

class ClientSignUpPlatformAdminServiceTest {

    @Test
    fun `signup admin exitoso retorna SignUpResponse`() = runTest {
        val service = ClientSignUpPlatformAdminService(mockClient(HttpStatusCode.OK, "{}"))
        val result = service.execute("admin@test.com")
        assertTrue(result.isSuccess)
    }

    @Test
    fun `signup admin fallido retorna ExceptionResponse`() = runTest {
        val body = """{"statusCode":{"value":403,"description":"Forbidden"},"message":"Sin permisos"}"""
        val service = ClientSignUpPlatformAdminService(mockClient(HttpStatusCode.Forbidden, body))
        val result = service.execute("admin@test.com")
        assertTrue(result.isFailure)
    }
}

// endregion

// region ClientRegisterSalerService

class ClientRegisterSalerServiceTest {

    @Test
    fun `registro saler exitoso retorna RegisterSalerResponse`() = runTest {
        val service = ClientRegisterSalerService(mockClient(HttpStatusCode.OK, "{}"))
        val result = service.execute("saler@test.com", "Bearer tok")
        assertTrue(result.isSuccess)
    }

    @Test
    fun `registro saler fallido retorna ExceptionResponse`() = runTest {
        val body = """{"statusCode":{"value":400,"description":"Bad Request"},"message":"Error"}"""
        val service = ClientRegisterSalerService(mockClient(HttpStatusCode.BadRequest, body))
        val result = service.execute("saler@test.com", "Bearer tok")
        assertTrue(result.isFailure)
    }
}

// endregion

// region ClientConfirmSignUpService

class ClientConfirmSignUpServiceTest {

    @Test
    fun `confirmacion exitosa retorna ConfirmSignUpResponse`() = runTest {
        val service = ClientConfirmSignUpService(mockClient(HttpStatusCode.OK, "{}"))
        val result = service.execute("user@test.com", "123456")
        assertTrue(result.isSuccess)
    }

    @Test
    fun `confirmacion fallida retorna ExceptionResponse`() = runTest {
        val body = """{"statusCode":{"value":400,"description":"Bad Request"},"message":"Codigo invalido"}"""
        val service = ClientConfirmSignUpService(mockClient(HttpStatusCode.BadRequest, body))
        val result = service.execute("user@test.com", "wrong")
        assertTrue(result.isFailure)
    }
}

// endregion
