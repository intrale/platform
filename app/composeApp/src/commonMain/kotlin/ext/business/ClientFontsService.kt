package ext.business

import ar.com.intrale.BuildKonfig
import ar.com.intrale.shared.ExceptionResponse
import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.business.FontsDTO
import ar.com.intrale.shared.business.FontsRequest
import ar.com.intrale.shared.business.FontsResponse
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

class ClientFontsService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage
) : CommFontsService {

    private val logger = LoggerFactory.default.newLogger<ClientFontsService>()

    override suspend fun getFonts(businessId: String): Result<FontsDTO> =
        runCatching {
            logger.info { "Obteniendo fonts para negocio $businessId" }
            val response = httpClient.get(fontsUrl(businessId)) {
                authorize()
            }
            response.toFontsDTO()
        }

    override suspend fun updateFonts(
        businessId: String,
        request: FontsRequest
    ): Result<FontsDTO> =
        runCatching {
            logger.info { "Actualizando fonts para negocio $businessId" }
            val response = httpClient.put(fontsUrl(businessId)) {
                authorize()
                setBody(request)
            }
            response.toFontsDTO()
        }

    private fun fontsUrl(businessId: String): String =
        "${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/business/$businessId/fonts"

    private suspend fun HttpResponse.toFontsDTO(): FontsDTO {
        val bodyText = bodyAsText()
        if (status.isSuccess()) {
            runCatching {
                val wrapper = Json.decodeFromString(FontsResponse.serializer(), bodyText)
                return FontsDTO(fonts = wrapper.fonts)
            }
            runCatching {
                return Json.decodeFromString(FontsDTO.serializer(), bodyText)
            }
            return FontsDTO()
        }
        throw runCatching { Json.decodeFromString(ExceptionResponse.serializer(), bodyText) }
            .getOrElse {
                logger.error(it) { "No se pudo parsear la respuesta de error" }
                ExceptionResponse(
                    statusCode = StatusCodeDTO(status.value, status.description),
                    message = bodyText
                )
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
