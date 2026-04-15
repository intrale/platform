package ext.business

import ar.com.intrale.BuildKonfig
import ar.com.intrale.shared.ExceptionResponse
import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.business.ToggleDeliveryPersonStatusRequestDTO
import ar.com.intrale.shared.business.ToggleDeliveryPersonStatusResponseDTO
import ext.storage.CommKeyValueStorage
import io.ktor.client.HttpClient
import io.ktor.client.request.header
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.isSuccess
import kotlinx.serialization.json.Json
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class ClientToggleDeliveryPersonStatusService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage,
    private val json: Json
) : CommToggleDeliveryPersonStatusService {

    private val logger = LoggerFactory.default.newLogger<ClientToggleDeliveryPersonStatusService>()
    override suspend fun toggleStatus(
        businessId: String,
        email: String,
        newStatus: String
    ): Result<ToggleDeliveryPersonStatusResponseDTO> {
        return try {
            logger.info { "Cambiando estado del repartidor $email a $newStatus en negocio $businessId" }
            val requestBody = json.encodeToString(
                ToggleDeliveryPersonStatusRequestDTO.serializer(),
                ToggleDeliveryPersonStatusRequestDTO(email = email, newStatus = newStatus)
            )
            val response = httpClient.put(
                "${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/business/delivery-people/status"
            ) {
                authorize()
                setBody(requestBody)
            }
            val bodyText = response.bodyAsText()
            if (response.status.isSuccess()) {
                val parsed = runCatching {
                    json.decodeFromString(ToggleDeliveryPersonStatusResponseDTO.serializer(), bodyText)
                }.getOrElse { ToggleDeliveryPersonStatusResponseDTO(email = email, newStatus = newStatus) }
                Result.success(parsed)
            } else {
                val exception = runCatching {
                    json.decodeFromString(ExceptionResponse.serializer(), bodyText)
                }.getOrElse {
                    ExceptionResponse(
                        StatusCodeDTO(response.status.value, response.status.description),
                        bodyText
                    )
                }
                Result.failure(exception)
            }
        } catch (e: Exception) {
            logger.error { "Error al cambiar estado del repartidor: ${e.message}" }
            Result.failure(e.toBusinessException())
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
