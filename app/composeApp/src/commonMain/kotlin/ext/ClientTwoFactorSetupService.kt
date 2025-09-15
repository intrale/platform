package ext

import ar.com.intrale.BuildKonfig
import io.ktor.client.HttpClient
import io.ktor.client.request.headers
import io.ktor.client.request.post
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.isSuccess
import io.ktor.utils.io.InternalAPI
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

class ClientTwoFactorSetupService(private val httpClient: HttpClient) : CommTwoFactorSetupService {
    @OptIn(InternalAPI::class)
    override suspend fun execute(token: String): Result<TwoFactorSetupResponse> {
        return try {
            val response: HttpResponse = httpClient.post("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/2fasetup") {
                headers { append("Authorization", token) }
            }
            val bodyText = response.bodyAsText()
            if (response.status.isSuccess()) {
                val twoFactorSetupResponse = Json.decodeFromString(TwoFactorSetupResponse.serializer(), bodyText)
                Result.success(twoFactorSetupResponse )
            } else {
                val exception = Json.decodeFromString(ExceptionResponse.serializer(), bodyText)
                Result.failure(exception)
            }
        } catch (e: Exception) {
            Result.failure(e.toExceptionResponse())
        }
    }
}

@Serializable
data class TwoFactorSetupResponse(val statusCode: StatusCodeDTO, val otpAuthUri: String)

