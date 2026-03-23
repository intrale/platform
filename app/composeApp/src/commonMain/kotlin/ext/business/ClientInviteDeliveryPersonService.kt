package ext.business

import ar.com.intrale.BuildKonfig
import ar.com.intrale.shared.ExceptionResponse
import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.business.InviteDeliveryPersonRequestDTO
import ar.com.intrale.shared.business.InviteDeliveryPersonResponseDTO
import ext.storage.CommKeyValueStorage
import io.ktor.client.HttpClient
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.isSuccess
import kotlinx.serialization.json.Json
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class ClientInviteDeliveryPersonService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage
) : CommInviteDeliveryPersonService {

    private val logger = LoggerFactory.default.newLogger<ClientInviteDeliveryPersonService>()
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    override suspend fun invite(businessId: String, email: String): Result<InviteDeliveryPersonResponseDTO> {
        return try {
            logger.info { "Invitando repartidor $email al negocio $businessId" }
            val requestBody = json.encodeToString(
                InviteDeliveryPersonRequestDTO.serializer(),
                InviteDeliveryPersonRequestDTO(email = email)
            )
            val response = httpClient.post(
                "${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/business/delivery-people/invite"
            ) {
                authorize()
                setBody(requestBody)
            }
            val bodyText = response.bodyAsText()
            if (response.status.isSuccess()) {
                val parsed = runCatching {
                    json.decodeFromString(InviteDeliveryPersonResponseDTO.serializer(), bodyText)
                }.getOrElse { InviteDeliveryPersonResponseDTO(email = email, message = "Invitacion enviada") }
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
            logger.error { "Error al invitar repartidor: ${e.message}" }
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
