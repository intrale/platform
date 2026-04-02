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
 * Contexto del negocio que se inyecta en el prompt del agente IA.
 */
data class BusinessContext(
    val businessName: String,
    val description: String? = null,
    val address: String? = null,
    val phone: String? = null,
    val schedules: List<DayScheduleRecord> = emptyList(),
    val deliveryZone: DeliveryZoneRecord? = null,
    val paymentMethods: List<PaymentMethodRecord> = emptyList(),
    val products: List<ProductSummary> = emptyList()
)

data class ProductSummary(
    val name: String,
    val shortDescription: String? = null,
    val basePrice: Double,
    val unit: String,
    val category: String? = null,
    val isAvailable: Boolean = true
)

/**
 * Resultado del agente IA.
 */
data class AiResponseResult(
    val answer: String,
    val confidence: Double,
    val escalated: Boolean
)

// --- Claude API DTOs ---

data class ClaudeMessage(
    val role: String,
    val content: String
)

data class ClaudeRequest(
    val model: String = "claude-sonnet-4-20250514",
    @SerializedName("max_tokens")
    val maxTokens: Int = 1024,
    val system: String? = null,
    val messages: List<ClaudeMessage> = emptyList()
)

data class ClaudeContentBlock(
    val type: String = "",
    val text: String = ""
)

data class ClaudeApiResponse(
    val id: String = "",
    val content: List<ClaudeContentBlock> = emptyList(),
    @SerializedName("stop_reason")
    val stopReason: String? = null
)

data class AiStructuredResponse(
    val answer: String = "",
    val confidence: Double = 0.0,
    val escalate: Boolean = false
)

/**
 * Interfaz para el servicio de respuestas automaticas con IA.
 */
interface AiResponseService {
    suspend fun generateResponse(
        context: BusinessContext,
        customerQuestion: String
    ): AiResponseResult
}

/**
 * Implementacion que llama a la API de Anthropic (Claude) via HTTP.
 * La API key se obtiene de la variable de entorno ANTHROPIC_API_KEY.
 */
class ClaudeAiResponseService(
    private val apiKey: String = System.getenv("ANTHROPIC_API_KEY") ?: "",
    private val model: String = "claude-sonnet-4-20250514",
    private val confidenceThreshold: Double = 0.7
) : AiResponseService {

    private val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")
    private val gson = Gson()
    private val httpClient: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()

    override suspend fun generateResponse(
        context: BusinessContext,
        customerQuestion: String
    ): AiResponseResult {
        if (apiKey.isBlank()) {
            logger.warn("ANTHROPIC_API_KEY no configurada, escalando al humano")
            return AiResponseResult(
                answer = "",
                confidence = 0.0,
                escalated = true
            )
        }

        val systemPrompt = buildSystemPrompt(context)
        val request = ClaudeRequest(
            model = model,
            maxTokens = 512,
            system = systemPrompt,
            messages = listOf(ClaudeMessage(role = "user", content = customerQuestion))
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
                logger.error("Claude API error: status=${httpResponse.statusCode()} body=${httpResponse.body()}")
                return AiResponseResult(answer = "", confidence = 0.0, escalated = true)
            }

            val apiResponse = gson.fromJson(httpResponse.body(), ClaudeApiResponse::class.java)
            val rawText = apiResponse.content.firstOrNull()?.text ?: ""

            parseStructuredResponse(rawText)
        } catch (e: Exception) {
            logger.error("Error llamando a Claude API", e)
            AiResponseResult(answer = "", confidence = 0.0, escalated = true)
        }
    }

    private fun buildSystemPrompt(context: BusinessContext): String {
        val sb = StringBuilder()
        sb.appendLine("Sos un asistente virtual del negocio '${context.businessName}'.")
        sb.appendLine("Tu trabajo es responder consultas de clientes de forma amable y precisa.")
        sb.appendLine("SOLO responde sobre informacion del negocio que se te proporciona abajo.")
        sb.appendLine("Si no estas seguro o la consulta no se relaciona con el negocio, indica que no podes responder.")
        sb.appendLine()
        sb.appendLine("=== INFORMACION DEL NEGOCIO ===")

        context.description?.let { sb.appendLine("Descripcion: $it") }
        context.address?.let { sb.appendLine("Direccion: $it") }
        context.phone?.let { sb.appendLine("Telefono: $it") }

        if (context.schedules.isNotEmpty()) {
            sb.appendLine()
            sb.appendLine("Horarios:")
            context.schedules.forEach { s ->
                val status = if (s.isOpen) "Abierto ${s.openTime} - ${s.closeTime}" else "Cerrado"
                sb.appendLine("  ${s.day}: $status")
            }
        }

        if (context.paymentMethods.isNotEmpty()) {
            sb.appendLine()
            sb.appendLine("Medios de pago aceptados:")
            context.paymentMethods.filter { it.enabled }.forEach { pm ->
                sb.appendLine("  - ${pm.name}${pm.description?.let { " ($it)" } ?: ""}")
            }
        }

        context.deliveryZone?.let { dz ->
            sb.appendLine()
            sb.appendLine("Zona de delivery:")
            when (dz.type.uppercase()) {
                "RADIUS" -> sb.appendLine("  Radio de ${dz.radiusKm} km desde el local")
                "POSTAL_CODES" -> sb.appendLine("  Codigos postales: ${dz.postalCodes.joinToString(", ")}")
            }
        }

        if (context.products.isNotEmpty()) {
            sb.appendLine()
            sb.appendLine("Productos/Servicios disponibles (hasta 50):")
            context.products.take(50).forEach { p ->
                val desc = p.shortDescription?.let { " - $it" } ?: ""
                val avail = if (!p.isAvailable) " [NO DISPONIBLE]" else ""
                sb.appendLine("  - ${p.name}$desc (${p.unit} \$${p.basePrice})$avail")
            }
        }

        sb.appendLine()
        sb.appendLine("=== FORMATO DE RESPUESTA (OBLIGATORIO) ===")
        sb.appendLine("Responde UNICAMENTE con un JSON valido con esta estructura:")
        sb.appendLine("""{"answer": "tu respuesta al cliente", "confidence": 0.95, "escalate": false}""")
        sb.appendLine("- answer: texto de la respuesta para el cliente")
        sb.appendLine("- confidence: numero entre 0.0 y 1.0 indicando tu nivel de seguridad")
        sb.appendLine("- escalate: true si no podes responder y hay que escalar al dueno del negocio")
        sb.appendLine("No incluyas texto fuera del JSON.")

        return sb.toString()
    }

    internal fun parseStructuredResponse(rawText: String): AiResponseResult {
        return try {
            // Intentar extraer JSON del texto (puede venir con markdown)
            val jsonText = extractJson(rawText)
            val parsed = gson.fromJson(jsonText, AiStructuredResponse::class.java)

            val shouldEscalate = parsed.escalate || parsed.confidence < confidenceThreshold

            AiResponseResult(
                answer = if (shouldEscalate) "" else parsed.answer,
                confidence = parsed.confidence,
                escalated = shouldEscalate
            )
        } catch (e: Exception) {
            logger.warn("No se pudo parsear respuesta estructurada de Claude: ${e.message}")
            // Si no es JSON estructurado, usar el texto directo con confidence media
            AiResponseResult(
                answer = rawText.trim(),
                confidence = 0.5,
                escalated = true
            )
        }
    }

    private fun extractJson(text: String): String {
        // Buscar JSON en el texto (puede estar envuelto en ```json ... ```)
        val jsonBlockRegex = Regex("""```(?:json)?\s*(\{.*?})\s*```""", RegexOption.DOT_MATCHES_ALL)
        jsonBlockRegex.find(text)?.let { return it.groupValues[1] }

        // Buscar un objeto JSON directo
        val jsonObjectRegex = Regex("""\{[^{}]*"answer"[^{}]*}""", RegexOption.DOT_MATCHES_ALL)
        jsonObjectRegex.find(text)?.let { return it.value }

        // Devolver el texto tal cual (dejara que Gson falle si no es JSON)
        return text.trim()
    }
}
