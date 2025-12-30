package ext.delivery

import ar.com.intrale.BuildKonfig
import ext.dto.StatusCodeDTO
import ext.storage.CommKeyValueStorage
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.isSuccess
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DeliveryAvailabilityService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage
) : CommDeliveryAvailabilityService {

    private val logger = LoggerFactory.default.newLogger<DeliveryAvailabilityService>()
    private val json = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }

    override suspend fun fetchAvailability(): Result<DeliveryAvailabilityDTO> = runCatching {
        logger.info { "[Delivery][Disponibilidad] Consultando disponibilidad del repartidor" }
        val response = httpClient.get("${BuildKonfig.BASE_URL}${BuildKonfig.DELIVERY}/profile/availability") {
            authorize()
        }
        response.toAvailabilityResponse()
    }.recoverCatching { throwable ->
        logger.warning(throwable) { "[Delivery][Disponibilidad] Usando disponibilidad vacía por error" }
        DeliveryAvailabilityDTO(
            timezone = "UTC",
            slots = emptyList()
        )
    }

    override suspend fun updateAvailability(config: DeliveryAvailabilityDTO): Result<DeliveryAvailabilityDTO> = runCatching {
        logger.info { "[Delivery][Disponibilidad] Enviando disponibilidad" }
        val response = httpClient.put("${BuildKonfig.BASE_URL}${BuildKonfig.DELIVERY}/profile/availability") {
            authorize()
            setBody(config)
        }
        response.toAvailabilityResponse()
    }.recoverCatching { throwable ->
        logger.warning(throwable) { "[Delivery][Disponibilidad] Error al guardar, conservando cambios locales" }
        config
    }

    private suspend fun HttpResponse.toAvailabilityResponse(): DeliveryAvailabilityDTO {
        val text = bodyAsText()
        if (status.isSuccess()) {
            if (text.isBlank()) return DeliveryAvailabilityDTO(timezone = "UTC")
            return json.decodeFromString(DeliveryAvailabilityDTO.serializer(), text)
        }
        throw text.toDeliveryException()
    }

    private fun io.ktor.client.request.HttpRequestBuilder.authorize() {
        val token = keyValueStorage.token
            ?: throw DeliveryExceptionResponse(
                message = "Token no disponible",
                statusCode = StatusCodeDTO(401, "Unauthorized")
            )
        header(HttpHeaders.Authorization, "Bearer $token")
    }
}
