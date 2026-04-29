package ext.business

import ar.com.intrale.BuildKonfig
import ar.com.intrale.shared.ExceptionResponse
import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.toExceptionResponse
import ar.com.intrale.shared.business.BusinessDeliveryZoneDTO
import ar.com.intrale.shared.business.GetBusinessDeliveryZoneResponse
import ar.com.intrale.shared.business.UpdateBusinessDeliveryZoneRequest
import ar.com.intrale.shared.business.UpdateBusinessDeliveryZoneResponse
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

class ClientBusinessDeliveryZoneService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage,
    private val json: Json
) : CommBusinessDeliveryZoneService {

    private val logger = LoggerFactory.default.newLogger<ClientBusinessDeliveryZoneService>()

    override suspend fun getDeliveryZone(businessId: String): Result<BusinessDeliveryZoneDTO> {
        return try {
            val response = httpClient.get("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/business/$businessId/delivery-zone") {
                authorize()
            }
            val bodyText = response.bodyAsText()
            if (response.status.isSuccess()) {
                val result = json.decodeFromString(GetBusinessDeliveryZoneResponse.serializer(), bodyText)
                Result.success(result.deliveryZone)
            } else {
                val exception = json.decodeFromString(ExceptionResponse.serializer(), bodyText)
                Result.failure(exception)
            }
        } catch (e: Exception) {
            logger.error { "Error al obtener zona de entrega: ${e.message}" }
            Result.failure(e.toExceptionResponse())
        }
    }

    override suspend fun updateDeliveryZone(
        businessId: String,
        request: UpdateBusinessDeliveryZoneRequest
    ): Result<BusinessDeliveryZoneDTO> {
        return try {
            val response = httpClient.put("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/business/$businessId/delivery-zone") {
                authorize()
                setBody(request)
            }
            val bodyText = response.bodyAsText()
            if (response.status.isSuccess()) {
                val result = json.decodeFromString(UpdateBusinessDeliveryZoneResponse.serializer(), bodyText)
                Result.success(result.deliveryZone)
            } else {
                val exception = json.decodeFromString(ExceptionResponse.serializer(), bodyText)
                Result.failure(exception)
            }
        } catch (e: Exception) {
            logger.error { "Error al actualizar zona de entrega: ${e.message}" }
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
