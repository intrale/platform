package ext.business

import ar.com.intrale.BuildKonfig
import ar.com.intrale.shared.ExceptionResponse
import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.toExceptionResponse
import ar.com.intrale.shared.business.BusinessSchedulesDTO
import ar.com.intrale.shared.business.GetBusinessSchedulesResponse
import ar.com.intrale.shared.business.UpdateBusinessSchedulesRequest
import ar.com.intrale.shared.business.UpdateBusinessSchedulesResponse
import ext.storage.CommKeyValueStorage
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.isSuccess
import kotlinx.serialization.json.Json
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class ClientBusinessSchedulesService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage
) : CommBusinessSchedulesService {

    private val logger = LoggerFactory.default.newLogger<ClientBusinessSchedulesService>()

    override suspend fun getSchedules(businessId: String): Result<BusinessSchedulesDTO> {
        return try {
            val response = httpClient.get("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/business/$businessId/schedules") {
                authorize()
            }
            val bodyText = response.bodyAsText()
            if (response.status.isSuccess()) {
                val result = Json.decodeFromString(GetBusinessSchedulesResponse.serializer(), bodyText)
                Result.success(result.schedules)
            } else {
                val exception = Json.decodeFromString(ExceptionResponse.serializer(), bodyText)
                Result.failure(exception)
            }
        } catch (e: Exception) {
            logger.error { "Error al obtener horarios del negocio: ${e.message}" }
            Result.failure(e.toExceptionResponse())
        }
    }

    override suspend fun updateSchedules(
        businessId: String,
        request: UpdateBusinessSchedulesRequest
    ): Result<BusinessSchedulesDTO> {
        return try {
            val response = httpClient.put("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/business/$businessId/schedules") {
                authorize()
                setBody(request)
            }
            val bodyText = response.bodyAsText()
            if (response.status.isSuccess()) {
                val result = Json.decodeFromString(UpdateBusinessSchedulesResponse.serializer(), bodyText)
                Result.success(result.schedules)
            } else {
                val exception = Json.decodeFromString(ExceptionResponse.serializer(), bodyText)
                Result.failure(exception)
            }
        } catch (e: Exception) {
            logger.error { "Error al actualizar horarios del negocio: ${e.message}" }
            Result.failure(e.toExceptionResponse())
        }
    }

    private fun io.ktor.client.request.HttpRequestBuilder.authorize() {
        val token = keyValueStorage.token
            ?: throw ExceptionResponse(
                statusCode = StatusCodeDTO(401, "Unauthorized"),
                message = "Token no disponible"
            )
        header(HttpHeaders.Authorization, "Bearer $token")
    }
}
