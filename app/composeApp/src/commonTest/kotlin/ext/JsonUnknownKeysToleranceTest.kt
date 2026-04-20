package ext

import ar.com.intrale.shared.ExceptionResponse
import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.auth.LoginResponse
import ar.com.intrale.shared.auth.ChangePasswordResponse
import ar.com.intrale.shared.auth.PasswordRecoveryResponse
import ext.auth.ClientLoginService
import ext.auth.ClientChangePasswordService
import ext.auth.ClientPasswordRecoveryService
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

/**
 * Tests que verifican que la deserialización tolera campos desconocidos (AC-4).
 *
 * Cuando el backend agrega campos nuevos a las respuestas JSON, la app
 * NO debe crashear con SerializationException. Estos tests validan que
 * la instancia global de Json con ignoreUnknownKeys = true funciona
 * correctamente en servicios representativos.
 */
class JsonUnknownKeysToleranceTest {

    private val jsonConfig = Json { ignoreUnknownKeys = true; isLenient = true }
    private val jsonHeaders = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString())

    private fun mockClient(status: HttpStatusCode, body: String): HttpClient {
        val engine = MockEngine { respond(body, status, jsonHeaders) }
        return HttpClient(engine) {
            install(ContentNegotiation) { json(jsonConfig) }
            install(DefaultRequest) { header(HttpHeaders.ContentType, ContentType.Application.Json) }
        }
    }

    @Test
    fun `LoginResponse tolera campos desconocidos del backend`() = runTest {
        // Simula un backend que agregó campos nuevos: "newField" y "metadata"
        val body = """{
            "statusCode":{"value":200,"description":"OK"},
            "idToken":"id-tok",
            "accessToken":"access-tok",
            "refreshToken":"refresh-tok",
            "newField":"valor-inesperado",
            "metadata":{"version":2,"region":"us-east-1"}
        }"""
        val service = ClientLoginService(mockClient(HttpStatusCode.OK, body), jsonConfig)

        val result = service.execute("user@test.com", "pass123")

        assertTrue(result.isSuccess, "La deserialización no debe fallar con campos desconocidos")
        assertEquals("access-tok", result.getOrThrow().accessToken)
    }

    @Test
    fun `ExceptionResponse tolera campos desconocidos del backend`() = runTest {
        // Simula un error con campos extra
        val body = """{
            "statusCode":{"value":401,"description":"Unauthorized"},
            "message":"Credenciales invalidas",
            "errorCode":"AUTH_001",
            "traceId":"abc-123",
            "retryAfter":30
        }"""
        val service = ClientLoginService(mockClient(HttpStatusCode.Unauthorized, body), jsonConfig)

        val result = service.execute("user@test.com", "wrong")

        assertTrue(result.isFailure, "Debe retornar failure en error 401")
        val ex = result.exceptionOrNull() as ExceptionResponse
        assertEquals(401, ex.statusCode.value)
        assertEquals("Credenciales invalidas", ex.message)
    }

    @Test
    fun `ChangePasswordResponse tolera campos desconocidos del backend`() = runTest {
        val body = """{
            "statusCode":{"value":200,"description":"OK"},
            "passwordStrength":"strong",
            "expiresAt":"2026-05-01T00:00:00Z"
        }"""
        val service = ClientChangePasswordService(mockClient(HttpStatusCode.OK, body), jsonConfig)

        val result = service.execute("oldpass", "newpass", "Bearer tok")

        assertTrue(result.isSuccess, "La deserialización no debe fallar con campos desconocidos")
        assertEquals(200, result.getOrThrow().statusCode.value)
    }

    @Test
    fun `PasswordRecoveryResponse tolera campos desconocidos del backend`() = runTest {
        val body = """{
            "statusCode":{"value":200,"description":"OK"},
            "deliveryMedium":"EMAIL",
            "destination":"u***@test.com"
        }"""
        val service = ClientPasswordRecoveryService(mockClient(HttpStatusCode.OK, body), jsonConfig)

        val result = service.recovery("user@test.com")

        assertTrue(result.isSuccess, "La deserialización no debe fallar con campos desconocidos")
        assertEquals(200, result.getOrThrow().statusCode.value)
    }

    @Test
    fun `StatusCodeDTO anidado tolera campos desconocidos`() = runTest {
        // statusCode con campos extra
        val body = """{
            "statusCode":{"value":200,"description":"OK","timestamp":"2026-04-15T10:00:00Z","requestId":"req-456"},
            "idToken":"id","accessToken":"access","refreshToken":"refresh"
        }"""
        val service = ClientLoginService(mockClient(HttpStatusCode.OK, body), jsonConfig)

        val result = service.execute("user@test.com", "pass123")

        assertTrue(result.isSuccess, "Campos desconocidos en objetos anidados no deben causar fallo")
        assertEquals("access", result.getOrThrow().accessToken)
    }

    @Test
    fun `deserializacion sin ignoreUnknownKeys falla con campos extra`() {
        // Este test verifica que SIN la configuración, sí fallaría
        val strictJson = Json { ignoreUnknownKeys = false }
        val body = """{"statusCode":{"value":200,"description":"OK"},"idToken":"id","accessToken":"access","refreshToken":"refresh","campoNuevo":"valor"}"""

        val result = runCatching {
            strictJson.decodeFromString(LoginResponse.serializer(), body)
        }

        assertTrue(result.isFailure, "Sin ignoreUnknownKeys, campos desconocidos deben causar error")
    }

    @Test
    fun `deserializacion con ignoreUnknownKeys no falla con campos extra`() {
        val body = """{"statusCode":{"value":200,"description":"OK"},"idToken":"id","accessToken":"access","refreshToken":"refresh","campoNuevo":"valor"}"""

        val result = runCatching {
            jsonConfig.decodeFromString(LoginResponse.serializer(), body)
        }

        assertTrue(result.isSuccess, "Con ignoreUnknownKeys, campos desconocidos deben ignorarse")
        assertEquals("access", result.getOrThrow().accessToken)
    }
}
