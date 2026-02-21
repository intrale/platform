package ext.signup

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
import ext.auth.ExceptionResponse
import ext.auth.toExceptionResponse
import ext.dto.StatusCodeDTO

class ClientConfirmSignUpService(private val httpClient: HttpClient) : CommConfirmSignUpService {
    @OptIn(InternalAPI::class)
    override suspend fun execute(email: String, code: String): Result<ConfirmSignUpResponse> {
        return try {
            val response: HttpResponse = httpClient.post("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/confirmSignUp") {
                setBody(ConfirmSignUpRequest(email, code))
            }

            if (response.status.isSuccess()) {
                Result.success(
                    ConfirmSignUpResponse(StatusCodeDTO(response.status.value, response.status.description))
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
data class ConfirmSignUpRequest(val email: String, val code: String)

@Serializable
data class ConfirmSignUpResponse(val statusCode: StatusCodeDTO)
