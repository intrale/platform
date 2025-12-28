package ext.delivery

import ar.com.intrale.BuildKonfig
import ext.dto.StatusCodeDTO
import ext.storage.CommKeyValueStorage
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.isSuccess
import kotlinx.datetime.LocalDate
import kotlinx.serialization.json.Json
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DeliveryOrdersService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage
) : CommDeliveryOrdersService {

    private val logger = LoggerFactory.default.newLogger<DeliveryOrdersService>()

    override suspend fun fetchSummary(date: LocalDate): Result<DeliveryOrdersSummaryDTO> = runCatching {
        logger.info { "[Delivery][Home] Solicitando resumen de pedidos para $date" }
        val response = httpClient.get("${BuildKonfig.BASE_URL}${BuildKonfig.DELIVERY}/orders/summary") {
            authorize()
            url.parameters.append("date", date.toString())
        }
        response.toResult(DeliveryOrdersSummaryDTO.serializer())
    }.recoverCatching { throwable ->
        logger.error(throwable) { "[Delivery][Home] Error al obtener resumen de pedidos" }
        throw throwable.toDeliveryException()
    }

    override suspend fun fetchActiveOrders(): Result<List<DeliveryOrderDTO>> = runCatching {
        logger.info { "[Delivery][Home] Solicitando pedidos activos" }
        val response = httpClient.get("${BuildKonfig.BASE_URL}${BuildKonfig.DELIVERY}/orders/active") {
            authorize()
        }
        response.toResult(ListSerializer(DeliveryOrderDTO.serializer()))
    }.recoverCatching { throwable ->
        logger.error(throwable) { "[Delivery][Home] Error al obtener pedidos activos" }
        throw throwable.toDeliveryException()
    }

    override suspend fun fetchAvailableOrders(): Result<List<DeliveryOrderDTO>> = runCatching {
        logger.info { "[Delivery][Home] Solicitando pedidos disponibles" }
        val response = httpClient.get("${BuildKonfig.BASE_URL}${BuildKonfig.DELIVERY}/orders/available") {
            authorize()
        }
        response.toResult(ListSerializer(DeliveryOrderDTO.serializer()))
    }.recoverCatching { throwable ->
        logger.error(throwable) { "[Delivery][Home] Error al obtener pedidos disponibles" }
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

private fun <T> ListSerializer(serializer: kotlinx.serialization.KSerializer<T>) =
    kotlinx.serialization.builtins.ListSerializer(serializer)
