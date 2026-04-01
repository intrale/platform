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
import java.util.concurrent.ConcurrentHashMap

/**
 * Resultado de deteccion de idioma + traduccion.
 */
data class TranslationResult(
    val detectedLanguage: String,
    val translatedText: String?,
    val targetLanguage: String?
)

// --- Claude API DTOs para traduccion ---

data class TranslationStructuredResponse(
    @SerializedName("detected_language")
    val detectedLanguage: String = "",
    @SerializedName("needs_translation")
    val needsTranslation: Boolean = false,
    @SerializedName("translated_text")
    val translatedText: String? = null,
    @SerializedName("target_language")
    val targetLanguage: String? = null
)

/**
 * Interfaz para el servicio de traduccion.
 */
interface TranslationService {
    /**
     * Detecta el idioma del texto y, si difiere del idioma objetivo,
     * lo traduce. Si son el mismo idioma, retorna sin traduccion.
     */
    suspend fun detectAndTranslate(
        text: String,
        targetLanguage: String
    ): TranslationResult
}

/**
 * Implementacion que llama a la API de Claude para detectar idioma y traducir.
 * Incluye cache en memoria para mensajes frecuentes.
 */
class ClaudeTranslationService(
    private val apiKey: String = System.getenv("ANTHROPIC_API_KEY") ?: "",
    private val model: String = "claude-sonnet-4-20250514",
    private val cacheMaxSize: Int = 500
) : TranslationService {

    private val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")
    private val gson = Gson()
    private val httpClient: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()

    // Cache: clave = "$text|$targetLanguage" → resultado
    private val translationCache = ConcurrentHashMap<String, TranslationResult>()

    override suspend fun detectAndTranslate(
        text: String,
        targetLanguage: String
    ): TranslationResult {
        if (text.isBlank()) {
            return TranslationResult(
                detectedLanguage = "unknown",
                translatedText = null,
                targetLanguage = null
            )
        }

        // Buscar en cache
        val cacheKey = "${text.lowercase().trim()}|$targetLanguage"
        translationCache[cacheKey]?.let { cached ->
            logger.info("Cache hit para traduccion: '${text.take(30)}...'")
            return cached
        }

        if (apiKey.isBlank()) {
            logger.warn("ANTHROPIC_API_KEY no configurada, retornando sin traduccion")
            return TranslationResult(
                detectedLanguage = "unknown",
                translatedText = null,
                targetLanguage = null
            )
        }

        return try {
            val result = callClaudeForTranslation(text, targetLanguage)
            // Guardar en cache (limitar tamanio)
            if (translationCache.size < cacheMaxSize) {
                translationCache[cacheKey] = result
            }
            result
        } catch (e: Exception) {
            logger.error("Error en traduccion via Claude API", e)
            TranslationResult(
                detectedLanguage = "unknown",
                translatedText = null,
                targetLanguage = null
            )
        }
    }

    private fun callClaudeForTranslation(text: String, targetLanguage: String): TranslationResult {
        val systemPrompt = buildTranslationPrompt(targetLanguage)
        val request = ClaudeRequest(
            model = model,
            maxTokens = 512,
            system = systemPrompt,
            messages = listOf(ClaudeMessage(role = "user", content = text))
        )

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
            logger.error("Claude API error en traduccion: status=${httpResponse.statusCode()} body=${httpResponse.body()}")
            return TranslationResult(
                detectedLanguage = "unknown",
                translatedText = null,
                targetLanguage = null
            )
        }

        val apiResponse = gson.fromJson(httpResponse.body(), ClaudeApiResponse::class.java)
        val rawText = apiResponse.content.firstOrNull()?.text ?: ""

        return parseTranslationResponse(rawText)
    }

    private fun buildTranslationPrompt(targetLanguage: String): String {
        return """Sos un servicio de deteccion de idioma y traduccion.
            |
            |Analizá el mensaje del usuario y:
            |1. Detectá en qué idioma está escrito
            |2. Si el idioma detectado es diferente de "$targetLanguage", traducilo a "$targetLanguage"
            |3. Si ya está en "$targetLanguage", no traduzcas
            |
            |Idiomas soportados: español (es), portugués (pt), inglés (en), creole haitiano (ht).
            |
            |Respondé UNICAMENTE con un JSON valido con esta estructura:
            |{"detected_language": "es", "needs_translation": false, "translated_text": null, "target_language": null}
            |
            |Si necesita traduccion:
            |{"detected_language": "en", "needs_translation": true, "translated_text": "Texto traducido", "target_language": "$targetLanguage"}
            |
            |No incluyas texto fuera del JSON.""".trimMargin()
    }

    internal fun parseTranslationResponse(rawText: String): TranslationResult {
        return try {
            val jsonText = extractJson(rawText)
            val parsed = gson.fromJson(jsonText, TranslationStructuredResponse::class.java)

            TranslationResult(
                detectedLanguage = parsed.detectedLanguage.ifBlank { "unknown" },
                translatedText = if (parsed.needsTranslation) parsed.translatedText else null,
                targetLanguage = if (parsed.needsTranslation) parsed.targetLanguage else null
            )
        } catch (e: Exception) {
            logger.warn("No se pudo parsear respuesta de traduccion: ${e.message}")
            TranslationResult(
                detectedLanguage = "unknown",
                translatedText = null,
                targetLanguage = null
            )
        }
    }

    private fun extractJson(text: String): String {
        val jsonBlockRegex = Regex("""```(?:json)?\s*(\{.*?})\s*```""", RegexOption.DOT_MATCHES_ALL)
        jsonBlockRegex.find(text)?.let { return it.groupValues[1] }

        val jsonObjectRegex = Regex("""\{[^{}]*"detected_language"[^{}]*}""", RegexOption.DOT_MATCHES_ALL)
        jsonObjectRegex.find(text)?.let { return it.value }

        return text.trim()
    }
}
