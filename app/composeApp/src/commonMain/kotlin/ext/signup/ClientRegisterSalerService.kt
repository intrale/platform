package ext.signup

import ar.com.intrale.BuildKonfig
import io.ktor.client.HttpClient
import io.ktor.client.request.headers
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.client.statement.HttpResponse
import io.ktor.http.isSuccess
import io.ktor.utils.io.InternalAPI
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import ext.auth.ExceptionResponse
import ext.auth.toExceptionResponse
import ext.dto.StatusCodeDTO

class ClientRegisterSalerService(private val httpClient: HttpClient) : CommRegisterSalerService {
    @OptIn(InternalAPI::class)
    override suspend fun execute(email: String, token: String): Result<RegisterSalerResponse> {
        return try {
            val response: HttpResponse = httpClient.post("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/registerSaler") {
                headers { append("Authorization", token) }
                setBody(RegisterSalerRequest(email))
            }
            if (response.status.isSuccess()) {
                Result.success(
                    RegisterSalerResponse(StatusCodeDTO(response.status.value, response.status.description))
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
data class RegisterSalerRequest(val email: String)

@Serializable
data class RegisterSalerResponse(val statusCode: StatusCodeDTO)
