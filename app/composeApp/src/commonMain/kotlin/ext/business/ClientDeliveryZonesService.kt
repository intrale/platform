package ext.business

import ar.com.intrale.BuildKonfig
import ar.com.intrale.shared.ExceptionResponse
import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.business.DeliveryZoneDTO
import ar.com.intrale.shared.business.ListDeliveryZonesResponse
import ar.com.intrale.shared.toExceptionResponse
import ext.storage.CommKeyValueStorage
import io.ktor.client.HttpClient
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.isSuccess
import kotlinx.serialization.json.Json
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

/**
 * Cliente HTTP para listar zonas de delivery — split 1 read-only de #2420.
 *
 * Endpoint: `GET /{business}/zones` con header `Authorization: Bearer <JWT Cognito>`
 * (CA-5-L). Usa el `CommKeyValueStorage` para tomar el token del session storage.
 */
class ClientDeliveryZonesService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage,
    private val json: Json
) : CommDeliveryZonesService {

    private val logger = LoggerFactory.default.newLogger<ClientDeliveryZonesService>()

    override suspend fun list(businessId: String): Result<List<DeliveryZoneDTO>> {
        return try {
            val response = httpClient.get("${BuildKonfig.BASE_URL}$businessId/zones") {
                authorize()
            }
            val bodyText = response.bodyAsText()
            if (response.status.isSuccess()) {
                val parsed = json.decodeFromString(ListDeliveryZonesResponse.serializer(), bodyText)
                Result.success(parsed.zones)
            } else {
                val exception = json.decodeFromString(ExceptionResponse.serializer(), bodyText)
                Result.failure(exception)
            }
        } catch (e: Exception) {
            // No log payload (puede contener detalles privados); solo el message + status.
            logger.error { "Error al listar zonas de delivery: ${e.message}" }
            Result.failure(e.toExceptionResponse())
        }
    }

    private fun HttpRequestBuilder.authorize() {
        val token = keyValueStorage.token
            ?: throw ExceptionResponse(
                statusCode = StatusCodeDTO(401, "Unauthorized"),
                message = "Token no disponible"
            )
        header(HttpHeaders.Authorization, "Bearer $token")
    }
}
