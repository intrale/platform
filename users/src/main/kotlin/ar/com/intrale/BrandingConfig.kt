package ar.com.intrale

import com.google.gson.Gson
import org.slf4j.Logger

class BrandingConfig(
    private val repository: BrandingConfigRepository,
    private val logger: Logger,
    private val gson: Gson = Gson()
) : Function {

    override suspend fun execute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("BrandingConfig ejecutando operacion $function para $business")
        val request = parseRequest(textBody)
            ?: return RequestValidationException("Formato de solicitud inválido")

        return when (request.operation) {
            BrandingConfigOperation.Fetch -> {
                val theme = repository.get(business) ?: BrandingThemePayload()
                BrandingConfigResponse(theme)
            }
            BrandingConfigOperation.Update -> {
                val theme = request.theme
                    ?: return RequestValidationException("El cuerpo de branding es requerido")
                val payload = theme.copy(updatedAtIso = System.currentTimeMillis().toString())
                repository.save(business, payload)
                BrandingConfigResponse(payload)
            }
        }
    }

    private fun parseRequest(body: String): BrandingConfigRequest? {
        if (body.isBlank()) {
            logger.info("BrandingConfig recibió cuerpo vacío, se usará operación Fetch")
            return BrandingConfigRequest()
        }
        return runCatching { gson.fromJson(body, BrandingConfigRequest::class.java) }
            .onFailure { logger.error("No se pudo parsear la solicitud de branding", it) }
            .getOrNull()
    }
}

data class BrandingConfigResponse(val theme: BrandingThemePayload) : Response()

data class BrandingConfigRequest(
    val operation: BrandingConfigOperation = BrandingConfigOperation.Fetch,
    val theme: BrandingThemePayload? = null
)

enum class BrandingConfigOperation {
    Fetch,
    Update
}

data class BrandingThemePayload(
    val typography: String = "Inter",
    val palette: BrandingPalettePayload = BrandingPalettePayload(),
    val assets: BrandingAssetsPayload = BrandingAssetsPayload(),
    val updatedAtIso: String? = null
)

data class BrandingPalettePayload(
    val primary: String = "#0053F4",
    val secondary: String = "#09101D",
    val background: String = "#FFFFFF"
)

data class BrandingAssetsPayload(
    val logoUrl: String? = null,
    val splashImageUrl: String? = null
)
