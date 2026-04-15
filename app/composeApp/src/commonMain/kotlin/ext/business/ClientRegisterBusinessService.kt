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
import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.toExceptionResponse
import ar.com.intrale.shared.business.RegisterBusinessRequest
import ar.com.intrale.shared.business.RegisterBusinessResponse

class ClientRegisterBusinessService(private val httpClient: HttpClient, private val json: Json) : CommRegisterBusinessService {
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
                val exception = json.decodeFromString(ExceptionResponse.serializer(), bodyText)
                Result.failure(exception)
            }
        } catch (e: Exception) {
            Result.failure(e.toExceptionResponse())
        }
    }
}
