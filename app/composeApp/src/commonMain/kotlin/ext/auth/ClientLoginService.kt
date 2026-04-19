package ext.auth

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
import ar.com.intrale.shared.ExceptionResponse
import ar.com.intrale.shared.toExceptionResponse
import ar.com.intrale.shared.auth.LoginRequest
import ar.com.intrale.shared.auth.LoginResponse
import ext.IntraleClientJson

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
                val loginResponse = IntraleClientJson.decodeFromString(LoginResponse.serializer(), bodyText)
                logger.debug { "login response received with status ${loginResponse.statusCode.value}" }
                Result.success(loginResponse)
            } else {
                val exceptionResponse = IntraleClientJson.decodeFromString(ExceptionResponse.serializer(), bodyText)
                logger.debug { "login failed with status: $exceptionResponse" }
                Result.failure(exceptionResponse)
            }

        } catch (e: Exception) {
            logger.error { "login error: ${e.message}" }
            Result.failure(e.toExceptionResponse())
        }
    }
}
