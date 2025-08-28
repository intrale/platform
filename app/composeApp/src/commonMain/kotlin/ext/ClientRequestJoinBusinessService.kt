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

@Serializable
data class RequestJoinBusinessRequest(val placeholder: String? = null)

@Serializable
data class RequestJoinBusinessResponse(val state: String)
