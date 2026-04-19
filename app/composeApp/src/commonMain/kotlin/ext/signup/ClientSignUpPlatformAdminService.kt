package ext.signup

import ar.com.intrale.BuildKonfig
import io.ktor.client.HttpClient
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
import ar.com.intrale.shared.auth.SignUpRequest
import ar.com.intrale.shared.auth.SignUpResponse

class ClientSignUpPlatformAdminService(private val httpClient: HttpClient) : CommSignUpPlatformAdminService {
    @OptIn(InternalAPI::class)
    override suspend fun execute(email: String): Result<SignUpResponse> {
        return try {
            val response: HttpResponse = httpClient.post("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/signupPlatformAdmin") {
                setBody(SignUpRequest(email))
            }
            if (response.status.isSuccess()) {
                Result.success(
                    SignUpResponse(StatusCodeDTO(response.status.value, response.status.description))
                )
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
