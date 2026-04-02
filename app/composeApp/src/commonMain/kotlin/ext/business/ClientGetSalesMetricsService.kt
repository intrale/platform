package ext.business

import ar.com.intrale.BuildKonfig
import ar.com.intrale.shared.ExceptionResponse
import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.toExceptionResponse
import ar.com.intrale.shared.business.DailySalesMetricsDTO
import ar.com.intrale.shared.business.DailySalesMetricsResponseDTO
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

class ClientGetSalesMetricsService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage
) : CommGetSalesMetricsService {

    private val logger = LoggerFactory.default.newLogger<ClientGetSalesMetricsService>()

    override suspend fun execute(businessId: String): Result<DailySalesMetricsDTO> {
        return try {
            val response = httpClient.get("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/business/sales-metrics") {
                authorize()
            }
            val bodyText = response.bodyAsText()
            if (response.status.isSuccess()) {
                val result = Json.decodeFromString(DailySalesMetricsResponseDTO.serializer(), bodyText)
                Result.success(result.metrics ?: DailySalesMetricsDTO())
            } else {
                val exception = Json.decodeFromString(ExceptionResponse.serializer(), bodyText)
                Result.failure(exception)
            }
        } catch (e: Exception) {
            logger.error { "Error al obtener metricas de ventas: ${e.message}" }
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
