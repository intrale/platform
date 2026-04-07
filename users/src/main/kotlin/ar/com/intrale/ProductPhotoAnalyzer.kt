package ar.com.intrale

import com.google.gson.Gson
import com.google.gson.annotations.SerializedName
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

/**
 * Resultado del analisis de foto de producto por Claude Vision.
 */
data class ProductPhotoAnalysisResult(
    val suggestedName: String,
    val suggestedDescription: String,
    val suggestedCategory: String,
    val confidence: Double
)

/**
 * DTO interno para parsear la respuesta JSON de Claude.
 */
data class PhotoAnalysisStructured(
    val name: String = "",
    val description: String = "",
    val category: String = "",
    val confidence: Double = 0.0
)

// --- Claude Vision API DTOs ---

data class VisionImageSource(
    val type: String = "base64",
    @SerializedName("media_type")
    val mediaType: String = "image/jpeg",
    val data: String = ""
)

data class VisionContentBlock(
    val type: String,
    val source: VisionImageSource? = null,
    val text: String? = null
)

data class VisionClaudeRequest(
    val model: String = "claude-sonnet-4-20250514",
    @SerializedName("max_tokens")
    val maxTokens: Int = 1024,
    val system: String? = null,
    val messages: List<VisionClaudeMessage> = emptyList()
)

data class VisionClaudeMessage(
    val role: String,
    val content: List<VisionContentBlock>
)

/**
 * Servicio que analiza fotos de productos usando Claude Vision API.
 * Recibe una imagen en base64 y devuelve nombre, descripcion y categoria sugeridos.
 */
class ProductPhotoAnalyzer(
    private val apiKey: String = System.getenv("ANTHROPIC_API_KEY") ?: "",
    private val model: String = "claude-sonnet-4-20250514"
) {

    private val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")
    private val gson = Gson()
    private val httpClient: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()

    /**
     * Analiza una foto de producto y devuelve sugerencias.
     * @param imageBase64 imagen codificada en base64
     * @param mediaType tipo MIME de la imagen (default: image/jpeg)
     * @param existingCategories lista de categorias del negocio para matching
     */
    fun analyze(
        imageBase64: String,
        mediaType: String = "image/jpeg",
        existingCategories: List<String> = emptyList()
    ): ProductPhotoAnalysisResult {
        if (apiKey.isBlank()) {
            logger.warn("ANTHROPIC_API_KEY no configurada, no se puede analizar la foto")
            return ProductPhotoAnalysisResult(
                suggestedName = "",
                suggestedDescription = "",
                suggestedCategory = "",
                confidence = 0.0
            )
        }

        val systemPrompt = buildSystemPrompt(existingCategories)
        val request = VisionClaudeRequest(
            model = model,
            maxTokens = 512,
            system = systemPrompt,
            messages = listOf(
                VisionClaudeMessage(
                    role = "user",
                    content = listOf(
                        VisionContentBlock(
                            type = "image",
                            source = VisionImageSource(
                                type = "base64",
                                mediaType = mediaType,
                                data = imageBase64
                            )
                        ),
                        VisionContentBlock(
                            type = "text",
                            text = "Analiza esta foto de producto y genera nombre, descripcion y categoria."
                        )
                    )
                )
            )
        )

        return try {
            val httpRequest = HttpRequest.newBuilder()
                .uri(URI.create("https://api.anthropic.com/v1/messages"))
                .header("Content-Type", "application/json")
                .header("x-api-key", apiKey)
                .header("anthropic-version", "2023-06-01")
                .POST(HttpRequest.BodyPublishers.ofString(gson.toJson(request)))
                .timeout(Duration.ofSeconds(30))
                .build()

            val httpResponse = httpClient.send(httpRequest, HttpResponse.BodyHandlers.ofString())

            if (httpResponse.statusCode() != 200) {
                logger.error("Claude Vision API error: status=${httpResponse.statusCode()} body=${httpResponse.body()}")
                return ProductPhotoAnalysisResult(
                    suggestedName = "",
                    suggestedDescription = "",
                    suggestedCategory = "",
                    confidence = 0.0
                )
            }

            val apiResponse = gson.fromJson(httpResponse.body(), ClaudeApiResponse::class.java)
            val rawText = apiResponse.content.firstOrNull()?.text ?: ""
            parseAnalysisResponse(rawText)
        } catch (e: Exception) {
            logger.error("Error llamando a Claude Vision API", e)
            ProductPhotoAnalysisResult(
                suggestedName = "",
                suggestedDescription = "",
                suggestedCategory = "",
                confidence = 0.0
            )
        }
    }

    private fun buildSystemPrompt(existingCategories: List<String>): String {
        val sb = StringBuilder()
        sb.appendLine("Sos un asistente de catalogacion de productos para una plataforma de comercio.")
        sb.appendLine("Tu trabajo es analizar fotos de productos y generar informacion util para el catalogo.")
        sb.appendLine()
        sb.appendLine("A partir de la imagen que recibas, debes generar:")
        sb.appendLine("1. Un NOMBRE corto y descriptivo para el producto (max 60 caracteres)")
        sb.appendLine("2. Una DESCRIPCION breve del producto (max 200 caracteres)")
        sb.appendLine("3. Una CATEGORIA sugerida")
        sb.appendLine()

        if (existingCategories.isNotEmpty()) {
            sb.appendLine("Las categorias disponibles del negocio son:")
            existingCategories.forEach { cat ->
                sb.appendLine("  - $cat")
            }
            sb.appendLine("IMPORTANTE: sugeri una de estas categorias existentes siempre que sea posible.")
            sb.appendLine("Si ninguna aplica, sugeri una nueva categoria descriptiva.")
        } else {
            sb.appendLine("No hay categorias predefinidas. Sugeri una categoria descriptiva.")
        }

        sb.appendLine()
        sb.appendLine("=== FORMATO DE RESPUESTA (OBLIGATORIO) ===")
        sb.appendLine("Responde UNICAMENTE con un JSON valido con esta estructura:")
        sb.appendLine("""{"name": "Nombre del producto", "description": "Descripcion breve", "category": "Categoria sugerida", "confidence": 0.95}""")
        sb.appendLine("- confidence: numero entre 0.0 y 1.0 indicando tu nivel de seguridad en la identificacion")
        sb.appendLine("No incluyas texto fuera del JSON.")
        return sb.toString()
    }

    internal fun parseAnalysisResponse(rawText: String): ProductPhotoAnalysisResult {
        return try {
            val jsonText = extractJson(rawText)
            val parsed = gson.fromJson(jsonText, PhotoAnalysisStructured::class.java)
            ProductPhotoAnalysisResult(
                suggestedName = parsed.name,
                suggestedDescription = parsed.description,
                suggestedCategory = parsed.category,
                confidence = parsed.confidence
            )
        } catch (e: Exception) {
            logger.warn("No se pudo parsear respuesta de analisis de foto: ${e.message}")
            ProductPhotoAnalysisResult(
                suggestedName = "",
                suggestedDescription = "",
                suggestedCategory = "",
                confidence = 0.0
            )
        }
    }

    private fun extractJson(text: String): String {
        val jsonBlockRegex = Regex("""```(?:json)?\s*(\{.*?})\s*```""", RegexOption.DOT_MATCHES_ALL)
        jsonBlockRegex.find(text)?.let { return it.groupValues[1] }

        val jsonObjectRegex = Regex("""\{[^{}]*"name"[^{}]*}""", RegexOption.DOT_MATCHES_ALL)
        jsonObjectRegex.find(text)?.let { return it.value }

        return text.trim()
    }
}
