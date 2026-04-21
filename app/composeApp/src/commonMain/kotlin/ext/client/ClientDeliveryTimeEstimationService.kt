package ext.client

import ar.com.intrale.BuildKonfig
import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.delivery.DeliveryTimeEstimationDTO
import ar.com.intrale.shared.delivery.DeliveryTimeEstimationRequestDTO
import ar.com.intrale.shared.delivery.DeliveryTimeEstimationResponseDTO
import ar.com.intrale.shared.delivery.DeliveryTimeRecordDTO
import ext.storage.CommKeyValueStorage
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.serialization.json.Json
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

/**
 * Implementacion HTTP de CommDeliveryTimeEstimationService.
 * Consume el endpoint delivery/time-estimation del backend.
 */
class ClientDeliveryTimeEstimationService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage,
    private val json: Json
) : CommDeliveryTimeEstimationService {

    private val logger = LoggerFactory.default.newLogger<ClientDeliveryTimeEstimationService>()

    override suspend fun getEstimation(orderId: String): Result<DeliveryTimeEstimationDTO> {
        return try {
            logger.info { "Obteniendo estimacion de tiempo para pedido $orderId" }
            val response = httpClient.get(
                "${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/delivery/time-estimation"
            ) {
                authorize()
                url.parameters.append("orderId", orderId)
            }
            response.toEstimation()
        } catch (throwable: Throwable) {
            logger.error(throwable) { "Error al obtener estimacion para pedido $orderId" }
            Result.failure(throwable.toClientException())
        }
    }

    override suspend fun calculateEstimation(
        deliveryLatitude: Double?,
        deliveryLongitude: Double?,
        deliveryAddress: String?
    ): Result<DeliveryTimeEstimationDTO> {
        return try {
            logger.info { "Calculando estimacion preliminar de tiempo de entrega" }
            val request = DeliveryTimeEstimationRequestDTO(
                businessId = BuildKonfig.BUSINESS,
                deliveryLatitude = deliveryLatitude,
                deliveryLongitude = deliveryLongitude,
                deliveryAddress = deliveryAddress
            )
            val response = httpClient.post(
                "${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/delivery/time-estimation"
            ) {
                authorize()
                contentType(ContentType.Application.Json)
                setBody(json.encodeToString(DeliveryTimeEstimationRequestDTO.serializer(), request))
            }
            response.toEstimation()
        } catch (throwable: Throwable) {
            logger.error(throwable) { "Error al calcular estimacion preliminar" }
            Result.failure(throwable.toClientException())
        }
    }

    override suspend fun recordActualTime(record: DeliveryTimeRecordDTO): Result<Unit> {
        return try {
            logger.info { "Registrando tiempo real de entrega para pedido ${record.orderId}" }
            val response = httpClient.put(
                "${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/delivery/time-estimation/actual"
            ) {
                authorize()
                contentType(ContentType.Application.Json)
                setBody(json.encodeToString(DeliveryTimeRecordDTO.serializer(), record))
            }
            if (response.status.isSuccess()) {
                Result.success(Unit)
            } else {
                Result.failure(response.bodyAsText().toClientExceptionParsed(json))
            }
        } catch (throwable: Throwable) {
            logger.error(throwable) { "Error al registrar tiempo real para ${record.orderId}" }
            Result.failure(throwable.toClientException())
        }
    }

    private suspend fun HttpResponse.toEstimation(): Result<DeliveryTimeEstimationDTO> {
        val bodyText = bodyAsText()
        if (!status.isSuccess()) {
            return Result.failure(bodyText.toClientExceptionParsed(json))
        }
        if (bodyText.isBlank()) {
            return Result.failure(
                ClientExceptionResponse(message = "Respuesta vacia del servidor de estimacion")
            )
        }
        val parsedResponse = runCatching {
            json.decodeFromString(DeliveryTimeEstimationResponseDTO.serializer(), bodyText)
        }.getOrNull()
        val estimation = parsedResponse?.estimation
            ?: runCatching {
                json.decodeFromString(DeliveryTimeEstimationDTO.serializer(), bodyText)
            }.getOrNull()
        return if (estimation != null) {
            Result.success(estimation)
        } else {
            Result.failure(ClientExceptionResponse(message = "No se pudo parsear la estimacion"))
        }
    }

    private fun io.ktor.client.request.HttpRequestBuilder.authorize() {
        val token = keyValueStorage.token
            ?: throw ClientExceptionResponse(
                message = "Token no disponible",
                statusCode = StatusCodeDTO(401, "Unauthorized")
            )
        header(HttpHeaders.Authorization, "Bearer $token")
    }
}

private fun String.toClientExceptionParsed(json: Json): ClientExceptionResponse =
    runCatching { json.decodeFromString(ClientExceptionResponse.serializer(), this) }
        .getOrElse { ClientExceptionResponse(message = this) }
