package ext.business

import ar.com.intrale.BuildKonfig
import ar.com.intrale.shared.ExceptionResponse
import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.business.AnalyzeProductPhotoRequest
import ar.com.intrale.shared.business.AnalyzeProductPhotoResponse
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

/**
 * Cliente HTTP para el servicio de analisis de fotos de productos.
 */
class ClientAnalyzeProductPhotoService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage
) : CommAnalyzeProductPhotoService {

    private val logger = LoggerFactory.default.newLogger<ClientAnalyzeProductPhotoService>()

    override suspend fun analyzePhoto(
        businessId: String,
        imageBase64: String,
        mediaType: String,
        existingCategories: List<String>
    ): Result<AnalyzeProductPhotoResponse> = runCatching {
        logger.info { "Enviando foto para analisis IA en negocio $businessId" }

        val request = AnalyzeProductPhotoRequest(
            imageBase64 = imageBase64,
            mediaType = mediaType,
            existingCategories = existingCategories
        )

        val response = httpClient.post(analyzePhotoUrl(businessId)) {
            authorize()
            setBody(request)
        }

        val bodyText = response.bodyAsText()
        if (response.status.isSuccess()) {
            return@runCatching Json.decodeFromString(
                AnalyzeProductPhotoResponse.serializer(),
                bodyText
            )
        }

        throw runCatching {
            Json.decodeFromString(ExceptionResponse.serializer(), bodyText)
        }.getOrElse {
            ExceptionResponse(
                statusCode = StatusCodeDTO(response.status.value, response.status.description),
                message = bodyText
            )
        }
    }

    private fun analyzePhotoUrl(businessId: String): String =
        "${BuildKonfig.BASE_URL}$businessId/business/products/analyze-photo"

    private fun io.ktor.client.request.HttpRequestBuilder.authorize() {
        val token = keyValueStorage.token
            ?: throw ExceptionResponse(
                statusCode = StatusCodeDTO(401, "Unauthorized"),
                message = "Token no disponible"
            )
        header(HttpHeaders.Authorization, "Bearer $token")
    }
}
