package ext.business

import ar.com.intrale.BuildKonfig
import ar.com.intrale.shared.ExceptionResponse
import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.toExceptionResponse
import ar.com.intrale.shared.business.BusinessPaymentMethodDTO
import ar.com.intrale.shared.business.GetBusinessPaymentMethodsResponse
import ar.com.intrale.shared.business.UpdateBusinessPaymentMethodsRequest
import ar.com.intrale.shared.business.UpdateBusinessPaymentMethodsResponse
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

class ClientBusinessPaymentMethodsService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage,
    private val json: Json
) : CommBusinessPaymentMethodsService {

    private val logger = LoggerFactory.default.newLogger<ClientBusinessPaymentMethodsService>()

    override suspend fun getPaymentMethods(businessId: String): Result<List<BusinessPaymentMethodDTO>> {
        return try {
            val response = httpClient.get(
                "${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/business/$businessId/payment-methods"
            ) {
                authorize()
            }
            val bodyText = response.bodyAsText()
            if (response.status.isSuccess()) {
                val result = json.decodeFromString(GetBusinessPaymentMethodsResponse.serializer(), bodyText)
                Result.success(result.paymentMethods)
            } else {
                val exception = json.decodeFromString(ExceptionResponse.serializer(), bodyText)
                Result.failure(exception)
            }
        } catch (e: Exception) {
            logger.error { "Error al obtener medios de pago: ${e.message}" }
            Result.failure(e.toExceptionResponse())
        }
    }

    override suspend fun updatePaymentMethods(
        businessId: String,
        request: UpdateBusinessPaymentMethodsRequest
    ): Result<List<BusinessPaymentMethodDTO>> {
        return try {
            val response = httpClient.put(
                "${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/business/$businessId/payment-methods"
            ) {
                authorize()
                setBody(request)
            }
            val bodyText = response.bodyAsText()
            if (response.status.isSuccess()) {
                val result = json.decodeFromString(UpdateBusinessPaymentMethodsResponse.serializer(), bodyText)
                Result.success(result.paymentMethods)
            } else {
                val exception = json.decodeFromString(ExceptionResponse.serializer(), bodyText)
                Result.failure(exception)
            }
        } catch (e: Exception) {
            logger.error { "Error al actualizar medios de pago: ${e.message}" }
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
