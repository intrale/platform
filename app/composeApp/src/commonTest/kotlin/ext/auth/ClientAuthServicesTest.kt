package ext.auth

import ext.dto.StatusCodeDTO
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

// region ClientLoginService

class ClientLoginServiceTest {

    @Test
    fun `login exitoso retorna LoginResponse`() = runTest {
        val body = """{"statusCode":{"value":200,"description":"OK"},"idToken":"id","accessToken":"access","refreshToken":"refresh"}"""
        val service = ClientLoginService(mockClient(HttpStatusCode.OK, body))

        val result = service.execute("user@test.com", "pass123")

        assertTrue(result.isSuccess)
        assertEquals("access", result.getOrThrow().accessToken)
    }

    @Test
    fun `login fallido retorna ExceptionResponse`() = runTest {
        val body = """{"statusCode":{"value":401,"description":"Unauthorized"},"message":"Credenciales invalidas"}"""
        val service = ClientLoginService(mockClient(HttpStatusCode.Unauthorized, body))

        val result = service.execute("user@test.com", "wrong")

        assertTrue(result.isFailure)
        val ex = result.exceptionOrNull() as ExceptionResponse
        assertEquals(401, ex.statusCode.value)
    }
}

// endregion

// region ClientChangePasswordService

class ClientChangePasswordServiceTest {

    @Test
    fun `cambio exitoso retorna ChangePasswordResponse`() = runTest {
        val service = ClientChangePasswordService(mockClient(HttpStatusCode.OK, "{}"))

        val result = service.execute("old", "new", "Bearer tok")

        assertTrue(result.isSuccess)
        assertEquals(200, result.getOrThrow().statusCode.value)
    }

    @Test
    fun `cambio fallido retorna ExceptionResponse`() = runTest {
        val body = """{"statusCode":{"value":400,"description":"Bad Request"},"message":"Error"}"""
        val service = ClientChangePasswordService(mockClient(HttpStatusCode.BadRequest, body))

        val result = service.execute("old", "new", "Bearer tok")

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is ExceptionResponse)
    }
}

// endregion

// region ClientPasswordRecoveryService

class ClientPasswordRecoveryServiceTest {

    @Test
    fun `recovery exitoso retorna PasswordRecoveryResponse`() = runTest {
        val service = ClientPasswordRecoveryService(mockClient(HttpStatusCode.OK, "{}"))

        val result = service.recovery("test@test.com")

        assertTrue(result.isSuccess)
        assertEquals(200, result.getOrThrow().statusCode.value)
    }

    @Test
    fun `recovery fallido retorna ExceptionResponse`() = runTest {
        val body = """{"statusCode":{"value":404,"description":"Not Found"},"message":"Email no encontrado"}"""
        val service = ClientPasswordRecoveryService(mockClient(HttpStatusCode.NotFound, body))

        val result = service.recovery("test@test.com")

        assertTrue(result.isFailure)
    }

    @Test
    fun `confirm exitoso retorna PasswordRecoveryResponse`() = runTest {
        val service = ClientPasswordRecoveryService(mockClient(HttpStatusCode.OK, "{}"))

        val result = service.confirm("test@test.com", "123456", "newpass")

        assertTrue(result.isSuccess)
    }

    @Test
    fun `confirm fallido retorna ExceptionResponse`() = runTest {
        val body = """{"statusCode":{"value":400,"description":"Bad Request"},"message":"Codigo invalido"}"""
        val service = ClientPasswordRecoveryService(mockClient(HttpStatusCode.BadRequest, body))

        val result = service.confirm("test@test.com", "wrong", "newpass")

        assertTrue(result.isFailure)
    }
}

// endregion

// region ClientTwoFactorSetupService

class ClientTwoFactorSetupServiceTest {

    @Test
    fun `setup exitoso retorna TwoFactorSetupResponse`() = runTest {
        val body = """{"statusCode":{"value":200,"description":"OK"},"otpAuthUri":"otpauth://totp/test"}"""
        val service = ClientTwoFactorSetupService(mockClient(HttpStatusCode.OK, body))

        val result = service.execute("Bearer tok")

        assertTrue(result.isSuccess)
        assertEquals("otpauth://totp/test", result.getOrThrow().otpAuthUri)
    }

    @Test
    fun `setup fallido retorna ExceptionResponse`() = runTest {
        val body = """{"statusCode":{"value":500,"description":"Error"},"message":"Fallo"}"""
        val service = ClientTwoFactorSetupService(mockClient(HttpStatusCode.InternalServerError, body))

        val result = service.execute("Bearer tok")

        assertTrue(result.isFailure)
    }
}

// endregion

// region ClientTwoFactorVerifyService

class ClientTwoFactorVerifyServiceTest {

    @Test
    fun `verificacion exitosa retorna TwoFactorVerifyResponse`() = runTest {
        val service = ClientTwoFactorVerifyService(mockClient(HttpStatusCode.OK, "{}"))

        val result = service.execute("123456", "Bearer tok")

        assertTrue(result.isSuccess)
        assertEquals(200, result.getOrThrow().statusCode.value)
    }

    @Test
    fun `verificacion fallida retorna ExceptionResponse`() = runTest {
        val body = """{"statusCode":{"value":400,"description":"Bad Request"},"message":"Codigo incorrecto"}"""
        val service = ClientTwoFactorVerifyService(mockClient(HttpStatusCode.BadRequest, body))

        val result = service.execute("wrong", "Bearer tok")

        assertTrue(result.isFailure)
    }
}

// endregion

// region DeliveryLoginService

class DeliveryLoginServiceTest {

    @Test
    fun `login delivery exitoso retorna LoginResponse`() = runTest {
        val body = """{"statusCode":{"value":200,"description":"OK"},"idToken":"id","accessToken":"access","refreshToken":"refresh"}"""
        val service = DeliveryLoginService(mockClient(HttpStatusCode.OK, body))

        val result = service.execute("driver@test.com", "pass123")

        assertTrue(result.isSuccess)
        assertEquals("access", result.getOrThrow().accessToken)
    }

    @Test
    fun `login delivery fallido retorna ExceptionResponse`() = runTest {
        val body = """{"statusCode":{"value":401,"description":"Unauthorized"},"message":"Error"}"""
        val service = DeliveryLoginService(mockClient(HttpStatusCode.Unauthorized, body))

        val result = service.execute("driver@test.com", "wrong")

        assertTrue(result.isFailure)
    }
}

// endregion
