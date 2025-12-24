package ext.auth

import ar.com.intrale.BuildKonfig
import io.ktor.client.HttpClient
import io.ktor.client.request.headers
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.isSuccess
import kotlinx.serialization.json.Json
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DeliveryLoginService(private val httpClient: HttpClient) : CommLoginService {

    private val logger = LoggerFactory.default.newLogger<DeliveryLoginService>()

    override suspend fun execute(
        user: String,
        password: String,
        newPassword: String?,
        name: String?,
        familyName: String?
    ): Result<LoginResponse> {
        return try {
            logger.info { "[Delivery][Login] Enviando credenciales para ${BuildKonfig.DELIVERY}" }

            val response: HttpResponse =
                httpClient.post("${BuildKonfig.BASE_URL}${BuildKonfig.DELIVERY}/signin") {
                    headers {
                        // Agregá headers si los necesitás
                    }
                    setBody(LoginRequest(user, password, newPassword, name, familyName))
                }

            val bodyText = response.bodyAsText()

            if (response.status.isSuccess()) {
                val loginResponse = Json.decodeFromString(LoginResponse.serializer(), bodyText)
                logger.info { "[Delivery][Login] Respuesta exitosa para ${BuildKonfig.DELIVERY}" }
                Result.success(loginResponse)
            } else {
                val exceptionResponse = Json.decodeFromString(ExceptionResponse.serializer(), bodyText)
                logger.warn { "[Delivery][Login] Error ${exceptionResponse.statusCode}: ${exceptionResponse.message}" }
                Result.failure(exceptionResponse)
            }

        } catch (e: Exception) {
            logger.error { "[Delivery][Login] Error inesperado: ${e.message}" }
            Result.failure(e.toExceptionResponse())
        }
    }
}
