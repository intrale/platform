package ext.business

import ar.com.intrale.BuildKonfig
import ar.com.intrale.shared.ExceptionResponse
import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.business.BusinessOrderDetailDTO
import ar.com.intrale.shared.business.BusinessOrderDetailResponseDTO
import ext.storage.CommKeyValueStorage
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.isSuccess
import kotlinx.serialization.json.Json
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class ClientGetBusinessOrderDetailService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage,
    private val json: Json
) : CommGetBusinessOrderDetailService {

    private val logger = LoggerFactory.default.newLogger<ClientGetBusinessOrderDetailService>()

    override suspend fun getOrderDetail(businessId: String, orderId: String): Result<BusinessOrderDetailDTO> {
        return try {
            logger.info { "Obteniendo detalle del pedido $orderId del negocio $businessId" }
            val response = httpClient.get(
                "${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/business/orders/$orderId"
            ) {
                authorize()
            }
            val bodyText = response.bodyAsText()
            if (response.status.isSuccess()) {
                val parsed = runCatching {
                    json.decodeFromString(BusinessOrderDetailResponseDTO.serializer(), bodyText).order
                }.getOrNull()
                if (parsed != null) {
                    Result.success(parsed)
                } else {
                    Result.failure(
                        BusinessExceptionResponse(
                            statusCode = StatusCodeDTO(404, "Not Found"),
                            message = "No se encontro el pedido"
                        )
                    )
                }
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
            logger.error { "Error al obtener detalle del pedido: ${e.message}" }
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
