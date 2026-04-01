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
 * Resultado de la evaluacion de calidad de una foto de producto.
 */
data class PhotoQualityResult(
    val overallScore: Double,
    val quality: PhotoQualityLevel,
    val issues: List<String>,
    val recommendations: List<String>
)

/**
 * Niveles de calidad de foto.
 */
enum class PhotoQualityLevel {
    GOOD, IMPROVABLE, BAD
}

// --- Claude Vision API DTOs ---

data class ClaudeVisionImageSource(
    val type: String = "base64",
    @SerializedName("media_type")
    val mediaType: String,
    val data: String
)

data class ClaudeVisionContentBlock(
    val type: String,
    val source: ClaudeVisionImageSource? = null,
    val text: String? = null
)

data class ClaudeVisionRequest(
    val model: String = "claude-sonnet-4-20250514",
    @SerializedName("max_tokens")
    val maxTokens: Int = 1024,
    val system: String? = null,
    val messages: List<ClaudeVisionMessage> = emptyList()
)

data class ClaudeVisionMessage(
    val role: String,
    val content: List<ClaudeVisionContentBlock>
)

data class PhotoQualityStructuredResponse(
    @SerializedName("overall_score")
    val overallScore: Double = 0.0,
    val quality: String = "BAD",
    val issues: List<String> = emptyList(),
    val recommendations: List<String> = emptyList()
)

/**
 * Interfaz para el servicio de evaluacion de calidad de fotos.
 */
interface PhotoQualityService {
    suspend fun evaluatePhoto(
        imageBase64: String,
        mediaType: String,
        productName: String?
    ): PhotoQualityResult
}

/**
 * Implementacion que usa Claude Vision API para evaluar calidad de fotos de productos.
 * La API key se obtiene de la variable de entorno ANTHROPIC_API_KEY.
 */
class ClaudePhotoQualityService(
    private val apiKey: String = System.getenv("ANTHROPIC_API_KEY") ?: "",
    private val model: String = "claude-sonnet-4-20250514"
) : PhotoQualityService {

    private val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")
    private val gson = Gson()
    private val httpClient: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(15))
        .build()

    override suspend fun evaluatePhoto(
        imageBase64: String,
        mediaType: String,
        productName: String?
    ): PhotoQualityResult {
        if (apiKey.isBlank()) {
            logger.warn("ANTHROPIC_API_KEY no configurada, retornando evaluacion por defecto")
            return PhotoQualityResult(
                overallScore = 0.0,
                quality = PhotoQualityLevel.BAD,
                issues = listOf("No se pudo evaluar: servicio de IA no configurado"),
                recommendations = listOf("Contactar al administrador de la plataforma")
            )
        }

        val systemPrompt = buildSystemPrompt(productName)
        val request = ClaudeVisionRequest(
            model = model,
            maxTokens = 1024,
            system = systemPrompt,
            messages = listOf(
                ClaudeVisionMessage(
                    role = "user",
                    content = listOf(
                        ClaudeVisionContentBlock(
                            type = "image",
                            source = ClaudeVisionImageSource(
                                type = "base64",
                                mediaType = mediaType,
                                data = imageBase64
                            )
                        ),
                        ClaudeVisionContentBlock(
                            type = "text",
                            text = "Evalua la calidad de esta foto de producto para un catalogo de e-commerce."
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
                return fallbackResult("Error al comunicarse con el servicio de evaluacion")
            }

            val apiResponse = gson.fromJson(httpResponse.body(), ClaudeApiResponse::class.java)
            val rawText = apiResponse.content.firstOrNull()?.text ?: ""

            parsePhotoQualityResponse(rawText)
        } catch (e: Exception) {
            logger.error("Error llamando a Claude Vision API para evaluacion de foto", e)
            fallbackResult("Error inesperado durante la evaluacion")
        }
    }

    private fun buildSystemPrompt(productName: String?): String {
        val sb = StringBuilder()
        sb.appendLine("Sos un experto en fotografia de productos para e-commerce.")
        sb.appendLine("Tu trabajo es evaluar la calidad de fotos de productos para catalogos online.")
        productName?.let {
            sb.appendLine("El producto en la foto es: $it")
        }
        sb.appendLine()
        sb.appendLine("Evalua los siguientes criterios:")
        sb.appendLine("1. NITIDEZ: la foto esta enfocada, sin borrones")
        sb.appendLine("2. ILUMINACION: buena luz, sin sombras fuertes ni sobreexposicion")
        sb.appendLine("3. ENCUADRE: el producto esta centrado, buen angulo, fondo limpio")
        sb.appendLine("4. ATRACTIVO VISUAL: la foto es apetitosa/atractiva para vender")
        sb.appendLine()
        sb.appendLine("=== FORMATO DE RESPUESTA (OBLIGATORIO) ===")
        sb.appendLine("Responde UNICAMENTE con un JSON valido:")
        sb.appendLine("""{""")
        sb.appendLine("""  "overall_score": 0.75,""")
        sb.appendLine("""  "quality": "GOOD",""")
        sb.appendLine("""  "issues": ["lista de problemas detectados"],""")
        sb.appendLine("""  "recommendations": ["lista de sugerencias concretas para mejorar"]""")
        sb.appendLine("""}""")
        sb.appendLine()
        sb.appendLine("- overall_score: numero entre 0.0 y 1.0")
        sb.appendLine("- quality: GOOD (score >= 0.7), IMPROVABLE (0.4 <= score < 0.7), BAD (score < 0.4)")
        sb.appendLine("- issues: lista de problemas concretos (ej: 'La foto esta oscura', 'El producto esta desenfocado')")
        sb.appendLine("- recommendations: sugerencias practicas (ej: 'Proba con mas luz natural', 'Usa un fondo blanco')")
        sb.appendLine("- Si la foto es buena, issues y recommendations pueden estar vacios")
        sb.appendLine("- Las sugerencias deben ser accionables y en espanol rioplatense")
        sb.appendLine("No incluyas texto fuera del JSON.")

        return sb.toString()
    }

    internal fun parsePhotoQualityResponse(rawText: String): PhotoQualityResult {
        return try {
            val jsonText = extractJson(rawText)
            val parsed = gson.fromJson(jsonText, PhotoQualityStructuredResponse::class.java)

            val quality = when {
                parsed.overallScore >= 0.7 -> PhotoQualityLevel.GOOD
                parsed.overallScore >= 0.4 -> PhotoQualityLevel.IMPROVABLE
                else -> PhotoQualityLevel.BAD
            }

            PhotoQualityResult(
                overallScore = parsed.overallScore.coerceIn(0.0, 1.0),
                quality = quality,
                issues = parsed.issues,
                recommendations = parsed.recommendations
            )
        } catch (e: Exception) {
            logger.warn("No se pudo parsear respuesta de evaluacion de foto: ${e.message}")
            fallbackResult("No se pudo interpretar la evaluacion")
        }
    }

    private fun extractJson(text: String): String {
        val jsonBlockRegex = Regex("""```(?:json)?\s*(\{.*?})\s*```""", RegexOption.DOT_MATCHES_ALL)
        jsonBlockRegex.find(text)?.let { return it.groupValues[1] }

        val jsonObjectRegex = Regex("""\{[^{}]*"overall_score"[^{}]*}""", RegexOption.DOT_MATCHES_ALL)
        jsonObjectRegex.find(text)?.let { return it.value }

        return text.trim()
    }

    private fun fallbackResult(errorMessage: String): PhotoQualityResult {
        return PhotoQualityResult(
            overallScore = 0.0,
            quality = PhotoQualityLevel.BAD,
            issues = listOf(errorMessage),
            recommendations = emptyList()
        )
    }
}
