package ar.com.intrale

import com.google.gson.Gson
import com.google.gson.annotations.SerializedName
import com.google.gson.reflect.TypeToken
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

/**
 * Resultado de una traduccion individual.
 */
data class TranslationResult(
    val originalText: String,
    val translatedText: String,
    val sourceLocale: String,
    val targetLocale: String
)

/**
 * Respuesta esperada del modelo Claude para traducciones batch.
 */
data class TranslationBatchResponse(
    val translations: List<TranslatedItem> = emptyList()
)

data class TranslatedItem(
    val index: Int = 0,
    val text: String = ""
)

/**
 * Interfaz para el servicio de traduccion de textos.
 */
interface TranslationService {
    /**
     * Traduce una lista de textos al idioma destino.
     * Devuelve la lista de traducciones en el mismo orden que los textos de entrada.
     */
    suspend fun translateBatch(
        texts: List<String>,
        targetLocale: String,
        sourceLocale: String = "es"
    ): Result<List<String>>
}

/**
 * Implementacion que usa la API de Claude para traducir textos.
 * Agrupa textos en un solo request para eficiencia.
 */
class ClaudeTranslationService(
    private val apiKey: String = System.getenv("ANTHROPIC_API_KEY") ?: "",
    private val model: String = "claude-sonnet-4-20250514"
) : TranslationService {

    private val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")
    private val gson = Gson()
    private val httpClient: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()

    companion object {
        /** Locales soportados para traduccion */
        val SUPPORTED_LOCALES = setOf("es", "en", "pt")

        /** Nombres legibles de los locales */
        val LOCALE_NAMES = mapOf(
            "es" to "espanol",
            "en" to "ingles",
            "pt" to "portugues"
        )
    }

    override suspend fun translateBatch(
        texts: List<String>,
        targetLocale: String,
        sourceLocale: String
    ): Result<List<String>> {
        if (apiKey.isBlank()) {
            logger.warn("ANTHROPIC_API_KEY no configurada, no se puede traducir")
            return Result.failure(IllegalStateException("Servicio de traduccion no disponible"))
        }

        if (targetLocale == sourceLocale) {
            return Result.success(texts)
        }

        if (texts.isEmpty()) {
            return Result.success(emptyList())
        }

        val targetName = LOCALE_NAMES[targetLocale] ?: targetLocale
        val sourceName = LOCALE_NAMES[sourceLocale] ?: sourceLocale

        val systemPrompt = buildTranslationPrompt(sourceName, targetName)
        val userContent = buildUserContent(texts)

        val request = ClaudeRequest(
            model = model,
            maxTokens = 2048,
            system = systemPrompt,
            messages = listOf(ClaudeMessage(role = "user", content = userContent))
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
                logger.error("Claude API error en traduccion: status=${httpResponse.statusCode()} body=${httpResponse.body()}")
                return Result.failure(RuntimeException("Error en servicio de traduccion: HTTP ${httpResponse.statusCode()}"))
            }

            val apiResponse = gson.fromJson(httpResponse.body(), ClaudeApiResponse::class.java)
            val rawText = apiResponse.content.firstOrNull()?.text ?: ""

            parseTranslationResponse(rawText, texts.size)
        } catch (e: Exception) {
            logger.error("Error llamando a Claude API para traduccion", e)
            Result.failure(e)
        }
    }

    private fun buildTranslationPrompt(sourceLang: String, targetLang: String): String {
        return """Sos un traductor profesional. Traduce los siguientes textos de $sourceLang a $targetLang.

REGLAS:
- Mantene el tono y estilo original
- NO traduzcas nombres propios, marcas, o terminos tecnicos que no tengan equivalente
- NO traduzcas precios, unidades de medida, ni numeros
- Cada texto viene numerado (0, 1, 2...). Devolvelos en el mismo orden.
- Si un texto esta vacio o es solo espacios, devolvelo vacio

FORMATO DE RESPUESTA (obligatorio):
Responde UNICAMENTE con un JSON valido:
{"translations": [{"index": 0, "text": "traduccion del texto 0"}, {"index": 1, "text": "traduccion del texto 1"}]}
No incluyas texto fuera del JSON."""
    }

    private fun buildUserContent(texts: List<String>): String {
        return texts.mapIndexed { index, text ->
            "[$index] $text"
        }.joinToString("\n")
    }

    internal fun parseTranslationResponse(rawText: String, expectedCount: Int): Result<List<String>> {
        return try {
            val jsonText = extractTranslationJson(rawText)
            val parsed = gson.fromJson(jsonText, TranslationBatchResponse::class.java)

            if (parsed.translations.isEmpty()) {
                return Result.failure(RuntimeException("Respuesta de traduccion vacia"))
            }

            // Ordenar por indice y extraer textos
            val sortedTranslations = parsed.translations.sortedBy { it.index }
            val results = MutableList(expectedCount) { "" }
            for (item in sortedTranslations) {
                if (item.index in 0 until expectedCount) {
                    results[item.index] = item.text
                }
            }

            Result.success(results)
        } catch (e: Exception) {
            logger.warn("No se pudo parsear respuesta de traduccion: ${e.message}")
            Result.failure(RuntimeException("Error parseando respuesta de traduccion", e))
        }
    }

    private fun extractTranslationJson(text: String): String {
        // Buscar JSON en bloques de codigo markdown
        val jsonBlockRegex = Regex("""```(?:json)?\s*(\{.*?})\s*```""", RegexOption.DOT_MATCHES_ALL)
        jsonBlockRegex.find(text)?.let { return it.groupValues[1] }

        // Buscar JSON directo con "translations"
        val jsonObjectRegex = Regex("""\{[^{}]*"translations"\s*:\s*\[.*?]\s*}""", RegexOption.DOT_MATCHES_ALL)
        jsonObjectRegex.find(text)?.let { return it.value }

        return text.trim()
    }
}
