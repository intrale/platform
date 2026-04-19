package ext.business

import ar.com.intrale.BuildKonfig
import io.ktor.client.HttpClient
import io.ktor.client.request.headers
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.isSuccess
import io.ktor.utils.io.InternalAPI
import ext.IntraleClientJson
import ar.com.intrale.shared.ExceptionResponse
import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.toExceptionResponse
import ar.com.intrale.shared.business.ReviewBusinessRegistrationRequest
import ar.com.intrale.shared.business.ReviewBusinessRegistrationResponse

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
                val exception = IntraleClientJson.decodeFromString(ExceptionResponse.serializer(), bodyText)
                Result.failure(exception)
            }
        } catch (e: Exception) {
            Result.failure(e.toExceptionResponse())
        }
    }
}
