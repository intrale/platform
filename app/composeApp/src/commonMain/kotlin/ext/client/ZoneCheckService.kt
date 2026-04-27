package ext.client

import ar.com.intrale.BuildKonfig
import ar.com.intrale.shared.client.ZoneCheckRequest
import ar.com.intrale.shared.client.ZoneCheckResponse
import io.ktor.client.HttpClient
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.isSuccess
import kotlinx.serialization.json.Json
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

/**
 * Implementación HTTPS de [CommZoneCheckService] que llama
 * `POST /{business}/zones/check` con el cuerpo `ZoneCheckRequest`.
 *
 * Privacidad (CA-5 / CA-7):
 * - Solo se loggean metadatos: `inZone`, `statusCode`, `hasCoords=true`.
 *   Nunca se imprime `latitude`/`longitude`.
 * - El endpoint es público (sin token) por requerimiento del PO/Security:
 *   el cliente verifica la zona ANTES de armar el carrito y opcionalmente
 *   sin estar autenticado.
 */
class ClientZoneCheckService(
    private val httpClient: HttpClient,
    private val json: Json,
) : CommZoneCheckService {

    private val logger = LoggerFactory.default.newLogger<ClientZoneCheckService>()

    override suspend fun checkZone(
        latitude: Double,
        longitude: Double
    ): Result<ZoneCheckResponse> {
        return try {
            logger.info { "Solicitando verificación de zona hasCoords=true" }
            val response = httpClient.post(
                "${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/zones/check"
            ) {
                setBody(ZoneCheckRequest(latitude = latitude, longitude = longitude))
            }
            Result.success(response.toZoneCheckResponse())
        } catch (throwable: Throwable) {
            logger.error(throwable) { "Error en verificación de zona" }
            Result.failure(throwable)
        }
    }

    private suspend fun HttpResponse.toZoneCheckResponse(): ZoneCheckResponse {
        val bodyText = bodyAsText()
        if (status.isSuccess()) {
            if (bodyText.isBlank()) {
                logger.warning { "Respuesta vacía status=${status.value}" }
                return ZoneCheckResponse()
            }
            return json.decodeFromString(ZoneCheckResponse.serializer(), bodyText)
        }
        logger.warning { "Verificación falló status=${status.value}" }
        throw RuntimeException("zones/check failed status=${status.value}")
    }
}
