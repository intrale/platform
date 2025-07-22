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

    override suspend fun execute(user: String, password: String): Result<LoginResponse> {
        return try {
            val response: HttpResponse =
                httpClient.post("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/signin") {
                    headers {
                        // Agregá headers si los necesitás
                    }
                    setBody(LoginRequest(user, password))
                }

            val bodyText = response.bodyAsText()

            if (response.status.isSuccess()) {
                val loginResponse = Json.decodeFromString(LoginResponse.serializer(), bodyText)
                logger.debug { "response body: $loginResponse" }
                Result.success(loginResponse)
            } else {
                val exceptionResponse = Json.decodeFromString(ExceptionResponse.serializer(), bodyText)
                logger.debug { "login failed with status: $exceptionResponse" }
                Result.failure(Exception("Login fallido: $bodyText"))
            }

        } catch (e: Exception) {
            logger.error { "login error: ${e.message}" }
            Result.failure(e)
        }
    }
}

@Serializable
data class LoginRequest(val email:String, val password: String)

@Serializable
data class StatusCode (val value: Int, val description: String?)

@Serializable
data class LoginResponse(val statusCode: StatusCode, val idToken: String, val accessToken: String, val refreshToken: String)

@Serializable
data class ExceptionResponse(val statusCode: StatusCode, val message: String?)