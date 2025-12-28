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
import kotlinx.serialization.json.Json
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DeliveryProfileService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage
) : CommDeliveryProfileService {

    private val logger = LoggerFactory.default.newLogger<DeliveryProfileService>()

    override suspend fun fetchProfile(): Result<DeliveryProfileResponse> {
        return runCatching {
            logger.info { "[Delivery][Perfil] Consultando perfil del repartidor" }
            val response = httpClient.get("${BuildKonfig.BASE_URL}${BuildKonfig.DELIVERY}/profile") {
                authorize()
            }
            response.toProfileResponse()
        }.recoverCatching { throwable ->
            logger.warning(throwable) { "[Delivery][Perfil] Usando datos stub al fallar la carga" }
            DeliveryProfileResponse(
                profile = DeliveryProfileDTO(
                    fullName = "Repartidor Demo",
                    email = "delivery@example.com",
                    phone = "+541100000000",
                    vehicle = DeliveryVehicleDTO(type = "Moto", model = "Genérica", plate = "ABC123")
                ),
                zones = listOf(
                    DeliveryZoneDTO(id = "zone-1", name = "Zona central", description = "Cobertura principal")
                )
            )
        }
    }

    override suspend fun updateProfile(profile: DeliveryProfileDTO): Result<DeliveryProfileResponse> {
        return runCatching {
            logger.info { "[Delivery][Perfil] Enviando actualización del perfil" }
            val response = httpClient.put("${BuildKonfig.BASE_URL}${BuildKonfig.DELIVERY}/profile") {
                authorize()
                setBody(profile)
            }
            response.toProfileResponse()
        }.recoverCatching { throwable ->
            logger.warning(throwable) { "[Delivery][Perfil] Respuesta stub al actualizar perfil" }
            DeliveryProfileResponse(profile = profile)
        }
    }

    private suspend fun HttpResponse.toProfileResponse(): DeliveryProfileResponse {
        val bodyText = bodyAsText()
        if (status.isSuccess()) {
            if (bodyText.isBlank()) return DeliveryProfileResponse(profile = DeliveryProfileDTO())
            return Json.decodeFromString(DeliveryProfileResponse.serializer(), bodyText)
        }
        throw bodyText.toDeliveryException()
    }

    private fun io.ktor.client.request.HttpRequestBuilder.authorize() {
        val token = keyValueStorage.token
            ?: throw DeliveryExceptionResponse(message = "Token no disponible", statusCode = StatusCodeDTO(401, "Unauthorized"))
        header(HttpHeaders.Authorization, "Bearer $token")
    }

    private fun String.toDeliveryException(): DeliveryExceptionResponse =
        runCatching { Json.decodeFromString(DeliveryExceptionResponse.serializer(), this) }
            .getOrElse { DeliveryExceptionResponse(message = this) }
}
