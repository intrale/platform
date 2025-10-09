package ext.branding

import ar.com.intrale.BuildKonfig
import ext.dto.BrandingThemeDto
import ext.storage.CommKeyValueStorage
import io.ktor.client.HttpClient
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.isSuccess
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

interface CommBrandingService {
    suspend fun getBranding(): Result<BrandingThemeDto>

    suspend fun updateBranding(theme: BrandingThemeDto): Result<BrandingThemeDto>
}

class ClientBrandingService(
    private val httpClient: HttpClient,
    private val storage: CommKeyValueStorage,
    private val json: Json = Json { ignoreUnknownKeys = true }
) : CommBrandingService {

    private val logger = LoggerFactory.default.newLogger<ClientBrandingService>()

    override suspend fun getBranding(): Result<BrandingThemeDto> {
        return try {
            val response: HttpResponse = httpClient.post(
                "${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/branding"
            ) {
                setBody(BrandingRequest(operation = BrandingOperation.Fetch))
            }
            if (response.status.isSuccess()) {
                val theme = decodeTheme(response)
                cacheTheme(theme)
                Result.success(theme)
            } else {
                val errorBody = response.bodyAsText()
                logger.error { "Error obteniendo branding: ${response.status} $errorBody" }
                fallbackFromCache("HTTP ${response.status.value}")
            }
        } catch (error: Throwable) {
            logger.error(error) { "Error inesperado obteniendo branding" }
            fallbackFromCache(error.message ?: "Error desconocido")
        }
    }

    override suspend fun updateBranding(theme: BrandingThemeDto): Result<BrandingThemeDto> {
        return try {
            val response: HttpResponse = httpClient.post(
                "${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/branding"
            ) {
                setBody(BrandingRequest(operation = BrandingOperation.Update, theme = theme))
            }
            if (response.status.isSuccess()) {
                val savedTheme = decodeTheme(response)
                cacheTheme(savedTheme)
                Result.success(savedTheme)
            } else {
                val errorBody = response.bodyAsText()
                logger.error { "Error actualizando branding: ${response.status} $errorBody" }
                Result.failure(IllegalStateException("No se pudo guardar el branding"))
            }
        } catch (error: Throwable) {
            logger.error(error) { "Fallo al actualizar branding" }
            Result.failure(error)
        }
    }

    private fun cacheTheme(theme: BrandingThemeDto) {
        storage.brandingTheme = runCatching { json.encodeToString(theme) }
            .onFailure { failure ->
                logger.error(failure) { "No se pudo serializar el tema de branding para cache" }
            }
            .getOrNull()
    }

    private fun decodeTheme(response: HttpResponse): BrandingThemeDto {
        val bodyText = response.bodyAsText()
        return json.decodeFromString(BrandingConfigEnvelope.serializer(), bodyText).theme
    }

    private fun fallbackFromCache(reason: String): Result<BrandingThemeDto> {
        val cached = storage.brandingTheme ?: return Result.failure(IllegalStateException(reason))
        return runCatching { json.decodeFromString(BrandingThemeDto.serializer(), cached) }
            .onSuccess { logger.info { "Usando tema de branding en cache por: $reason" } }
            .onFailure { logger.error(it) { "No se pudo leer el tema cacheado" } }
            .mapFailureToResult(reason)
    }

    private fun Result<BrandingThemeDto>.mapFailureToResult(reason: String): Result<BrandingThemeDto> {
        return fold(
            onSuccess = { Result.success(it) },
            onFailure = { failure -> Result.failure(IllegalStateException(reason, failure)) }
        )
    }
}

@Serializable
private enum class BrandingOperation { Fetch, Update }

@Serializable
private data class BrandingRequest(
    val operation: BrandingOperation,
    val theme: BrandingThemeDto? = null
)

@Serializable
private data class BrandingConfigEnvelope(
    val theme: BrandingThemeDto = BrandingThemeDto()
)
