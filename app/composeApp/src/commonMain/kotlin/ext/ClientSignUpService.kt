package ext

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
import ext.StatusCodeDTO
import ext.ExceptionResponse
import ext.toExceptionResponse

class ClientSignUpService(private val httpClient: HttpClient) : CommSignUpService {
    @OptIn(InternalAPI::class)
    override suspend fun execute(email: String): Result<SignUpResponse> {

        return try {
            val response: HttpResponse = httpClient.post("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/signup") {
                setBody(SignUpRequest(email))
            }

            if (response.status.isSuccess()) {
                Result.success(
                    SignUpResponse(StatusCodeDTO(response.status.value, response.status.description))
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
data class SignUpRequest(val email: String)

@Serializable
data class SignUpResponse(val statusCode: StatusCodeDTO)
