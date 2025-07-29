package ext

import io.ktor.client.HttpClient
import io.ktor.client.request.headers
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import ar.com.intrale.BuildKonfig
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import io.ktor.client.statement.bodyAsText
import io.ktor.client.statement.HttpResponse
import io.ktor.http.isSuccess
import kotlinx.serialization.json.Json
import kotlinx.serialization.Serializable

class ClientLoginService(val httpClient: HttpClient) : CommLoginService {

    private val logger = LoggerFactory.default.newLogger<ClientLoginService>()

    override suspend fun execute(
        user: String,
        password: String,
        newPassword: String?,
        name: String?,
        familyName: String?
    ): Result<LoginResponse> {
        return try {
            val response: HttpResponse =
                httpClient.post("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/signin") {
                    headers {
                        // Agregá headers si los necesitás
                    }
                    setBody(LoginRequest(user, password, newPassword, name, familyName))
                }

            val bodyText = response.bodyAsText()

            if (response.status.isSuccess()) {
                val loginResponse = Json.decodeFromString(LoginResponse.serializer(), bodyText)
                logger.debug { "response body: $loginResponse" }
                Result.success(loginResponse)
            } else {
                val exceptionResponse = Json.decodeFromString(ExceptionResponse.serializer(), bodyText)
                logger.debug { "login failed with status: $exceptionResponse" }
                Result.failure(exceptionResponse)
            }

        } catch (e: Exception) {
            logger.error { "login error: ${e.message}" }
            Result.failure(e.toExceptionResponse())
        }
    }
}

@Serializable
data class LoginRequest(
    val email: String,
    val password: String,
    val newPassword: String? = null,
    val name: String? = null,
    val familyName: String? = null
)

@Serializable
data class StatusCodeDTO (val value: Int, val description: String?)

@Serializable
data class LoginResponse(val statusCode: StatusCodeDTO, val idToken: String, val accessToken: String, val refreshToken: String)

@Serializable
data class ExceptionResponse(val statusCode: StatusCodeDTO, override val message: String? = null): Throwable(message)

fun Exception.toExceptionResponse(): ExceptionResponse = ExceptionResponse(
        statusCode = StatusCodeDTO(500, "Internal Server Error"),
        message = this.message ?: "An unexpected error occurred"
    )
