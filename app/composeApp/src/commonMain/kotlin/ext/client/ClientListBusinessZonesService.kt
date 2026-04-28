package ext.client

import ar.com.intrale.BuildKonfig
import ar.com.intrale.shared.client.ListBusinessZonesResponse
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.isSuccess
import kotlinx.serialization.json.Json
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

/**
 * Implementacion HTTP del service publico de zonas (issue #2423 + #2415).
 *
 * - URL forzada en HTTPS por `BuildKonfig.BASE_URL`.
 * - Sin header `Authorization` (endpoint publico).
 * - Sin logs con coordenadas / direcciones / lat / lng (Security A09).
 *
 * El path es `${BASE_URL}${businessId}/zones`. El dispatcher del backend
 * usa el primer segmento como businessId y el segundo como funcionKey
 * (`zones`).
 */
class ClientListBusinessZonesService(
    private val httpClient: HttpClient,
    private val json: Json,
) : CommListBusinessZonesService {

    private val logger = LoggerFactory.default.newLogger<ClientListBusinessZonesService>()

    override suspend fun listZones(businessId: String): Result<ListBusinessZonesResponse> {
        return try {
            logger.info { "Consultando GET /$businessId/zones" }
            val response = httpClient.get("${BuildKonfig.BASE_URL}$businessId/zones")
            val bodyText = response.bodyAsText()
            if (response.status.isSuccess()) {
                val parsed = if (bodyText.isBlank()) {
                    ListBusinessZonesResponse()
                } else {
                    json.decodeFromString(ListBusinessZonesResponse.serializer(), bodyText)
                }
                Result.success(parsed)
            } else {
                Result.failure(
                    ClientExceptionResponse(message = bodyText.ifBlank { "Error HTTP ${response.status.value}" })
                )
            }
        } catch (throwable: Throwable) {
            logger.error(throwable) { "Error consultando zonas publicas para businessId=$businessId" }
            Result.failure(throwable.toClientException())
        }
    }
}
