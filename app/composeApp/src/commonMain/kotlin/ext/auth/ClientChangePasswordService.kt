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
import kotlinx.serialization.json.Json
import ar.com.intrale.shared.ExceptionResponse
import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.toExceptionResponse
import ar.com.intrale.shared.auth.ChangePasswordRequest
import ar.com.intrale.shared.auth.ChangePasswordResponse

class ClientChangePasswordService(private val httpClient: HttpClient, private val json: Json) : CommChangePasswordService {
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
                val exception = json.decodeFromString(ExceptionResponse.serializer(), bodyText)
                Result.failure(exception)
            }
        } catch (e: Exception) {
            Result.failure(e.toExceptionResponse())
        }
    }
}
