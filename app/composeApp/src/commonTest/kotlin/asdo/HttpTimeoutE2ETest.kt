package asdo

import asdo.auth.DoLogin
import asdo.signup.DoSignUp
import ar.com.intrale.shared.ExceptionResponse
import ar.com.intrale.shared.auth.LoginResponse
import ar.com.intrale.shared.auth.SignUpResponse
import ext.auth.CommLoginService
import ext.auth.ClientLoginService
import ext.signup.CommSignUpService
import ext.signup.ClientSignUpService
import ext.storage.CommKeyValueStorage
import ext.storage.model.ClientProfileCache
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.DefaultRequest
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.header
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Issue #2285 — CA-5 / CA-4: tests con `MockEngine` que simulan un timeout
 * real (engine lento + `HttpTimeout` corto en el cliente) y verifican que:
 *  1. El `Do*.kt` retorna `Result.failure` con la excepcion de dominio
 *     correspondiente (nunca la excepcion cruda del plugin de Ktor).
 *  2. El mensaje propagado al dominio NO contiene la URL usada por
 *     `MockEngine`, ni headers, ni la palabra "timeout" en ingles
 *     (CA-4, OWASP A09 — prevencion de leaks de info tecnica).
 */
class HttpTimeoutE2ETest {

    private val sensitiveHost = "https://timeout-test.intrale.local"
    private val sensitivePath = "/business/signin"
    private val sensitiveQuery = "secret_token=SHOULD_NEVER_LEAK_ABC123"
    private val sensitiveUrl = "$sensitiveHost$sensitivePath?$sensitiveQuery"

    private val jsonHeaders = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString())

    /**
     * Construye un `HttpClient` con `MockEngine` que tarda mas que el
     * timeout configurado — el plugin `HttpTimeout` dispara la excepcion real.
     */
    private fun timingOutClient(
        requestTimeoutMillis: Long = 50L,
        engineDelayMillis: Long = 10_000L,
    ): HttpClient {
        val engine = MockEngine {
            delay(engineDelayMillis)
            respond("""{"statusCode":{"value":200,"description":"OK"}}""", HttpStatusCode.OK, jsonHeaders)
        }
        return HttpClient(engine) {
            install(ContentNegotiation) { json(Json { isLenient = true; ignoreUnknownKeys = true }) }
            install(DefaultRequest) { header(HttpHeaders.ContentType, ContentType.Application.Json) }
            install(HttpTimeout) {
                this.requestTimeoutMillis = requestTimeoutMillis
            }
        }
    }

    private class FakeStorage : CommKeyValueStorage {
        override var token: String? = null
        override var profileCache: ClientProfileCache? = null
        override var preferredLanguage: String? = null
        override var onboardingCompleted: Boolean = false
    }

    /**
     * Double de `CommLoginService` que no toca HTTP: simula un timeout
     * retornando directamente un `ExceptionResponse` con status 408 y
     * mensaje generico (tal como hace `toExceptionResponse()` cuando
     * detecta una excepcion de Ktor por `simpleName`).
     *
     * Permite testear la propagacion end-to-end a traves del `Do*.kt`
     * sin depender del plugin `HttpTimeout` a nivel de engine.
     */
    private fun timingOutLoginService(
        errorMessage: String,
    ): CommLoginService = object : CommLoginService {
        override suspend fun execute(
            user: String,
            password: String,
            newPassword: String?,
            name: String?,
            familyName: String?,
        ): Result<LoginResponse> = Result.failure(
            ExceptionResponse(
                statusCode = ar.com.intrale.shared.StatusCodeDTO(408, "Request Timeout"),
                message = errorMessage,
            )
        )
    }

    private fun timingOutSignUpService(
        errorMessage: String,
    ): CommSignUpService = object : CommSignUpService {
        override suspend fun execute(email: String): Result<SignUpResponse> = Result.failure(
            ExceptionResponse(
                statusCode = ar.com.intrale.shared.StatusCodeDTO(408, "Request Timeout"),
                message = errorMessage,
            )
        )
    }

    @Test
    fun `DoLogin con MockEngine lento propaga timeout sin filtrar URL`() = runTest {
        val storage = FakeStorage()
        val service = ClientLoginService(timingOutClient())
        val sut = DoLogin(service, storage)

        val result = sut.execute("user@test.com", "pass123")

        assertTrue(result.isFailure, "login debe fallar con timeout")
        val error = result.exceptionOrNull()
        assertNotNull(error)

        val msg = error.message ?: ""
        assertFalse(msg.contains("https://"), "message filtra URL: '$msg'")
        assertFalse(msg.contains("timeout", ignoreCase = true), "message contiene 'timeout': '$msg'")
        assertFalse(msg.contains("url=", ignoreCase = true), "message contiene 'url=': '$msg'")
        assertFalse(msg.contains("Bearer", ignoreCase = true), "message filtra header: '$msg'")

        assertTrue(storage.token == null, "storage no debe haber guardado token")
    }

    @Test
    fun `DoLogin ante ExceptionResponse 408 propaga mensaje generico al dominio`() = runTest {
        val storage = FakeStorage()
        // Simulamos el mensaje generico que produce `toExceptionResponse()` al sanitizar.
        val service = timingOutLoginService("No pudimos conectarnos al servidor. Proba de nuevo en unos segundos.")
        val sut = DoLogin(service, storage)

        val result = sut.execute("user@test.com", "pass123")

        assertTrue(result.isFailure)
        val msg = result.exceptionOrNull()?.message ?: ""
        // CA-4: el mensaje propagado nunca debe contener URL sensible.
        assertFalse(msg.contains(sensitiveHost))
        assertFalse(msg.contains(sensitivePath))
        assertFalse(msg.contains(sensitiveQuery))
        // CA-2: mensaje accionable en espanol.
        assertTrue(msg.contains("servidor"), "message debe mencionar servidor: '$msg'")
        assertTrue(msg.contains("nuevo"), "message debe sugerir reintentar: '$msg'")
    }

    @Test
    fun `DoSignUp con MockEngine lento propaga timeout sin filtrar URL`() = runTest {
        val service = ClientSignUpService(timingOutClient())
        val sut = DoSignUp(service)

        val result = sut.execute("new@test.com")

        assertTrue(result.isFailure, "signup debe fallar con timeout")
        val error = result.exceptionOrNull()
        assertNotNull(error)

        val msg = error.message ?: ""
        assertFalse(msg.contains("https://"), "message filtra URL: '$msg'")
        assertFalse(msg.contains("timeout", ignoreCase = true), "message contiene 'timeout': '$msg'")
        assertFalse(msg.contains("url=", ignoreCase = true), "message contiene 'url=': '$msg'")
    }

    @Test
    fun `DoSignUp ante ExceptionResponse 408 propaga mensaje generico al dominio`() = runTest {
        val service = timingOutSignUpService("No pudimos conectarnos al servidor. Proba de nuevo en unos segundos.")
        val sut = DoSignUp(service)

        val result = sut.execute("new@test.com")

        assertTrue(result.isFailure)
        val msg = result.exceptionOrNull()?.message ?: ""
        assertFalse(msg.contains(sensitiveUrl))
        assertFalse(msg.contains(sensitiveQuery))
        assertTrue(msg.contains("servidor"))
    }
}
