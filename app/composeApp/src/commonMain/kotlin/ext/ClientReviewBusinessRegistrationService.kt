package ext

import ar.com.intrale.BuildKonfig
import io.ktor.client.HttpClient
import io.ktor.client.request.headers
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
    override suspend fun execute(
        publicId: String,
        decision: String,
        twoFactorCode: String,
        token: String
    ): Result<ReviewBusinessRegistrationResponse> {
        return try {
            val response: HttpResponse = httpClient.post("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/reviewBusiness") {
                headers { append("Authorization", token) }
                setBody(ReviewBusinessRegistrationRequest(publicId, decision, twoFactorCode))
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
data class ReviewBusinessRegistrationRequest(val publicId: String, val decision: String, val twoFactorCode: String)

@Serializable
data class ReviewBusinessRegistrationResponse(val statusCode: StatusCodeDTO)
