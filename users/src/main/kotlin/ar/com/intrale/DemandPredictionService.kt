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
import java.time.LocalDate
import java.time.format.DateTimeFormatter

/**
 * Datos historicos de ventas de un producto en un dia determinado.
 */
data class ProductDailySales(
    val productName: String,
    val date: String,
    val dayOfWeek: String,
    val quantity: Int,
    val revenue: Double
)

/**
 * Resultado de la prediccion de demanda generada por IA.
 */
data class DemandPredictionResult(
    val topProducts: List<ProductPrediction>,
    val summary: String,
    val dataWeeksUsed: Int
)

data class ProductPrediction(
    val productName: String,
    val expectedQuantity: Int,
    val trend: String,
    val changePercent: Double,
    val stockAlert: Boolean,
    val insight: String
)

/**
 * Respuesta estructurada esperada de Claude para prediccion de demanda.
 */
data class DemandAiStructuredResponse(
    val products: List<DemandAiProductPrediction> = emptyList(),
    val summary: String = ""
)

data class DemandAiProductPrediction(
    @SerializedName("product_name")
    val productName: String = "",
    @SerializedName("expected_quantity")
    val expectedQuantity: Int = 0,
    val trend: String = "stable",
    @SerializedName("change_percent")
    val changePercent: Double = 0.0,
    @SerializedName("stock_alert")
    val stockAlert: Boolean = false,
    val insight: String = ""
)

/**
 * Interfaz del servicio de prediccion de demanda.
 */
interface DemandPredictionService {
    suspend fun generatePrediction(
        businessName: String,
        salesHistory: List<ProductDailySales>,
        targetWeekStart: LocalDate
    ): DemandPredictionResult
}

/**
 * Implementacion que llama a Claude para generar predicciones de demanda
 * basadas en datos historicos de ventas.
 */
class ClaudeDemandPredictionService(
    private val apiKey: String = System.getenv("ANTHROPIC_API_KEY") ?: "",
    private val model: String = "claude-sonnet-4-20250514"
) : DemandPredictionService {

    private val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")
    private val gson = Gson()
    private val httpClient: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()
    private val dateFormatter = DateTimeFormatter.ISO_LOCAL_DATE

    override suspend fun generatePrediction(
        businessName: String,
        salesHistory: List<ProductDailySales>,
        targetWeekStart: LocalDate
    ): DemandPredictionResult {
        if (apiKey.isBlank()) {
            logger.warn("ANTHROPIC_API_KEY no configurada, retornando prediccion vacia")
            return DemandPredictionResult(
                topProducts = emptyList(),
                summary = "No se pudo generar prediccion: servicio de IA no configurado",
                dataWeeksUsed = 0
            )
        }

        if (salesHistory.isEmpty()) {
            logger.info("Sin datos de ventas para negocio=$businessName, retornando prediccion vacia")
            return DemandPredictionResult(
                topProducts = emptyList(),
                summary = "No hay suficientes datos de ventas para generar una prediccion",
                dataWeeksUsed = 0
            )
        }

        val dataWeeksUsed = calculateWeeksOfData(salesHistory)
        val systemPrompt = buildDemandPredictionPrompt(businessName, salesHistory, targetWeekStart)

        val request = ClaudeRequest(
            model = model,
            maxTokens = 1024,
            system = systemPrompt,
            messages = listOf(
                ClaudeMessage(
                    role = "user",
                    content = "Genera la prediccion de demanda para la semana del " +
                            "${targetWeekStart.format(dateFormatter)} al " +
                            "${targetWeekStart.plusDays(6).format(dateFormatter)}."
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
                logger.error("Claude API error en prediccion de demanda: status=${httpResponse.statusCode()}")
                return DemandPredictionResult(
                    topProducts = emptyList(),
                    summary = "Error al generar prediccion de demanda",
                    dataWeeksUsed = dataWeeksUsed
                )
            }

            val apiResponse = gson.fromJson(httpResponse.body(), ClaudeApiResponse::class.java)
            val rawText = apiResponse.content.firstOrNull()?.text ?: ""

            parseResponse(rawText, dataWeeksUsed)
        } catch (e: Exception) {
            logger.error("Error llamando a Claude API para prediccion de demanda", e)
            DemandPredictionResult(
                topProducts = emptyList(),
                summary = "Error al generar prediccion de demanda: ${e.message}",
                dataWeeksUsed = dataWeeksUsed
            )
        }
    }

    internal fun buildDemandPredictionPrompt(
        businessName: String,
        salesHistory: List<ProductDailySales>,
        targetWeekStart: LocalDate
    ): String {
        val sb = StringBuilder()
        sb.appendLine("Sos un analista de demanda para el negocio '$businessName'.")
        sb.appendLine("Tu trabajo es analizar datos historicos de ventas y predecir la demanda de la proxima semana.")
        sb.appendLine()
        sb.appendLine("=== DATOS HISTORICOS DE VENTAS ===")
        sb.appendLine("Formato: Producto | Fecha | Dia | Cantidad | Ingresos")
        sb.appendLine()

        // Agrupar por producto para mejor lectura
        val byProduct = salesHistory.groupBy { it.productName }
        byProduct.forEach { (product, sales) ->
            sb.appendLine("--- $product ---")
            sales.sortedBy { it.date }.forEach { s ->
                sb.appendLine("  ${s.date} | ${s.dayOfWeek} | qty: ${s.quantity} | \$${s.revenue}")
            }
        }

        sb.appendLine()
        sb.appendLine("=== SEMANA OBJETIVO ===")
        sb.appendLine("Del ${targetWeekStart.format(dateFormatter)} al ${targetWeekStart.plusDays(6).format(dateFormatter)}")
        sb.appendLine()
        sb.appendLine("=== INSTRUCCIONES ===")
        sb.appendLine("1. Analiza patrones: dia de la semana, tendencias, estacionalidad")
        sb.appendLine("2. Identifica los top 5 productos con mayor demanda esperada")
        sb.appendLine("3. Para cada producto indica tendencia (up/down/stable) vs semana anterior")
        sb.appendLine("4. Marca stock_alert=true si el producto podria quedarse sin stock")
        sb.appendLine("5. Genera un resumen ejecutivo en espanol con lenguaje natural")
        sb.appendLine()
        sb.appendLine("=== FORMATO DE RESPUESTA (OBLIGATORIO) ===")
        sb.appendLine("Responde UNICAMENTE con un JSON valido:")
        sb.appendLine("""{
  "products": [
    {
      "product_name": "nombre del producto",
      "expected_quantity": 100,
      "trend": "up",
      "change_percent": 40.0,
      "stock_alert": true,
      "insight": "Los viernes se vende 40% mas que el promedio"
    }
  ],
  "summary": "Resumen ejecutivo de la prediccion semanal"
}""")
        sb.appendLine()
        sb.appendLine("- trend: 'up', 'down' o 'stable'")
        sb.appendLine("- change_percent: porcentaje de cambio vs semana anterior (positivo = aumento)")
        sb.appendLine("- stock_alert: true si el negocio deberia aumentar stock de ese producto")
        sb.appendLine("- Maximo 5 productos en el array")
        sb.appendLine("- No incluyas texto fuera del JSON")

        return sb.toString()
    }

    internal fun parseResponse(rawText: String, dataWeeksUsed: Int): DemandPredictionResult {
        return try {
            val jsonText = extractJson(rawText)
            val parsed = gson.fromJson(jsonText, DemandAiStructuredResponse::class.java)

            DemandPredictionResult(
                topProducts = parsed.products.take(5).map { p ->
                    ProductPrediction(
                        productName = p.productName,
                        expectedQuantity = p.expectedQuantity,
                        trend = p.trend,
                        changePercent = p.changePercent,
                        stockAlert = p.stockAlert,
                        insight = p.insight
                    )
                },
                summary = parsed.summary,
                dataWeeksUsed = dataWeeksUsed
            )
        } catch (e: Exception) {
            logger.warn("No se pudo parsear respuesta de prediccion de demanda: ${e.message}")
            DemandPredictionResult(
                topProducts = emptyList(),
                summary = "Error al parsear la prediccion generada",
                dataWeeksUsed = dataWeeksUsed
            )
        }
    }

    private fun extractJson(text: String): String {
        val jsonBlockRegex = Regex("""```(?:json)?\s*(\{.*?})\s*```""", RegexOption.DOT_MATCHES_ALL)
        jsonBlockRegex.find(text)?.let { return it.groupValues[1] }

        val jsonObjectRegex = Regex("""\{[^{}]*"products"[^}]*\[.*?]\s*[,}]""", RegexOption.DOT_MATCHES_ALL)
        jsonObjectRegex.find(text)?.let {
            // Buscar el JSON completo desde el inicio del match
            val start = text.indexOf('{')
            val end = text.lastIndexOf('}')
            if (start >= 0 && end > start) {
                return text.substring(start, end + 1)
            }
        }

        return text.trim()
    }

    internal fun calculateWeeksOfData(salesHistory: List<ProductDailySales>): Int {
        if (salesHistory.isEmpty()) return 0
        val dates = salesHistory.mapNotNull {
            try { LocalDate.parse(it.date, dateFormatter) } catch (_: Exception) { null }
        }
        if (dates.isEmpty()) return 0
        val minDate = dates.min()
        val maxDate = dates.max()
        val days = java.time.temporal.ChronoUnit.DAYS.between(minDate, maxDate)
        return ((days / 7) + 1).toInt().coerceAtLeast(1)
    }
}
