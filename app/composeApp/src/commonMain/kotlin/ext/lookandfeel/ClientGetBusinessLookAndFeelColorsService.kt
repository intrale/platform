package ext.lookandfeel

import ar.com.intrale.BuildKonfig
import ext.auth.ExceptionResponse
import ext.auth.toExceptionResponse
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.parameter
import io.ktor.client.statement.bodyAsText
import io.ktor.http.isSuccess
import io.ktor.utils.io.InternalAPI
import kotlinx.serialization.json.Json

class ClientGetBusinessLookAndFeelColorsService(private val httpClient: HttpClient) :
    CommGetBusinessLookAndFeelColorsService {
    @OptIn(InternalAPI::class)
    override suspend fun execute(businessId: String): Result<BusinessLookAndFeelColorsResponseDto> {
        return try {
            val response = httpClient.get("${BuildKonfig.BASE_URL}business-look-and-feel/colors") {
                parameter("businessId", businessId)
            }
            if (response.status.isSuccess()) {
                val payload = response.bodyAsText()
                Result.success(Json.decodeFromString(BusinessLookAndFeelColorsResponseDto.serializer(), payload))
            } else {
                val payload = response.bodyAsText()
                val exception = Json.decodeFromString(ExceptionResponse.serializer(), payload)
                Result.failure(exception)
            }
        } catch (e: Exception) {
            Result.failure(e.toExceptionResponse())
        }
    }
}
