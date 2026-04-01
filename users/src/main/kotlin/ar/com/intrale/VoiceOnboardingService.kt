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
 * Interfaz del servicio de onboarding por voz.
 * Interpreta texto transcrito y devuelve entidades estructuradas.
 */
interface VoiceOnboardingService {
    /**
     * Procesa un paso del onboarding con el texto transcrito.
     * @param transcript texto transcrito del audio del usuario
     * @param step paso actual del onboarding
     * @param accumulatedContext contexto acumulado de pasos anteriores
     * @return resultado con entidades extraidas y mensaje conversacional
     */
    suspend fun processStep(
        transcript: String,
        step: OnboardingStep,
        accumulatedContext: AccumulatedOnboardingContext?
    ): OnboardingStepResult
}

/**
 * DTO interno para parsear la respuesta JSON de Claude.
 */
internal data class ClaudeOnboardingResponse(
    val message: String = "",
    @SerializedName("next_step")
    val nextStep: String? = null,
    @SerializedName("business_name")
    val businessName: String? = null,
    @SerializedName("business_description")
    val businessDescription: String? = null,
    @SerializedName("business_category")
    val businessCategory: String? = null,
    val address: String? = null,
    val phone: String? = null,
    val categories: List<ExtractedCategory>? = null,
    val products: List<ExtractedProduct>? = null,
    val schedules: List<ExtractedSchedule>? = null,
    val confidence: Double = 0.0,
    @SerializedName("needs_clarification")
    val needsClarification: Boolean = false
)

/**
 * Implementacion que usa la API de Claude para interpretar el texto transcrito
 * del usuario durante el onboarding guiado por voz.
 */
class ClaudeVoiceOnboardingService(
    private val apiKey: String = System.getenv("ANTHROPIC_API_KEY") ?: "",
    private val model: String = "claude-sonnet-4-20250514"
) : VoiceOnboardingService {

    private val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")
    private val gson = Gson()
    private val httpClient: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()

    override suspend fun processStep(
        transcript: String,
        step: OnboardingStep,
        accumulatedContext: AccumulatedOnboardingContext?
    ): OnboardingStepResult {
        if (apiKey.isBlank()) {
            logger.warn("ANTHROPIC_API_KEY no configurada para onboarding por voz")
            return OnboardingStepResult(
                message = "El servicio de asistente por voz no esta disponible en este momento.",
                confidence = 0.0,
                needsClarification = true
            )
        }

        val systemPrompt = buildSystemPrompt(step, accumulatedContext)
        val request = ClaudeRequest(
            model = model,
            maxTokens = 1024,
            system = systemPrompt,
            messages = listOf(ClaudeMessage(role = "user", content = transcript))
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
                logger.error("Claude API error en onboarding: status=${httpResponse.statusCode()}")
                return OnboardingStepResult(
                    message = "Hubo un problema procesando tu respuesta. Podrias repetirlo?",
                    nextStep = step,
                    accumulatedContext = accumulatedContext ?: AccumulatedOnboardingContext(),
                    confidence = 0.0,
                    needsClarification = true
                )
            }

            val apiResponse = gson.fromJson(httpResponse.body(), ClaudeApiResponse::class.java)
            val rawText = apiResponse.content.firstOrNull()?.text ?: ""

            parseOnboardingResponse(rawText, step, accumulatedContext)
        } catch (e: Exception) {
            logger.error("Error en onboarding por voz", e)
            OnboardingStepResult(
                message = "Hubo un error procesando tu respuesta. Intentalo de nuevo.",
                nextStep = step,
                accumulatedContext = accumulatedContext ?: AccumulatedOnboardingContext(),
                confidence = 0.0,
                needsClarification = true
            )
        }
    }

    internal fun buildSystemPrompt(
        step: OnboardingStep,
        accumulatedContext: AccumulatedOnboardingContext?
    ): String {
        val sb = StringBuilder()
        sb.appendLine("Sos un asistente de Intrale que ayuda a duenos de negocios a dar de alta su comercio por voz.")
        sb.appendLine("Hablas en espanol argentino, de manera amigable y simple.")
        sb.appendLine("El dueno te habla y vos interpretas lo que dice para crear las entidades del negocio.")
        sb.appendLine()

        // Contexto acumulado
        if (accumulatedContext != null) {
            sb.appendLine("=== CONTEXTO ACUMULADO ===")
            accumulatedContext.businessName?.let { sb.appendLine("Nombre del negocio: $it") }
            accumulatedContext.businessDescription?.let { sb.appendLine("Descripcion: $it") }
            accumulatedContext.businessCategory?.let { sb.appendLine("Rubro: $it") }
            accumulatedContext.address?.let { sb.appendLine("Direccion: $it") }
            accumulatedContext.phone?.let { sb.appendLine("Telefono: $it") }
            if (accumulatedContext.categories.isNotEmpty()) {
                sb.appendLine("Categorias ya registradas: ${accumulatedContext.categories.joinToString { it.name }}")
            }
            if (accumulatedContext.products.isNotEmpty()) {
                sb.appendLine("Productos ya registrados: ${accumulatedContext.products.joinToString { "${it.name} ($${it.basePrice})" }}")
            }
            if (accumulatedContext.schedules.isNotEmpty()) {
                sb.appendLine("Horarios ya registrados: ${accumulatedContext.schedules.joinToString { "${it.day}: ${it.openTime}-${it.closeTime}" }}")
            }
            sb.appendLine()
        }

        // Instrucciones segun paso
        sb.appendLine("=== PASO ACTUAL: ${step.name} ===")
        when (step) {
            OnboardingStep.BUSINESS_TYPE -> {
                sb.appendLine("El dueno esta describiendo su negocio.")
                sb.appendLine("Extrae: nombre del negocio, descripcion, rubro/categoria, direccion, telefono.")
                sb.appendLine("Si no menciona alguno, deja null. No inventes datos.")
                sb.appendLine("En tu mensaje, resumi lo que entendiste y pregunta si esta bien.")
            }
            OnboardingStep.PRODUCTS -> {
                sb.appendLine("El dueno esta contando sus productos o servicios principales.")
                sb.appendLine("Extrae categorias y productos con nombre, descripcion corta, precio y unidad.")
                sb.appendLine("Si dice 'pizza grande $500' extrae: nombre='Pizza grande', precio=500, unidad='unidad'.")
                sb.appendLine("Si menciona categorias ('las pizzas', 'las bebidas'), crealas.")
                sb.appendLine("Si no dice precio, usa 0 y marca needsClarification.")
            }
            OnboardingStep.SCHEDULES -> {
                sb.appendLine("El dueno esta indicando sus horarios de atencion.")
                sb.appendLine("Extrae horarios por dia de la semana (lunes a domingo).")
                sb.appendLine("Dias validos: Lunes, Martes, Miercoles, Jueves, Viernes, Sabado, Domingo")
                sb.appendLine("Si dice 'de lunes a viernes de 9 a 18' genera los 5 dias.")
                sb.appendLine("Los dias no mencionados se consideran cerrados.")
            }
            OnboardingStep.CONFIRM -> {
                sb.appendLine("El dueno esta confirmando los datos. Resumi todo y pedile que confirme.")
                sb.appendLine("En tu mensaje, lista todo lo que se va a crear.")
            }
        }

        sb.appendLine()
        sb.appendLine("=== FORMATO DE RESPUESTA (OBLIGATORIO) ===")
        sb.appendLine("Responde UNICAMENTE con un JSON valido:")
        sb.appendLine("""{
  "message": "texto conversacional para el usuario",
  "next_step": "PRODUCTS|SCHEDULES|CONFIRM|null",
  "business_name": "nombre o null",
  "business_description": "descripcion o null",
  "business_category": "rubro o null",
  "address": "direccion o null",
  "phone": "telefono o null",
  "categories": [{"name": "...", "description": "..."}],
  "products": [{"name": "...", "short_description": "...", "base_price": 0.0, "unit": "unidad", "category": "..."}],
  "schedules": [{"day": "Lunes", "is_open": true, "open_time": "09:00", "close_time": "18:00"}],
  "confidence": 0.85,
  "needs_clarification": false
}""")
        sb.appendLine("Solo incluye los campos relevantes al paso actual. No incluyas texto fuera del JSON.")

        return sb.toString()
    }

    internal fun parseOnboardingResponse(
        rawText: String,
        step: OnboardingStep,
        accumulatedContext: AccumulatedOnboardingContext?
    ): OnboardingStepResult {
        return try {
            val jsonText = extractJson(rawText)
            val parsed = gson.fromJson(jsonText, ClaudeOnboardingResponse::class.java)

            // Merge con contexto acumulado
            val currentCtx = accumulatedContext ?: AccumulatedOnboardingContext()
            val updatedCtx = currentCtx.copy(
                businessName = parsed.businessName ?: currentCtx.businessName,
                businessDescription = parsed.businessDescription ?: currentCtx.businessDescription,
                businessCategory = parsed.businessCategory ?: currentCtx.businessCategory,
                address = parsed.address ?: currentCtx.address,
                phone = parsed.phone ?: currentCtx.phone,
                categories = if (!parsed.categories.isNullOrEmpty()) {
                    currentCtx.categories + parsed.categories
                } else {
                    currentCtx.categories
                },
                products = if (!parsed.products.isNullOrEmpty()) {
                    currentCtx.products + parsed.products
                } else {
                    currentCtx.products
                },
                schedules = if (!parsed.schedules.isNullOrEmpty()) {
                    parsed.schedules // Los horarios se reemplazan completos
                } else {
                    currentCtx.schedules
                }
            )

            val nextStep = try {
                parsed.nextStep?.let { OnboardingStep.valueOf(it) }
            } catch (_: IllegalArgumentException) {
                suggestNextStep(step)
            }

            OnboardingStepResult(
                message = parsed.message,
                nextStep = nextStep ?: suggestNextStep(step),
                accumulatedContext = updatedCtx,
                confidence = parsed.confidence,
                needsClarification = parsed.needsClarification
            )
        } catch (e: Exception) {
            logger.warn("No se pudo parsear respuesta de onboarding: ${e.message}")
            OnboardingStepResult(
                message = "No pude entender bien lo que dijiste. Podrias repetirlo con otras palabras?",
                nextStep = step,
                accumulatedContext = accumulatedContext ?: AccumulatedOnboardingContext(),
                confidence = 0.0,
                needsClarification = true
            )
        }
    }

    private fun suggestNextStep(currentStep: OnboardingStep): OnboardingStep? {
        return when (currentStep) {
            OnboardingStep.BUSINESS_TYPE -> OnboardingStep.PRODUCTS
            OnboardingStep.PRODUCTS -> OnboardingStep.SCHEDULES
            OnboardingStep.SCHEDULES -> OnboardingStep.CONFIRM
            OnboardingStep.CONFIRM -> null
        }
    }

    private fun extractJson(text: String): String {
        val jsonBlockRegex = Regex("""```(?:json)?\s*(\{.*?})\s*```""", RegexOption.DOT_MATCHES_ALL)
        jsonBlockRegex.find(text)?.let { return it.groupValues[1] }

        val jsonObjectRegex = Regex("""\{.*"message".*}""", RegexOption.DOT_MATCHES_ALL)
        jsonObjectRegex.find(text)?.let { return it.value }

        return text.trim()
    }
}
