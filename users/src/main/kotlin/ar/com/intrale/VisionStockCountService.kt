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
 * Producto identificado por Vision en la foto del inventario.
 */
data class IdentifiedProduct(
    val name: String,
    val quantity: Int,
    val confidence: Double,
    val matchedProductId: String? = null
)

/**
 * Resultado del conteo de stock por foto.
 */
data class StockCountResult(
    val products: List<IdentifiedProduct>,
    val unrecognizedCount: Int,
    val processingTimeMs: Long,
    val notes: String? = null
)

// --- Claude Vision API DTOs ---

data class VisionImageSource(
    val type: String = "base64",
    @SerializedName("media_type")
    val mediaType: String,
    val data: String
)

data class VisionContentBlock(
    val type: String,
    val source: VisionImageSource? = null,
    val text: String? = null
)

data class VisionMessage(
    val role: String,
    val content: List<VisionContentBlock>
)

data class VisionRequest(
    val model: String = "claude-sonnet-4-20250514",
    @SerializedName("max_tokens")
    val maxTokens: Int = 2048,
    val system: String? = null,
    val messages: List<VisionMessage> = emptyList()
)

/**
 * Respuesta estructurada que esperamos del modelo Vision.
 */
data class VisionStockResponse(
    val products: List<VisionProductEntry> = emptyList(),
    @SerializedName("unrecognized_count")
    val unrecognizedCount: Int = 0,
    val notes: String? = null
)

data class VisionProductEntry(
    val name: String = "",
    val quantity: Int = 0,
    val confidence: Double = 0.0
)

/**
 * Interfaz del servicio de conteo de stock por vision.
 */
interface VisionStockCountService {
    suspend fun countStock(
        imageBase64: String,
        mediaType: String,
        knownProducts: List<ProductSummary>
    ): StockCountResult
}

/**
 * Implementacion que llama a Claude Vision API para identificar
 * y contar productos en una foto de estanteria/heladera.
 */
class ClaudeVisionStockCountService(
    private val apiKey: String = System.getenv("ANTHROPIC_API_KEY") ?: "",
    private val model: String = "claude-sonnet-4-20250514"
) : VisionStockCountService {

    private val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")
    private val gson = Gson()
    private val httpClient: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(15))
        .build()

    override suspend fun countStock(
        imageBase64: String,
        mediaType: String,
        knownProducts: List<ProductSummary>
    ): StockCountResult {
        val startTime = System.currentTimeMillis()

        if (apiKey.isBlank()) {
            logger.warn("ANTHROPIC_API_KEY no configurada, no se puede procesar imagen")
            return StockCountResult(
                products = emptyList(),
                unrecognizedCount = 0,
                processingTimeMs = System.currentTimeMillis() - startTime,
                notes = "Servicio de IA no disponible: API key no configurada"
            )
        }

        val systemPrompt = buildSystemPrompt(knownProducts)
        val request = VisionRequest(
            model = model,
            maxTokens = 2048,
            system = systemPrompt,
            messages = listOf(
                VisionMessage(
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
                            text = "Conta los productos visibles en esta foto de inventario. " +
                                "Identifica cada tipo de producto y la cantidad que ves."
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
                return StockCountResult(
                    products = emptyList(),
                    unrecognizedCount = 0,
                    processingTimeMs = System.currentTimeMillis() - startTime,
                    notes = "Error en el servicio de vision (status=${httpResponse.statusCode()})"
                )
            }

            val apiResponse = gson.fromJson(httpResponse.body(), ClaudeApiResponse::class.java)
            val rawText = apiResponse.content.firstOrNull()?.text ?: ""

            val parsed = parseVisionResponse(rawText, knownProducts)
            parsed.copy(processingTimeMs = System.currentTimeMillis() - startTime)
        } catch (e: Exception) {
            logger.error("Error llamando a Claude Vision API", e)
            StockCountResult(
                products = emptyList(),
                unrecognizedCount = 0,
                processingTimeMs = System.currentTimeMillis() - startTime,
                notes = "Error procesando la imagen: ${e.message}"
            )
        }
    }

    internal fun buildSystemPrompt(knownProducts: List<ProductSummary>): String {
        val sb = StringBuilder()
        sb.appendLine("Sos un sistema de vision por computadora especializado en conteo de inventario.")
        sb.appendLine("Tu trabajo es identificar y contar los productos visibles en la foto.")
        sb.appendLine()
        sb.appendLine("REGLAS:")
        sb.appendLine("1. Conta SOLO los productos que podes identificar con confianza")
        sb.appendLine("2. Si un producto no es claramente visible, no lo cuentes")
        sb.appendLine("3. Agrupa por tipo/marca de producto")
        sb.appendLine("4. Indica tu nivel de confianza (0.0 a 1.0) para cada conteo")
        sb.appendLine("5. Los productos parcialmente ocultos cuentan si podes identificarlos")

        if (knownProducts.isNotEmpty()) {
            sb.appendLine()
            sb.appendLine("=== PRODUCTOS CONOCIDOS DEL NEGOCIO ===")
            sb.appendLine("Usa estos nombres cuando coincidan con lo que ves:")
            knownProducts.filter { it.isAvailable }.take(100).forEach { p ->
                val desc = p.shortDescription?.let { " ($it)" } ?: ""
                sb.appendLine("  - ${p.name}$desc [${p.category ?: "sin categoria"}]")
            }
        }

        sb.appendLine()
        sb.appendLine("=== FORMATO DE RESPUESTA (OBLIGATORIO) ===")
        sb.appendLine("Responde UNICAMENTE con un JSON valido:")
        sb.appendLine("""{
  "products": [
    {"name": "Coca-Cola 500ml", "quantity": 12, "confidence": 0.95},
    {"name": "Sprite 500ml", "quantity": 8, "confidence": 0.85}
  ],
  "unrecognized_count": 3,
  "notes": "Hay 3 productos en la parte inferior que no se distinguen bien"
}""")
        sb.appendLine()
        sb.appendLine("- products: lista de productos identificados con nombre, cantidad y confianza")
        sb.appendLine("- unrecognized_count: cantidad de productos que se ven pero no se pueden identificar")
        sb.appendLine("- notes: observaciones opcionales sobre la foto")
        sb.appendLine("No incluyas texto fuera del JSON.")

        return sb.toString()
    }

    internal fun parseVisionResponse(
        rawText: String,
        knownProducts: List<ProductSummary>
    ): StockCountResult {
        return try {
            val jsonText = extractJson(rawText)
            val parsed = gson.fromJson(jsonText, VisionStockResponse::class.java)

            val identifiedProducts = parsed.products.map { entry ->
                val matched = matchKnownProduct(entry.name, knownProducts)
                IdentifiedProduct(
                    name = matched?.name ?: entry.name,
                    quantity = entry.quantity,
                    confidence = entry.confidence,
                    matchedProductId = matched?.let {
                        knownProducts.indexOf(it).takeIf { idx -> idx >= 0 }?.toString()
                    }
                )
            }

            StockCountResult(
                products = identifiedProducts,
                unrecognizedCount = parsed.unrecognizedCount,
                processingTimeMs = 0,
                notes = parsed.notes
            )
        } catch (e: Exception) {
            logger.warn("No se pudo parsear respuesta de vision: ${e.message}")
            StockCountResult(
                products = emptyList(),
                unrecognizedCount = 0,
                processingTimeMs = 0,
                notes = "No se pudo interpretar la respuesta del modelo"
            )
        }
    }

    /**
     * Intenta encontrar un producto conocido que coincida con el nombre identificado.
     * Usa comparacion fuzzy: normaliza guiones y caracteres especiales, luego busca por contains.
     */
    private fun matchKnownProduct(
        identifiedName: String,
        knownProducts: List<ProductSummary>
    ): ProductSummary? {
        val normalized = identifiedName.lowercase().trim()
        val normalizedClean = normalized.normalizeForMatch()

        // Primero buscar match exacto
        knownProducts.firstOrNull { it.name.lowercase().trim() == normalized }
            ?.let { return it }

        // Luego buscar match parcial con normalizacion de guiones/especiales
        return knownProducts.firstOrNull { product ->
            val productClean = product.name.lowercase().trim().normalizeForMatch()
            normalizedClean.contains(productClean) ||
                productClean.contains(normalizedClean)
        }
    }

    /**
     * Normaliza un string para matching: remueve guiones, caracteres especiales
     * y colapsa espacios multiples. Ej: "Coca-Cola 500ml" -> "coca cola 500ml"
     */
    private fun String.normalizeForMatch(): String =
        this.replace(Regex("[\\-_/.]"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()

    private fun extractJson(text: String): String {
        val jsonBlockRegex = Regex("""```(?:json)?\s*(\{.*?})\s*```""", RegexOption.DOT_MATCHES_ALL)
        jsonBlockRegex.find(text)?.let { return it.groupValues[1] }

        val jsonObjectRegex = Regex("""\{[^{}]*"products"[^}]*\[.*?].*?}""", RegexOption.DOT_MATCHES_ALL)
        jsonObjectRegex.find(text)?.let { return it.value }

        return text.trim()
    }
}
