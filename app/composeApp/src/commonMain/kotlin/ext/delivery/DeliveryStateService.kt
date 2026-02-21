package ext.delivery

import ar.com.intrale.BuildKonfig
import ext.dto.StatusCodeDTO
import ext.storage.CommKeyValueStorage
import io.ktor.client.HttpClient
import io.ktor.client.request.header
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.isSuccess
import kotlinx.serialization.json.Json
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DeliveryStateService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage
) : CommDeliveryStateService {

    private val logger = LoggerFactory.default.newLogger<DeliveryStateService>()

    override suspend fun changeState(
        orderId: String,
        newState: String
    ): Result<DeliveryStateChangeResponse> = runCatching {
        logger.info { "[Delivery][StateChange] Cambiando estado de entrega del pedido $orderId a $newState" }
        val response = httpClient.put("${BuildKonfig.BASE_URL}${BuildKonfig.DELIVERY}/orders/$orderId/state") {
            authorize()
            setBody(DeliveryStateChangeRequest(orderId = orderId, state = newState))
        }
        response.toResult(DeliveryStateChangeResponse.serializer())
    }.recoverCatching { throwable ->
        logger.error(throwable) { "[Delivery][StateChange] Error al cambiar estado de entrega del pedido $orderId" }
        throw throwable.toDeliveryException()
    }

    private fun io.ktor.client.request.HttpRequestBuilder.authorize() {
        val token = keyValueStorage.token
            ?: throw DeliveryExceptionResponse(
                message = "Token no disponible",
                statusCode = StatusCodeDTO(401, "Unauthorized")
            )
        header(HttpHeaders.Authorization, "Bearer $token")
    }

    private suspend fun <T> HttpResponse.toResult(deserializer: kotlinx.serialization.DeserializationStrategy<T>): T {
        val bodyText = bodyAsText()
        if (!status.isSuccess()) {
            throw bodyText.toDeliveryException()
        }
        if (bodyText.isBlank()) {
            throw DeliveryExceptionResponse(message = "Respuesta vacía del servidor")
        }
        return Json.decodeFromString(deserializer, bodyText)
    }
}
