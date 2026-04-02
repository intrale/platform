package ext.client

import ar.com.intrale.BuildKonfig
import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.client.PaymentStatusResponseDTO
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

class PaymentStatusService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage
) : CommPaymentStatusService {

    private val logger = LoggerFactory.default.newLogger<PaymentStatusService>()

    override suspend fun checkPaymentStatus(orderId: String): Result<PaymentStatusResponseDTO> {
        return try {
            logger.info { "Consultando estado de pago para orden $orderId" }
            val response = httpClient.get(
                "${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/client/payment-status/$orderId"
            ) {
                authorize()
            }
            val bodyText = response.bodyAsText()
            if (response.status.isSuccess()) {
                val parsed = Json.decodeFromString(PaymentStatusResponseDTO.serializer(), bodyText)
                Result.success(parsed)
            } else {
                Result.failure(bodyText.toClientException())
            }
        } catch (throwable: Throwable) {
            logger.error(throwable) { "Error al consultar estado de pago" }
            Result.failure(throwable.toClientException())
        }
    }

    private fun String.toClientException(): ClientExceptionResponse =
        runCatching { Json.decodeFromString(ClientExceptionResponse.serializer(), this) }
            .getOrElse { ClientExceptionResponse(message = this) }

    private fun io.ktor.client.request.HttpRequestBuilder.authorize() {
        val token = keyValueStorage.token
            ?: throw ClientExceptionResponse(
                message = "Token no disponible",
                statusCode = StatusCodeDTO(401, "Unauthorized")
            )
        header(HttpHeaders.Authorization, "Bearer $token")
    }
}
