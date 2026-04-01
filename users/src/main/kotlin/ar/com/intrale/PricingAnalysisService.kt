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
 * Datos de ventas por franja horaria que se envian al modelo IA.
 */
data class SalesSlotData(
    val productName: String,
    val dayOfWeek: String,
    val timeSlot: String,
    val averageQuantity: Double,
    val averageRevenue: Double,
    val currentPrice: Double
)

/**
 * Sugerencia de pricing generada por el modelo IA.
 */
data class PricingSuggestion(
    val productName: String,
    val currentPrice: Double,
    val suggestedPrice: Double,
    val changePercent: Double,
    val reason: String,
    val dataInsight: String,
    val timeSlot: String? = null,
    val dayOfWeek: String? = null
)

/**
 * Respuesta estructurada que devuelve Claude para sugerencias de pricing.
 */
data class AiPricingSuggestionsResponse(
    val suggestions: List<AiPricingSuggestionItem> = emptyList()
)

data class AiPricingSuggestionItem(
    @SerializedName("product_name")
    val productName: String = "",
    @SerializedName("current_price")
    val currentPrice: Double = 0.0,
    @SerializedName("suggested_price")
    val suggestedPrice: Double = 0.0,
    @SerializedName("change_percent")
    val changePercent: Double = 0.0,
    val reason: String = "",
    @SerializedName("data_insight")
    val dataInsight: String = "",
    @SerializedName("time_slot")
    val timeSlot: String? = null,
    @SerializedName("day_of_week")
    val dayOfWeek: String? = null
)

/**
 * Interfaz del servicio de analisis de pricing con IA.
 */
interface PricingAnalysisService {
    /**
     * Analiza datos de ventas y genera sugerencias de ajuste de precios.
     */
    suspend fun analyzePricing(
        businessName: String,
        salesData: List<SalesSlotData>,
        products: List<ProductSummary>
    ): List<PricingSuggestion>
}

/**
 * Implementacion que usa Claude API para generar sugerencias de pricing.
 * La API key se obtiene de la variable de entorno ANTHROPIC_API_KEY.
 */
class ClaudePricingAnalysisService(
    private val apiKey: String = System.getenv("ANTHROPIC_API_KEY") ?: "",
    private val model: String = "claude-sonnet-4-20250514"
) : PricingAnalysisService {

    private val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")
    private val gson = Gson()
    private val httpClient: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()

    override suspend fun analyzePricing(
        businessName: String,
        salesData: List<SalesSlotData>,
        products: List<ProductSummary>
    ): List<PricingSuggestion> {
        if (apiKey.isBlank()) {
            logger.warn("ANTHROPIC_API_KEY no configurada, no se pueden generar sugerencias de pricing")
            return emptyList()
        }

        if (salesData.isEmpty()) {
            logger.info("Sin datos de ventas para analizar pricing de negocio=$businessName")
            return emptyList()
        }

        val systemPrompt = buildSystemPrompt(businessName, salesData, products)
        val request = ClaudeRequest(
            model = model,
            maxTokens = 1024,
            system = systemPrompt,
            messages = listOf(
                ClaudeMessage(
                    role = "user",
                    content = "Analiza los datos de ventas y genera sugerencias de ajuste de precios."
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
                logger.error("Claude API error en pricing: status=${httpResponse.statusCode()} body=${httpResponse.body()}")
                return emptyList()
            }

            val apiResponse = gson.fromJson(httpResponse.body(), ClaudeApiResponse::class.java)
            val rawText = apiResponse.content.firstOrNull()?.text ?: ""

            parseSuggestions(rawText)
        } catch (e: Exception) {
            logger.error("Error llamando a Claude API para pricing", e)
            emptyList()
        }
    }

    private fun buildSystemPrompt(
        businessName: String,
        salesData: List<SalesSlotData>,
        products: List<ProductSummary>
    ): String {
        val sb = StringBuilder()
        sb.appendLine("Sos un analista de pricing para el negocio '$businessName'.")
        sb.appendLine("Tu trabajo es analizar patrones de demanda y sugerir ajustes de precios.")
        sb.appendLine("NUNCA sugieras cambios automaticos — solo recomendaciones para que el dueno apruebe.")
        sb.appendLine()
        sb.appendLine("=== REGLAS ===")
        sb.appendLine("- Sugeri aumentos moderados (5-15%) cuando la demanda es alta y consistente")
        sb.appendLine("- Sugeri descuentos (10-25%) cuando la demanda es baja para atraer clientes")
        sb.appendLine("- Cada sugerencia DEBE incluir el dato que la respalda")
        sb.appendLine("- Maximo 5 sugerencias por analisis")
        sb.appendLine("- Precios finales deben ser numeros redondos o terminados en .50/.90/.99")
        sb.appendLine()
        sb.appendLine("=== PRODUCTOS ACTUALES ===")
        products.take(30).forEach { p ->
            sb.appendLine("  - ${p.name}: \$${p.basePrice} (${p.unit})")
        }
        sb.appendLine()
        sb.appendLine("=== DATOS DE VENTAS POR FRANJA ===")
        salesData.forEach { s ->
            sb.appendLine("  - ${s.productName} | ${s.dayOfWeek} ${s.timeSlot} | qty=${s.averageQuantity} | rev=\$${s.averageRevenue} | precio=\$${s.currentPrice}")
        }
        sb.appendLine()
        sb.appendLine("=== FORMATO DE RESPUESTA (OBLIGATORIO) ===")
        sb.appendLine("Responde UNICAMENTE con un JSON valido con esta estructura:")
        sb.appendLine("""{"suggestions": [{"product_name": "Pizza", "current_price": 1500, "suggested_price": 1650, "change_percent": 10.0, "reason": "Alta demanda domingos mediodia", "data_insight": "Vendes 2x los domingos 12-14hs vs promedio semanal", "time_slot": "12:00-14:00", "day_of_week": "domingo"}]}""")
        sb.appendLine("No incluyas texto fuera del JSON.")

        return sb.toString()
    }

    internal fun parseSuggestions(rawText: String): List<PricingSuggestion> {
        return try {
            val jsonText = extractJson(rawText)
            val parsed = gson.fromJson(jsonText, AiPricingSuggestionsResponse::class.java)

            parsed.suggestions.map { item ->
                PricingSuggestion(
                    productName = item.productName,
                    currentPrice = item.currentPrice,
                    suggestedPrice = item.suggestedPrice,
                    changePercent = item.changePercent,
                    reason = item.reason,
                    dataInsight = item.dataInsight,
                    timeSlot = item.timeSlot,
                    dayOfWeek = item.dayOfWeek
                )
            }
        } catch (e: Exception) {
            logger.warn("No se pudo parsear sugerencias de pricing de Claude: ${e.message}")
            emptyList()
        }
    }

    private fun extractJson(text: String): String {
        val jsonBlockRegex = Regex("""```(?:json)?\s*(\{.*?})\s*```""", RegexOption.DOT_MATCHES_ALL)
        jsonBlockRegex.find(text)?.let { return it.groupValues[1] }

        val jsonObjectRegex = Regex("""\{[^{}]*"suggestions"[^}]*\[.*]}""", RegexOption.DOT_MATCHES_ALL)
        jsonObjectRegex.find(text)?.let { return it.value }

        return text.trim()
    }
}
