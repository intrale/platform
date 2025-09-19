package ext.auth

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
import ext.dto.StatusCodeDTO

class ClientTwoFactorVerifyService(private val httpClient: HttpClient) : CommTwoFactorVerifyService {
    @OptIn(InternalAPI::class)
    override suspend fun execute(code: String, token: String): Result<TwoFactorVerifyResponse> {
        return try {
            val response: HttpResponse = httpClient.post("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/2faverify") {
                headers { append("Authorization", token) }
                setBody(TwoFactorVerifyRequest(code))
            }
            if (response.status.isSuccess()) {
                Result.success(
                    TwoFactorVerifyResponse(StatusCodeDTO(response.status.value, response.status.description))
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
private data class TwoFactorVerifyRequest(val code: String)

@Serializable
data class TwoFactorVerifyResponse(val statusCode: StatusCodeDTO)

