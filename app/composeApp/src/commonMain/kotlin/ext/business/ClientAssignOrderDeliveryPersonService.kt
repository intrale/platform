package ext.business

import ar.com.intrale.BuildKonfig
import ar.com.intrale.shared.ExceptionResponse
import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.business.AssignOrderDeliveryPersonRequest
import ar.com.intrale.shared.business.AssignOrderDeliveryPersonResponseDTO
import ar.com.intrale.shared.business.BusinessOrderDTO
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

class ClientAssignOrderDeliveryPersonService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage,
    private val json: Json
) : CommAssignOrderDeliveryPersonService {

    private val logger = LoggerFactory.default.newLogger<ClientAssignOrderDeliveryPersonService>()
    override suspend fun assignDeliveryPerson(
        businessId: String,
        orderId: String,
        deliveryPersonEmail: String?
    ): Result<BusinessOrderDTO> {
        return try {
            logger.info { "Asignando repartidor al pedido $orderId del negocio $businessId" }
            val request = AssignOrderDeliveryPersonRequest(
                orderId = orderId,
                deliveryPersonEmail = deliveryPersonEmail
            )
            val response = httpClient.put(
                "${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/business/orders/assign"
            ) {
                authorize()
                setBody(json.encodeToString(AssignOrderDeliveryPersonRequest.serializer(), request))
            }
            val bodyText = response.bodyAsText()
            if (response.status.isSuccess()) {
                val parsed = json.decodeFromString(
                    AssignOrderDeliveryPersonResponseDTO.serializer(), bodyText
                )
                val updatedOrder = BusinessOrderDTO(
                    id = parsed.orderId,
                    assignedDeliveryPersonEmail = parsed.deliveryPersonEmail
                )
                Result.success(updatedOrder)
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
            logger.error { "Error al asignar repartidor: ${e.message}" }
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
