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
 * Sugerencia individual de producto devuelta por el asistente conversacional.
 */
data class ProductSuggestion(
    @SerializedName("product_id")
    val productId: String = "",
    val name: String = "",
    val reason: String = "",
    val price: Double = 0.0,
    val unit: String = "",
    val category: String? = null,
    val relevance: Double = 0.0
)

/**
 * Resultado estructurado de la busqueda conversacional.
 */
data class ConversationalSearchResult(
    val suggestions: List<ProductSuggestion> = emptyList(),
    val message: String = "",
    val hasResults: Boolean = true,
    val confidence: Double = 0.0
)

// --- DTO interno para parsear respuesta de Claude ---

data class ClaudeSearchStructuredResponse(
    val suggestions: List<ProductSuggestion> = emptyList(),
    val message: String = "",
    val confidence: Double = 0.0
)

/**
 * Interfaz para el servicio de busqueda conversacional de productos con IA.
 */
interface ConversationalSearchService {
    suspend fun search(
        query: String,
        products: List<ProductRecord>,
        businessName: String
    ): ConversationalSearchResult
}

/**
 * Implementacion que llama a la API de Anthropic (Claude) para interpretar
 * consultas en lenguaje natural y matchear contra el catalogo del negocio.
 */
class ClaudeConversationalSearchService(
    private val apiKey: String = System.getenv("ANTHROPIC_API_KEY") ?: "",
    private val model: String = "claude-sonnet-4-20250514"
) : ConversationalSearchService {

    private val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")
    private val gson = Gson()
    private val httpClient: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()

    override suspend fun search(
        query: String,
        products: List<ProductRecord>,
        businessName: String
    ): ConversationalSearchResult {
        if (apiKey.isBlank()) {
            logger.warn("ANTHROPIC_API_KEY no configurada, devolviendo resultado vacio")
            return ConversationalSearchResult(
                suggestions = emptyList(),
                message = "El servicio de busqueda inteligente no esta disponible en este momento.",
                hasResults = false,
                confidence = 0.0
            )
        }

        if (products.isEmpty()) {
            return ConversationalSearchResult(
                suggestions = emptyList(),
                message = "Este negocio aun no tiene productos publicados.",
                hasResults = false,
                confidence = 1.0
            )
        }

        val systemPrompt = buildSearchPrompt(products, businessName)
        val request = ClaudeRequest(
            model = model,
            maxTokens = 1024,
            system = systemPrompt,
            messages = listOf(ClaudeMessage(role = "user", content = query))
        )

        return try {
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
                logger.error("Claude API error en busqueda conversacional: status=${httpResponse.statusCode()} body=${httpResponse.body()}")
                return ConversationalSearchResult(
                    suggestions = emptyList(),
                    message = "No pudimos procesar tu busqueda en este momento. Intenta de nuevo.",
                    hasResults = false,
                    confidence = 0.0
                )
            }

            val apiResponse = gson.fromJson(httpResponse.body(), ClaudeApiResponse::class.java)
            val rawText = apiResponse.content.firstOrNull()?.text ?: ""

            parseSearchResponse(rawText)
        } catch (e: Exception) {
            logger.error("Error en busqueda conversacional con Claude API", e)
            ConversationalSearchResult(
                suggestions = emptyList(),
                message = "Ocurrio un error procesando tu consulta. Intenta de nuevo.",
                hasResults = false,
                confidence = 0.0
            )
        }
    }

    internal fun buildSearchPrompt(products: List<ProductRecord>, businessName: String): String {
        val sb = StringBuilder()
        sb.appendLine("Sos un asistente de compras del negocio '$businessName'.")
        sb.appendLine("Tu trabajo es interpretar lo que el cliente necesita y sugerir productos relevantes del catalogo.")
        sb.appendLine()
        sb.appendLine("REGLAS:")
        sb.appendLine("- Solo sugeri productos que esten en el catalogo de abajo")
        sb.appendLine("- Explica brevemente POR QUE cada producto es relevante para lo que pide el cliente")
        sb.appendLine("- Ordena por relevancia (el mas relevante primero)")
        sb.appendLine("- Maximo 10 sugerencias")
        sb.appendLine("- Si no hay productos que matcheen, responde amablemente sugiriendo reformular la busqueda")
        sb.appendLine("- El campo relevance debe ser un numero entre 0.0 y 1.0")
        sb.appendLine()
        sb.appendLine("=== CATALOGO DE PRODUCTOS ===")

        products.forEachIndexed { _, p ->
            val desc = p.shortDescription?.let { " - $it" } ?: ""
            val avail = if (!p.isAvailable) " [NO DISPONIBLE]" else ""
            val promo = p.promotionPrice?.let { " (promo: \$$it)" } ?: ""
            val cat = if (p.categoryId.isNotBlank()) " [${p.categoryId}]" else ""
            sb.appendLine("  ID:${p.id} | ${p.name}$desc$cat | ${p.unit} \$${p.basePrice}$promo$avail")
        }

        sb.appendLine()
        sb.appendLine("=== FORMATO DE RESPUESTA (OBLIGATORIO) ===")
        sb.appendLine("Responde UNICAMENTE con un JSON valido con esta estructura:")
        sb.appendLine("""{
  "suggestions": [
    {"product_id": "id-del-producto", "name": "Nombre", "reason": "Por que lo sugerimos", "price": 1234.0, "unit": "unidad", "category": "categoria", "relevance": 0.95}
  ],
  "message": "Mensaje amable para el cliente explicando las sugerencias",
  "confidence": 0.9
}""")
        sb.appendLine("- Si no hay match, devolver suggestions vacio y en message explicar que no encontraste productos relevantes")
        sb.appendLine("- No incluyas texto fuera del JSON")

        return sb.toString()
    }

    internal fun parseSearchResponse(rawText: String): ConversationalSearchResult {
        return try {
            val jsonText = extractJson(rawText)
            val parsed = gson.fromJson(jsonText, ClaudeSearchStructuredResponse::class.java)

            ConversationalSearchResult(
                suggestions = parsed.suggestions,
                message = parsed.message,
                hasResults = parsed.suggestions.isNotEmpty(),
                confidence = parsed.confidence
            )
        } catch (e: Exception) {
            logger.warn("No se pudo parsear respuesta de busqueda conversacional: ${e.message}")
            ConversationalSearchResult(
                suggestions = emptyList(),
                message = rawText.trim(),
                hasResults = false,
                confidence = 0.5
            )
        }
    }

    private fun extractJson(text: String): String {
        // Buscar JSON en bloque markdown
        val jsonBlockRegex = Regex("""```(?:json)?\s*(\{.*?})\s*```""", RegexOption.DOT_MATCHES_ALL)
        jsonBlockRegex.find(text)?.let { return it.groupValues[1] }

        // Buscar un objeto JSON directo con suggestions
        val jsonObjectRegex = Regex("""\{[^{}]*"suggestions".*}""", RegexOption.DOT_MATCHES_ALL)
        jsonObjectRegex.find(text)?.let { return it.value }

        return text.trim()
    }
}
