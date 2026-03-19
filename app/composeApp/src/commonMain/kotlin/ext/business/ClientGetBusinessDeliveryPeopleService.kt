package ext.business

import ar.com.intrale.BuildKonfig
import ar.com.intrale.shared.ExceptionResponse
import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.business.DeliveryPersonListResponseDTO
import ar.com.intrale.shared.business.DeliveryPersonSummaryDTO
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

class ClientGetBusinessDeliveryPeopleService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage
) : CommGetBusinessDeliveryPeopleService {

    private val logger = LoggerFactory.default.newLogger<ClientGetBusinessDeliveryPeopleService>()
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    override suspend fun listDeliveryPeople(businessId: String): Result<List<DeliveryPersonSummaryDTO>> {
        return try {
            logger.info { "Listando repartidores del negocio $businessId" }
            val response = httpClient.get(
                "${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/business/orders/delivery-people"
            ) {
                authorize()
            }
            val bodyText = response.bodyAsText()
            if (response.status.isSuccess()) {
                val parsed = runCatching {
                    json.decodeFromString(
                        DeliveryPersonListResponseDTO.serializer(), bodyText
                    ).deliveryPeople ?: emptyList()
                }.getOrElse { emptyList() }
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
            logger.error { "Error al listar repartidores: ${e.message}" }
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
