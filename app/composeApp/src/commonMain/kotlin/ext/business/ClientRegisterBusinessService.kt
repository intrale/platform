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

class ClientRegisterBusinessService(private val httpClient: HttpClient) : CommRegisterBusinessService {
    @OptIn(InternalAPI::class)
    override suspend fun execute(name: String, emailAdmin: String, description: String): Result<RegisterBusinessResponse> {
        return try {
            val response: HttpResponse = httpClient.post("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/registerBusiness") {
                setBody(RegisterBusinessRequest(name, emailAdmin, description))
            }
            if (response.status.isSuccess()) {
                Result.success(RegisterBusinessResponse(StatusCodeDTO(response.status.value, response.status.description)))
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
data class RegisterBusinessRequest(val name: String, val emailAdmin: String, val description: String)

@Serializable
data class RegisterBusinessResponse(val statusCode: StatusCodeDTO)
