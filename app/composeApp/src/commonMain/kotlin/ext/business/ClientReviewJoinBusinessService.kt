package ext.business

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

class ClientReviewJoinBusinessService(private val httpClient: HttpClient) : CommReviewJoinBusinessService {
    @OptIn(InternalAPI::class)
    override suspend fun execute(business: String, email: String, decision: String): Result<ReviewJoinBusinessResponse> {
        return try {
            val response: HttpResponse = httpClient.post("${BuildKonfig.BASE_URL}${business}/reviewJoinBusiness") {
                setBody(ReviewJoinBusinessRequest(email, decision))
            }
            if (response.status.isSuccess()) {
                Result.success(ReviewJoinBusinessResponse(StatusCodeDTO(response.status.value, response.status.description)))
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
data class ReviewJoinBusinessRequest(val email: String, val decision: String)

@Serializable
data class ReviewJoinBusinessResponse(val statusCode: StatusCodeDTO)
