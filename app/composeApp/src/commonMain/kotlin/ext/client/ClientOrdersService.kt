package ext.client

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
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class ClientOrdersService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage
) : CommClientOrdersService {

    private val logger = LoggerFactory.default.newLogger<ClientOrdersService>()

    override suspend fun listOrders(): Result<List<ClientOrderDTO>> {
        return try {
            logger.info { "Listando pedidos del cliente" }
            val response = httpClient.get("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/client/orders") {
                authorize()
            }
            Result.success(response.toOrders())
        } catch (throwable: Throwable) {
            logger.error(throwable) { "Error al listar pedidos" }
            Result.failure(throwable.toClientException())
        }
    }

    override suspend fun fetchOrderDetail(orderId: String): Result<ClientOrderDetailDTO> {
        return try {
            logger.info { "Obteniendo detalle del pedido $orderId" }
            val response = httpClient.get("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/client/orders/$orderId") {
                authorize()
            }
            Result.success(response.toOrderDetail())
        } catch (throwable: Throwable) {
            logger.error(throwable) { "Error al obtener detalle del pedido" }
            Result.failure(throwable.toClientException())
        }
    }

    private suspend fun HttpResponse.toOrders(): List<ClientOrderDTO> {
        val bodyText = bodyAsText()
        if (status.isSuccess()) {
            if (bodyText.isBlank()) return emptyList()
            val parsedResponse = runCatching {
                Json.decodeFromString(ClientOrdersResponse.serializer(), bodyText).orders
            }.getOrNull()
            if (parsedResponse != null) {
                return parsedResponse
            }
            return Json.decodeFromString(ListSerializer(ClientOrderDTO.serializer()), bodyText)
        }
        throw bodyText.toClientException()
    }

    private suspend fun HttpResponse.toOrderDetail(): ClientOrderDetailDTO {
        val bodyText = bodyAsText()
        if (status.isSuccess()) {
            if (bodyText.isBlank()) return ClientOrderDetailDTO()
            val parsedResponse = runCatching {
                Json.decodeFromString(ClientOrderDetailResponse.serializer(), bodyText).order
            }.getOrNull()
            if (parsedResponse != null) {
                return parsedResponse
            }
            return Json.decodeFromString(ClientOrderDetailDTO.serializer(), bodyText)
        }
        throw bodyText.toClientException()
    }

    private fun String.toClientException(): ClientExceptionResponse =
        runCatching { Json.decodeFromString(ClientExceptionResponse.serializer(), this) }
            .getOrElse { ClientExceptionResponse(message = this) }

    private fun io.ktor.client.request.HttpRequestBuilder.authorize() {
        val token = keyValueStorage.token
            ?: throw ClientExceptionResponse(message = "Token no disponible", statusCode = StatusCodeDTO(401, "Unauthorized"))
        header(HttpHeaders.Authorization, "Bearer $token")
    }
}
