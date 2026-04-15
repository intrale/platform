package ext.business

import ar.com.intrale.BuildKonfig
import ar.com.intrale.shared.ExceptionResponse
import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.business.BannerDTO
import ar.com.intrale.shared.business.BannerListResponse
import ar.com.intrale.shared.business.BannerRequest
import ext.storage.CommKeyValueStorage
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.isSuccess
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class ClientBannerService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage,
    private val json: Json
) : CommBannerService {

    private val logger = LoggerFactory.default.newLogger<ClientBannerService>()

    override suspend fun listBanners(businessId: String): Result<List<BannerDTO>> =
        runCatching {
            logger.info { "Listando banners para negocio $businessId" }
            val response = httpClient.get(bannersUrl(businessId)) {
                authorize()
            }
            response.toBanners()
        }

    override suspend fun createBanner(
        businessId: String,
        request: BannerRequest
    ): Result<BannerDTO> =
        runCatching {
            logger.info { "Creando banner '${request.title}'" }
            val response = httpClient.post(bannersUrl(businessId)) {
                authorize()
                setBody(request)
            }
            response.toBanner()
        }

    override suspend fun updateBanner(
        businessId: String,
        bannerId: String,
        request: BannerRequest
    ): Result<BannerDTO> =
        runCatching {
            logger.info { "Actualizando banner $bannerId" }
            val response = httpClient.put(bannerUrl(businessId, bannerId)) {
                authorize()
                setBody(request)
            }
            response.toBanner()
        }

    override suspend fun toggleBanner(
        businessId: String,
        bannerId: String,
        active: Boolean
    ): Result<BannerDTO> =
        runCatching {
            logger.info { "Cambiando estado de banner $bannerId a active=$active" }
            val request = BannerRequest(active = active)
            val response = httpClient.patch(bannerUrl(businessId, bannerId)) {
                authorize()
                setBody(request)
            }
            response.toBanner()
        }

    private fun bannersUrl(businessId: String): String =
        "${BuildKonfig.BASE_URL}$businessId/business/banners"

    private fun bannerUrl(businessId: String, bannerId: String): String =
        "${BuildKonfig.BASE_URL}$businessId/business/banners/$bannerId"

    private suspend fun HttpResponse.toBanner(): BannerDTO {
        val bodyText = bodyAsText()
        if (status.isSuccess()) {
            runCatching { return json.decodeFromString(BannerDTO.serializer(), bodyText) }
            runCatching {
                val responseWrapper =
                    json.decodeFromString(BannerListResponse.serializer(), bodyText)
                responseWrapper.banners.firstOrNull()?.let { return it }
            }
            throw ExceptionResponse(
                statusCode = StatusCodeDTO(status.value, status.description),
                message = "Respuesta vacia del servidor"
            )
        }
        throw bodyText.toBannerException()
    }

    private suspend fun HttpResponse.toBanners(): List<BannerDTO> {
        val bodyText = bodyAsText()
        if (status.isSuccess()) {
            runCatching {
                return json.decodeFromString(BannerListResponse.serializer(), bodyText)
                    .banners
            }
            runCatching {
                return json.decodeFromString(
                    ListSerializer(BannerDTO.serializer()),
                    bodyText
                )
            }
            return emptyList()
        }
        throw bodyText.toBannerException()
    }

    private fun String.toBannerException(): ExceptionResponse =
        runCatching { json.decodeFromString(ExceptionResponse.serializer(), this) }
            .getOrElse {
                logger.error(it) { "No se pudo parsear la respuesta de error" }
                ExceptionResponse(
                    statusCode = StatusCodeDTO(500, "Internal Server Error"),
                    message = this
                )
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
