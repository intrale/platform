package ext.auth

import ar.com.intrale.BuildKonfig
import io.ktor.client.HttpClient
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.isSuccess
import io.ktor.utils.io.InternalAPI
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import ext.dto.StatusCodeDTO

class ClientPasswordRecoveryService(private val httpClient: HttpClient) : CommPasswordRecoveryService {
    @OptIn(InternalAPI::class)
    override suspend fun recovery(email: String): Result<PasswordRecoveryResponse> {
        return try {
            val response: HttpResponse = httpClient.post("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/recovery") {
                setBody(PasswordRecoveryRequest(email))
            }
            if (response.status.isSuccess()) {
                Result.success(
                    PasswordRecoveryResponse(StatusCodeDTO(response.status.value, response.status.description))
                )
            } else {
                val bodyText = response.bodyAsText()
                val exception = Json.decodeFromString(ExceptionResponse.serializer(), bodyText)
                Result.failure(exception)
            }
        } catch (e: Exception) {
            Result.failure(e.toExceptionResponse())
        }
    }

    @OptIn(InternalAPI::class)
    override suspend fun confirm(email: String, code: String, password: String): Result<PasswordRecoveryResponse> {
        return try {
            val response: HttpResponse = httpClient.post("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/confirm") {
                setBody(ConfirmPasswordRecoveryRequest(email, code, password))
            }
            if (response.status.isSuccess()) {
                Result.success(
                    PasswordRecoveryResponse(StatusCodeDTO(response.status.value, response.status.description))
                )
            } else {
                val bodyText = response.bodyAsText()
                val exception = Json.decodeFromString(ExceptionResponse.serializer(), bodyText)
                Result.failure(exception)
            }
        } catch (e: Exception) {
            Result.failure(e.toExceptionResponse())
        }
    }
}

@Serializable
data class PasswordRecoveryRequest(val email: String)

@Serializable
data class ConfirmPasswordRecoveryRequest(val email: String, val code: String, val password: String)

@Serializable
data class PasswordRecoveryResponse(val statusCode: StatusCodeDTO)
