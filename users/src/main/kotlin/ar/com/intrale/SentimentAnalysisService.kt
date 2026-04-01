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
 * Resultado de la clasificacion de sentimiento de una review.
 */
data class SentimentResult(
    val sentiment: String,
    val themes: List<String>,
    val confidence: Double
)

/**
 * Resultado del resumen semanal generado por IA.
 */
data class WeeklySummaryResult(
    val summary: String,
    val confidence: Double
)

// --- DTOs para la respuesta de Claude ---

data class SentimentStructuredResponse(
    val sentiment: String = "NEUTRAL",
    val themes: List<String> = emptyList(),
    val confidence: Double = 0.0
)

data class SummaryStructuredResponse(
    val summary: String = "",
    val confidence: Double = 0.0
)

/**
 * Interfaz del servicio de analisis de sentimiento.
 */
interface SentimentAnalysisService {

    /**
     * Clasifica el sentimiento de una review y extrae temas recurrentes.
     */
    suspend fun classifyReview(reviewText: String): SentimentResult

    /**
     * Genera un resumen semanal en lenguaje natural a partir de reviews clasificadas.
     */
    suspend fun generateWeeklySummary(
        reviews: List<ClassifiedReview>,
        businessName: String
    ): WeeklySummaryResult
}

/**
 * Implementacion que usa la API de Anthropic (Claude) para clasificar sentimiento.
 */
class ClaudeSentimentAnalysisService(
    private val apiKey: String = System.getenv("ANTHROPIC_API_KEY") ?: "",
    private val model: String = "claude-sonnet-4-20250514"
) : SentimentAnalysisService {

    private val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")
    private val gson = Gson()
    private val httpClient: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()

    override suspend fun classifyReview(reviewText: String): SentimentResult {
        if (apiKey.isBlank()) {
            logger.warn("ANTHROPIC_API_KEY no configurada, usando clasificacion por defecto")
            return SentimentResult(sentiment = "NEUTRAL", themes = emptyList(), confidence = 0.0)
        }

        val systemPrompt = buildClassificationPrompt()
        val request = ClaudeRequest(
            model = model,
            maxTokens = 256,
            system = systemPrompt,
            messages = listOf(ClaudeMessage(role = "user", content = reviewText))
        )

        return try {
            val response = callClaudeApi(request)
            parseClassificationResponse(response)
        } catch (e: Exception) {
            logger.error("Error clasificando review con Claude API", e)
            SentimentResult(sentiment = "NEUTRAL", themes = emptyList(), confidence = 0.0)
        }
    }

    override suspend fun generateWeeklySummary(
        reviews: List<ClassifiedReview>,
        businessName: String
    ): WeeklySummaryResult {
        if (apiKey.isBlank() || reviews.isEmpty()) {
            logger.warn("Sin API key o sin reviews, no se genera resumen")
            return WeeklySummaryResult(summary = "Sin reviews para el periodo", confidence = 0.0)
        }

        val systemPrompt = buildSummaryPrompt(businessName)
        val reviewsText = reviews.joinToString("\n") { r ->
            "[${r.sentiment}] ${r.reviewText} (Temas: ${r.themes.joinToString(", ")})"
        }

        val request = ClaudeRequest(
            model = model,
            maxTokens = 512,
            system = systemPrompt,
            messages = listOf(ClaudeMessage(role = "user", content = reviewsText))
        )

        return try {
            val response = callClaudeApi(request)
            parseSummaryResponse(response)
        } catch (e: Exception) {
            logger.error("Error generando resumen semanal con Claude API", e)
            WeeklySummaryResult(summary = "Error generando resumen", confidence = 0.0)
        }
    }

    private fun callClaudeApi(request: ClaudeRequest): String {
        val httpRequest = HttpRequest.newBuilder()
            .uri(URI.create("https://api.anthropic.com/v1/messages"))
            .header("Content-Type", "application/json")
            .header("x-api-key", apiKey)
            .header("anthropic-version", "2023-06-01")
            .POST(HttpRequest.BodyPublishers.ofString(gson.toJson(request)))
            .timeout(Duration.ofSeconds(15))
            .build()

        val httpResponse = httpClient.send(httpRequest, HttpResponse.BodyHandlers.ofString())

        if (httpResponse.statusCode() != 200) {
            logger.error("Claude API error: status=${httpResponse.statusCode()} body=${httpResponse.body()}")
            throw RuntimeException("Claude API retorno status ${httpResponse.statusCode()}")
        }

        val apiResponse = gson.fromJson(httpResponse.body(), ClaudeApiResponse::class.java)
        return apiResponse.content.firstOrNull()?.text ?: ""
    }

    private fun buildClassificationPrompt(): String {
        return """
            |Sos un clasificador de sentimiento para reviews de clientes de un negocio.
            |
            |Tu trabajo es:
            |1. Clasificar el sentimiento de la review como POSITIVE, NEUTRAL o NEGATIVE
            |2. Extraer los temas principales mencionados (maximo 5 temas)
            |   Ejemplos de temas: "entrega rapida", "productos frescos", "atencion amable",
            |   "entrega lenta", "producto danado", "precio alto", "buena calidad", "mala atencion"
            |
            |FORMATO DE RESPUESTA (OBLIGATORIO):
            |Responde UNICAMENTE con un JSON valido:
            |{"sentiment": "POSITIVE", "themes": ["tema1", "tema2"], "confidence": 0.95}
            |
            |- sentiment: POSITIVE, NEUTRAL o NEGATIVE
            |- themes: lista de strings con los temas detectados (maximo 5)
            |- confidence: numero entre 0.0 y 1.0
            |No incluyas texto fuera del JSON.
        """.trimMargin()
    }

    private fun buildSummaryPrompt(businessName: String): String {
        return """
            |Sos un asistente que genera resumenes de feedback de clientes para el negocio '$businessName'.
            |
            |Te voy a enviar una lista de reviews clasificadas por sentimiento y temas.
            |Tu trabajo es generar un resumen breve y accionable en espanol.
            |
            |El resumen debe:
            |- Ser de 2-3 oraciones
            |- Destacar temas positivos y negativos mas frecuentes
            |- Ser accionable (que el dueno del negocio sepa que mejorar)
            |- Usar formato: "X clientes mencionaron Y, Z elogiaron W"
            |
            |FORMATO DE RESPUESTA (OBLIGATORIO):
            |Responde UNICAMENTE con un JSON valido:
            |{"summary": "El resumen aqui...", "confidence": 0.9}
            |No incluyas texto fuera del JSON.
        """.trimMargin()
    }

    internal fun parseClassificationResponse(rawText: String): SentimentResult {
        return try {
            val jsonText = extractJson(rawText)
            val parsed = gson.fromJson(jsonText, SentimentStructuredResponse::class.java)

            val validSentiment = when (parsed.sentiment.uppercase()) {
                "POSITIVE", "NEUTRAL", "NEGATIVE" -> parsed.sentiment.uppercase()
                else -> "NEUTRAL"
            }

            SentimentResult(
                sentiment = validSentiment,
                themes = parsed.themes.take(5),
                confidence = parsed.confidence.coerceIn(0.0, 1.0)
            )
        } catch (e: Exception) {
            logger.warn("No se pudo parsear clasificacion de sentimiento: ${e.message}")
            SentimentResult(sentiment = "NEUTRAL", themes = emptyList(), confidence = 0.0)
        }
    }

    internal fun parseSummaryResponse(rawText: String): WeeklySummaryResult {
        return try {
            val jsonText = extractJson(rawText)
            val parsed = gson.fromJson(jsonText, SummaryStructuredResponse::class.java)

            WeeklySummaryResult(
                summary = parsed.summary,
                confidence = parsed.confidence.coerceIn(0.0, 1.0)
            )
        } catch (e: Exception) {
            logger.warn("No se pudo parsear resumen semanal: ${e.message}")
            WeeklySummaryResult(summary = rawText.trim(), confidence = 0.5)
        }
    }

    private fun extractJson(text: String): String {
        val jsonBlockRegex = Regex("""```(?:json)?\s*(\{.*?})\s*```""", RegexOption.DOT_MATCHES_ALL)
        jsonBlockRegex.find(text)?.let { return it.groupValues[1] }

        val jsonObjectRegex = Regex("""\{[^{}]*"sentiment"[^{}]*}|\{[^{}]*"summary"[^{}]*}""", RegexOption.DOT_MATCHES_ALL)
        jsonObjectRegex.find(text)?.let { return it.value }

        return text.trim()
    }
}
