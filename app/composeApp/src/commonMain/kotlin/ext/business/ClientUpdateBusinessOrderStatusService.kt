package ext.business

import ar.com.intrale.BuildKonfig
import ar.com.intrale.shared.ExceptionResponse
import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.business.BusinessOrderStatusUpdateRequestDTO
import ar.com.intrale.shared.business.BusinessOrderStatusUpdateResponseDTO
import ext.storage.CommKeyValueStorage
import io.ktor.client.HttpClient
import io.ktor.client.request.header
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.serialization.json.Json
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class ClientUpdateBusinessOrderStatusService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage,
    private val json: Json
) : CommUpdateBusinessOrderStatusService {

    private val logger = LoggerFactory.default.newLogger<ClientUpdateBusinessOrderStatusService>()

    override suspend fun updateOrderStatus(
        businessId: String,
        orderId: String,
        newStatus: String,
        reason: String?
    ): Result<BusinessOrderStatusUpdateResponseDTO> {
        return try {
            logger.info { "Actualizando estado del pedido $orderId a $newStatus" }
            val requestBody = json.encodeToString(
                BusinessOrderStatusUpdateRequestDTO.serializer(),
                BusinessOrderStatusUpdateRequestDTO(
                    orderId = orderId,
                    newStatus = newStatus,
                    reason = reason
                )
            )
            val response = httpClient.put(
                "${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/business/orders"
            ) {
                authorize()
                contentType(ContentType.Application.Json)
                setBody(requestBody)
            }
            val bodyText = response.bodyAsText()
            if (response.status.isSuccess()) {
                val parsed = runCatching {
                    json.decodeFromString(BusinessOrderStatusUpdateResponseDTO.serializer(), bodyText)
                }.getOrElse {
                    BusinessOrderStatusUpdateResponseDTO(
                        orderId = orderId,
                        newStatus = newStatus,
                        updatedAt = ""
                    )
                }
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
            logger.error { "Error al actualizar estado del pedido: ${e.message}" }
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
