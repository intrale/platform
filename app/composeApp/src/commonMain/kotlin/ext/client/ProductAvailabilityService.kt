package ext.client

import ar.com.intrale.BuildKonfig
import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.client.ProductAvailabilityRequestDTO
import ar.com.intrale.shared.client.ProductAvailabilityResponseDTO
import ext.storage.CommKeyValueStorage
import io.ktor.client.HttpClient
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.serialization.json.Json
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

/**
 * Implementación del servicio de consulta de disponibilidad de productos.
 * Llama a POST /{business}/client/products/availability
 */
class ProductAvailabilityService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage
) : CommProductAvailabilityService {

    private val logger = LoggerFactory.default.newLogger<ProductAvailabilityService>()

    override suspend fun checkAvailability(productIds: List<String>): Result<ProductAvailabilityResponseDTO> {
        return try {
            logger.info { "Consultando disponibilidad de ${productIds.size} productos" }
            val request = ProductAvailabilityRequestDTO(productIds = productIds)
            val response = httpClient.post(
                "${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/client/products/availability"
            ) {
                authorize()
                contentType(ContentType.Application.Json)
                setBody(Json.encodeToString(ProductAvailabilityRequestDTO.serializer(), request))
            }
            val bodyText = response.bodyAsText()
            if (response.status.isSuccess()) {
                val parsed = Json.decodeFromString(ProductAvailabilityResponseDTO.serializer(), bodyText)
                Result.success(parsed)
            } else {
                Result.failure(bodyText.toClientException())
            }
        } catch (throwable: Throwable) {
            logger.error(throwable) { "Error al consultar disponibilidad de productos" }
            Result.failure(throwable.toClientException())
        }
    }

    private fun String.toClientException(): ClientExceptionResponse =
        runCatching { Json.decodeFromString(ClientExceptionResponse.serializer(), this) }
            .getOrElse { ClientExceptionResponse(message = this) }

    private fun io.ktor.client.request.HttpRequestBuilder.authorize() {
        val token = keyValueStorage.token
            ?: throw ClientExceptionResponse(
                message = "Token no disponible",
                statusCode = StatusCodeDTO(401, "Unauthorized")
            )
        header(HttpHeaders.Authorization, "Bearer $token")
    }
}
