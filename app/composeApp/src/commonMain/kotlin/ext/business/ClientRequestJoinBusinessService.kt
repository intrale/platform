package ext.business

import ar.com.intrale.BuildKonfig
import io.ktor.client.HttpClient
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.isSuccess
import io.ktor.utils.io.InternalAPI
import kotlinx.serialization.json.Json
import ar.com.intrale.shared.ExceptionResponse
import ar.com.intrale.shared.toExceptionResponse
import ar.com.intrale.shared.business.RequestJoinBusinessRequest
import ar.com.intrale.shared.business.RequestJoinBusinessResponse

class ClientRequestJoinBusinessService(private val httpClient: HttpClient) : CommRequestJoinBusinessService {
    @OptIn(InternalAPI::class)
    override suspend fun execute(business: String): Result<RequestJoinBusinessResponse> {
        return try {
            val response: HttpResponse = httpClient.post("${BuildKonfig.BASE_URL}${business}/requestJoinBusiness") {
                setBody(RequestJoinBusinessRequest())
            }
            if (response.status.isSuccess()) {
                val bodyText = response.bodyAsText()
                val result = Json.decodeFromString(RequestJoinBusinessResponse.serializer(), bodyText)
                Result.success(result)
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
