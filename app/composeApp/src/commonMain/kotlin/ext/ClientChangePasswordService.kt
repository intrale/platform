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

class ClientChangePasswordService(private val httpClient: HttpClient) : CommChangePasswordService {
    @OptIn(InternalAPI::class)
    override suspend fun execute(oldPassword: String, newPassword: String, token: String): Result<ChangePasswordResponse> {
        return try {
            val response: HttpResponse = httpClient.post("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/changePassword") {
                headers { append("Authorization", token) }
                setBody(ChangePasswordRequest(oldPassword, newPassword))
            }
            if (response.status.isSuccess()) {
                Result.success(
                    ChangePasswordResponse(StatusCodeDTO(response.status.value, response.status.description))
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
data class ChangePasswordRequest(val oldPassword: String, val newPassword: String)

@Serializable
data class ChangePasswordResponse(val statusCode: StatusCodeDTO)
