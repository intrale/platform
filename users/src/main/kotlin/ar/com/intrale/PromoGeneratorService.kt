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
import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * Resultado de la generacion de promo por IA.
 */
data class GeneratedPromo(
    val promoType: String,
    val discountPercent: Int?,
    val promoText: String,
    val reason: String,
    val suggestedDurationDays: Int
)

/**
 * Respuesta estructurada esperada de Claude al generar promos.
 */
data class ClaudePromoResponse(
    @SerializedName("promo_type")
    val promoType: String = "DISCOUNT_PERCENT",
    @SerializedName("discount_percent")
    val discountPercent: Int? = null,
    @SerializedName("promo_text")
    val promoText: String = "",
    val reason: String = "",
    @SerializedName("duration_days")
    val durationDays: Int = 7
)

/**
 * Interfaz para el servicio de generacion de promos con IA.
 */
interface PromoGeneratorService {
    suspend fun generatePromo(
        businessName: String,
        product: LowRotationProduct
    ): GeneratedPromo
}

/**
 * Implementacion que usa Claude API para generar texto atractivo de promo
 * contextualizado al tipo de producto y situacion de baja rotacion.
 */
class ClaudePromoGeneratorService(
    private val apiKey: String = System.getenv("ANTHROPIC_API_KEY") ?: "",
    private val model: String = "claude-sonnet-4-20250514"
) : PromoGeneratorService {

    private val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")
    private val gson = Gson()
    private val httpClient: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()

    override suspend fun generatePromo(
        businessName: String,
        product: LowRotationProduct
    ): GeneratedPromo {
        if (apiKey.isBlank()) {
            logger.warn("ANTHROPIC_API_KEY no configurada, generando promo por defecto")
            return defaultPromo(product)
        }

        val systemPrompt = buildPromoPrompt(businessName, product)
        val request = ClaudeRequest(
            model = model,
            maxTokens = 512,
            system = systemPrompt,
            messages = listOf(
                ClaudeMessage(
                    role = "user",
                    content = "Genera una promo atractiva para este producto con baja rotacion."
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
                .timeout(Duration.ofSeconds(15))
                .build()

            val httpResponse = httpClient.send(httpRequest, HttpResponse.BodyHandlers.ofString())

            if (httpResponse.statusCode() != 200) {
                logger.error("Claude API error generando promo: status=${httpResponse.statusCode()}")
                return defaultPromo(product)
            }

            val apiResponse = gson.fromJson(httpResponse.body(), ClaudeApiResponse::class.java)
            val rawText = apiResponse.content.firstOrNull()?.text ?: ""

            parsePromoResponse(rawText, product)
        } catch (e: Exception) {
            logger.error("Error llamando a Claude API para generar promo", e)
            defaultPromo(product)
        }
    }

    private fun buildPromoPrompt(businessName: String, product: LowRotationProduct): String {
        val sb = StringBuilder()
        sb.appendLine("Sos un experto en marketing para negocios locales.")
        sb.appendLine("El negocio '$businessName' tiene un producto con baja rotacion que necesita una promo.")
        sb.appendLine()
        sb.appendLine("=== PRODUCTO ===")
        sb.appendLine("Nombre: ${product.productName}")
        sb.appendLine("Precio base: \$${product.basePrice}")
        sb.appendLine("Unidad: ${product.unit}")
        sb.appendLine("Dias sin venderse: ${product.daysSinceLastSale}")
        product.stockQuantity?.let { sb.appendLine("Stock disponible: $it unidades") }
        sb.appendLine()
        sb.appendLine("=== INSTRUCCIONES ===")
        sb.appendLine("1. Analiza el producto y propone el MEJOR tipo de promo:")
        sb.appendLine("   - DISCOUNT_PERCENT: descuento porcentual (10-50%)")
        sb.appendLine("   - TWO_FOR_ONE: lleva 2 paga 1")
        sb.appendLine("   - COMBO: combinar con otro producto")
        sb.appendLine("2. Genera un texto de promo corto y atractivo (maximo 120 caracteres)")
        sb.appendLine("3. Explica brevemente por que elegiste esa estrategia")
        sb.appendLine("4. Sugeri cuantos dias deberia durar la promo")
        sb.appendLine()
        sb.appendLine("=== FORMATO DE RESPUESTA (OBLIGATORIO) ===")
        sb.appendLine("Responde UNICAMENTE con un JSON valido:")
        sb.appendLine("""{"promo_type": "DISCOUNT_PERCENT", "discount_percent": 20, "promo_text": "Texto atractivo", "reason": "Motivo de la estrategia", "duration_days": 7}""")
        sb.appendLine("- promo_type: DISCOUNT_PERCENT, TWO_FOR_ONE o COMBO")
        sb.appendLine("- discount_percent: solo si es DISCOUNT_PERCENT (10-50)")
        sb.appendLine("- promo_text: texto marketing corto y atractivo")
        sb.appendLine("- reason: motivo breve de la eleccion")
        sb.appendLine("- duration_days: duracion sugerida en dias (3-30)")
        sb.appendLine("No incluyas texto fuera del JSON.")

        return sb.toString()
    }

    internal fun parsePromoResponse(rawText: String, product: LowRotationProduct): GeneratedPromo {
        return try {
            val jsonText = extractJson(rawText)
            val parsed = gson.fromJson(jsonText, ClaudePromoResponse::class.java)

            GeneratedPromo(
                promoType = parsed.promoType.ifBlank { "DISCOUNT_PERCENT" },
                discountPercent = parsed.discountPercent?.coerceIn(5, 50),
                promoText = parsed.promoText.ifBlank { "Aprovecha esta oferta especial!" },
                reason = parsed.reason.ifBlank { "Producto con ${product.daysSinceLastSale} dias sin ventas" },
                suggestedDurationDays = parsed.durationDays.coerceIn(3, 30)
            )
        } catch (e: Exception) {
            logger.warn("No se pudo parsear promo de Claude: ${e.message}")
            defaultPromo(product)
        }
    }

    private fun extractJson(text: String): String {
        val jsonBlockRegex = Regex("""```(?:json)?\s*(\{.*?})\s*```""", RegexOption.DOT_MATCHES_ALL)
        jsonBlockRegex.find(text)?.let { return it.groupValues[1] }

        val jsonObjectRegex = Regex("""\{[^{}]*"promo_type"[^{}]*}""", RegexOption.DOT_MATCHES_ALL)
        jsonObjectRegex.find(text)?.let { return it.value }

        return text.trim()
    }

    private fun defaultPromo(product: LowRotationProduct): GeneratedPromo {
        val discount = when {
            product.daysSinceLastSale > 30 -> 30
            product.daysSinceLastSale > 14 -> 20
            else -> 15
        }
        return GeneratedPromo(
            promoType = "DISCOUNT_PERCENT",
            discountPercent = discount,
            promoText = "${product.productName} con $discount% OFF - Oferta por tiempo limitado!",
            reason = "Producto sin ventas hace ${product.daysSinceLastSale} dias. Descuento sugerido automaticamente.",
            suggestedDurationDays = 7
        )
    }
}
