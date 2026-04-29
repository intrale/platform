package ext.client

import ar.com.intrale.BuildKonfig
import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.client.PaymentMethodDTO
import ar.com.intrale.shared.client.PaymentMethodsResponse
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

class PaymentMethodsService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage,
    private val json: Json
) : CommPaymentMethodsService {

    private val logger = LoggerFactory.default.newLogger<PaymentMethodsService>()

    override suspend fun listPaymentMethods(): Result<List<PaymentMethodDTO>> {
        return try {
            logger.info { "Listando medios de pago habilitados" }
            val response = httpClient.get(
                "${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/client/payment-methods"
            ) {
                authorize()
            }
            Result.success(response.toPaymentMethods())
        } catch (throwable: Throwable) {
            logger.error(throwable) { "Error al listar medios de pago" }
            Result.failure(throwable.toClientException())
        }
    }

    private suspend fun HttpResponse.toPaymentMethods(): List<PaymentMethodDTO> {
        val bodyText = bodyAsText()
        if (status.isSuccess()) {
            if (bodyText.isBlank()) return emptyList()
            val parsedResponse = runCatching {
                json.decodeFromString(PaymentMethodsResponse.serializer(), bodyText).paymentMethods
            }.getOrNull()
            if (parsedResponse != null) {
                return parsedResponse
            }
            return json.decodeFromString(ListSerializer(PaymentMethodDTO.serializer()), bodyText)
        }
        throw bodyText.toClientException()
    }

    private fun String.toClientException(): ClientExceptionResponse =
        runCatching { json.decodeFromString(ClientExceptionResponse.serializer(), this) }
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
