package ext.lookandfeel

import ar.com.intrale.BuildKonfig
import ext.auth.ExceptionResponse
import ext.auth.toExceptionResponse
import io.ktor.client.HttpClient
import io.ktor.client.request.headers
import io.ktor.client.request.parameter
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.isSuccess
import io.ktor.utils.io.InternalAPI
import kotlinx.serialization.json.Json

class ClientUpsertBusinessLookAndFeelColorsService(private val httpClient: HttpClient) :
    CommUpsertBusinessLookAndFeelColorsService {
    @OptIn(InternalAPI::class)
    override suspend fun execute(
        businessId: String,
        token: String,
        request: UpdateBusinessLookAndFeelColorsRequestDto
    ): Result<BusinessLookAndFeelColorsResponseDto> {
        return try {
            val response = httpClient.put("${BuildKonfig.BASE_URL}business-look-and-feel/colors") {
                parameter("businessId", businessId)
                headers { append("Authorization", token) }
                setBody(request)
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
