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
import kotlinx.serialization.json.Json
import ar.com.intrale.shared.ExceptionResponse
import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.toExceptionResponse
import ar.com.intrale.shared.auth.RegisterSalerRequest
import ar.com.intrale.shared.auth.RegisterSalerResponse

class ClientRegisterSalerService(private val httpClient: HttpClient, private val json: Json) : CommRegisterSalerService {
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
                val exception = json.decodeFromString(ExceptionResponse.serializer(), bodyText)
                Result.failure(exception)
            }
        } catch (e: Exception) {
            Result.failure(e.toExceptionResponse())
        }
    }
}
