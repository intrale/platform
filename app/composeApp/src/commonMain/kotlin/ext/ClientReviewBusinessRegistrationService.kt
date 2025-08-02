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

class ClientReviewBusinessRegistrationService(private val httpClient: HttpClient) : CommReviewBusinessRegistrationService {
    @OptIn(InternalAPI::class)
    override suspend fun execute(name: String, decision: String, twoFactorCode: String): Result<ReviewBusinessRegistrationResponse> {
        return try {
            val response: HttpResponse = httpClient.post("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/reviewBusiness") {
                setBody(ReviewBusinessRegistrationRequest(name, decision, twoFactorCode))
            }
            if (response.status.isSuccess()) {
                Result.success(ReviewBusinessRegistrationResponse(StatusCodeDTO(response.status.value, response.status.description)))
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
data class ReviewBusinessRegistrationRequest(val name: String, val decision: String, val twoFactorCode: String)

@Serializable
data class ReviewBusinessRegistrationResponse(val statusCode: StatusCodeDTO)
