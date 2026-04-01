package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import java.time.Instant
import java.util.UUID

// --- Request/Response DTOs ---

/**
 * Request para generar sugerencias de pricing.
 * Opcionalmente incluye datos de ventas; si no se envian,
 * se genera un analisis con datos simulados del catalogo.
 */
data class GeneratePricingSuggestionsRequest(
    val salesData: List<SalesSlotDataRequest>? = null
)

data class SalesSlotDataRequest(
    val productName: String = "",
    val dayOfWeek: String = "",
    val timeSlot: String = "",
    val averageQuantity: Double = 0.0,
    val averageRevenue: Double = 0.0,
    val currentPrice: Double = 0.0
)

/**
 * Request para aprobar, modificar o rechazar una sugerencia.
 */
data class PricingSuggestionDecisionRequest(
    val suggestionId: String = "",
    val action: String = "",
    val modifiedPrice: Double? = null,
    val scheduledStart: String? = null,
    val scheduledEnd: String? = null
)

/**
 * Modelo interno de sugerencia almacenada.
 */
data class StoredPricingSuggestion(
    val id: String = "",
    val productName: String = "",
    val currentPrice: Double = 0.0,
    val suggestedPrice: Double = 0.0,
    val changePercent: Double = 0.0,
    val reason: String = "",
    val dataInsight: String = "",
    val timeSlot: String? = null,
    val dayOfWeek: String? = null,
    val status: String = "pending",
    val createdAt: String = "",
    val decidedAt: String? = null,
    val appliedPrice: Double? = null,
    val scheduledStart: String? = null,
    val scheduledEnd: String? = null,
    val impactSummary: String? = null
)

/**
 * Respuesta con sugerencias de pricing.
 */
class PricingSuggestionsResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val suggestions: List<StoredPricingSuggestion> = emptyList(),
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * Respuesta con historial de sugerencias.
 */
class PricingSuggestionsHistoryResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val history: List<StoredPricingSuggestion> = emptyList(),
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * Endpoint protegido para gestionar sugerencias de pricing dinamico.
 *
 * GET  /{business}/business/pricing-suggestions          -> Obtener sugerencias pendientes
 * POST /{business}/business/pricing-suggestions          -> Generar nuevas sugerencias (invoca IA)
 * PUT  /{business}/business/pricing-suggestions          -> Aprobar/rechazar/modificar una sugerencia
 * GET  /{business}/business/pricing-suggestions?history=true -> Historial de decisiones
 */
class PricingSuggestionsFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableBusiness: DynamoDbTable<Business>,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>,
    private val pricingAnalysisService: PricingAnalysisService,
    private val productRepository: ProductRepository,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    private val gson = Gson()

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("Iniciando business/pricing-suggestions para negocio=$business")

        requireApprovedProfile(
            cognito, headers, tableProfiles, business, PROFILE_BUSINESS_ADMIN
        ) ?: return UnauthorizedException()

        val method = headers["X-Http-Method"]?.uppercase() ?: HttpMethod.Get.value.uppercase()
        val queryHistory = headers["X-Query-history"]?.lowercase() == "true"

        return when (method) {
            HttpMethod.Get.value.uppercase() -> {
                if (queryHistory) handleGetHistory(business) else handleGetPending(business)
            }
            HttpMethod.Post.value.uppercase() -> handleGenerate(business, textBody)
            HttpMethod.Put.value.uppercase() -> handleDecision(business, textBody)
            else -> RequestValidationException("Metodo no soportado: $method")
        }
    }

    /**
     * GET: Retorna las sugerencias pendientes de decision.
     */
    private fun handleGetPending(business: String): Response {
        val biz = tableBusiness.getItem(Business().apply { name = business })
            ?: return ExceptionResponse("Negocio no encontrado", HttpStatusCode.NotFound)

        val suggestions = loadSuggestions(biz)
        val pending = suggestions.filter { it.status == "pending" }

        logger.debug("Retornando ${pending.size} sugerencias pendientes para negocio=$business")
        return PricingSuggestionsResponse(suggestions = pending)
    }

    /**
     * GET ?history=true: Retorna el historial de sugerencias ya decididas.
     */
    private fun handleGetHistory(business: String): Response {
        val biz = tableBusiness.getItem(Business().apply { name = business })
            ?: return ExceptionResponse("Negocio no encontrado", HttpStatusCode.NotFound)

        val suggestions = loadSuggestions(biz)
        val decided = suggestions.filter { it.status != "pending" }
            .sortedByDescending { it.decidedAt ?: it.createdAt }

        logger.debug("Retornando ${decided.size} sugerencias del historial para negocio=$business")
        return PricingSuggestionsHistoryResponse(history = decided)
    }

    /**
     * POST: Genera nuevas sugerencias de pricing invocando el servicio de IA.
     */
    private suspend fun handleGenerate(business: String, textBody: String): Response {
        val biz = tableBusiness.getItem(Business().apply { name = business })
            ?: return ExceptionResponse("Negocio no encontrado", HttpStatusCode.NotFound)

        val request = if (textBody.isNotEmpty()) parseBody<GeneratePricingSuggestionsRequest>(textBody) else null

        // Obtener productos del catalogo
        val products = try {
            productRepository.listPublishedProducts(business).map { p ->
                ProductSummary(
                    name = p.name,
                    shortDescription = p.shortDescription,
                    basePrice = p.basePrice,
                    unit = p.unit,
                    category = p.categoryId,
                    isAvailable = p.isAvailable
                )
            }
        } catch (e: Exception) {
            logger.warn("No se pudieron obtener productos para pricing: ${e.message}")
            emptyList()
        }

        if (products.isEmpty()) {
            return RequestValidationException("El negocio no tiene productos cargados para analizar")
        }

        // Preparar datos de ventas
        val salesData = request?.salesData?.map { s ->
            SalesSlotData(
                productName = s.productName,
                dayOfWeek = s.dayOfWeek,
                timeSlot = s.timeSlot,
                averageQuantity = s.averageQuantity,
                averageRevenue = s.averageRevenue,
                currentPrice = s.currentPrice
            )
        } ?: generateSampleSalesData(products)

        // Invocar IA
        val aiSuggestions = pricingAnalysisService.analyzePricing(business, salesData, products)

        if (aiSuggestions.isEmpty()) {
            logger.info("IA no genero sugerencias de pricing para negocio=$business")
            return PricingSuggestionsResponse(suggestions = emptyList())
        }

        // Convertir a modelo almacenable
        val now = Instant.now().toString()
        val storedSuggestions = aiSuggestions.map { s ->
            StoredPricingSuggestion(
                id = UUID.randomUUID().toString().take(8),
                productName = s.productName,
                currentPrice = s.currentPrice,
                suggestedPrice = s.suggestedPrice,
                changePercent = s.changePercent,
                reason = s.reason,
                dataInsight = s.dataInsight,
                timeSlot = s.timeSlot,
                dayOfWeek = s.dayOfWeek,
                status = "pending",
                createdAt = now
            )
        }

        // Guardar: agregar a las existentes
        val existing = loadSuggestions(biz)
        val all = existing + storedSuggestions
        saveSuggestions(biz, all)

        logger.info("Generadas ${storedSuggestions.size} sugerencias de pricing para negocio=$business")
        return PricingSuggestionsResponse(suggestions = storedSuggestions)
    }

    /**
     * PUT: Aprobar, modificar o rechazar una sugerencia.
     */
    private fun handleDecision(business: String, textBody: String): Response {
        val body = parseBody<PricingSuggestionDecisionRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        if (body.suggestionId.isBlank()) {
            return RequestValidationException("suggestionId es requerido")
        }

        val validActions = setOf("approved", "rejected", "modified")
        if (body.action !in validActions) {
            return RequestValidationException("action debe ser uno de: $validActions")
        }

        if (body.action == "modified" && body.modifiedPrice == null) {
            return RequestValidationException("modifiedPrice es requerido cuando action es 'modified'")
        }

        val biz = tableBusiness.getItem(Business().apply { name = business })
            ?: return ExceptionResponse("Negocio no encontrado", HttpStatusCode.NotFound)

        val suggestions = loadSuggestions(biz).toMutableList()
        val index = suggestions.indexOfFirst { it.id == body.suggestionId }

        if (index == -1) {
            return ExceptionResponse("Sugerencia no encontrada: ${body.suggestionId}", HttpStatusCode.NotFound)
        }

        val suggestion = suggestions[index]
        if (suggestion.status != "pending") {
            return RequestValidationException("La sugerencia ya fue procesada con estado: ${suggestion.status}")
        }

        val now = Instant.now().toString()
        val updated = suggestion.copy(
            status = body.action,
            decidedAt = now,
            appliedPrice = when (body.action) {
                "approved" -> suggestion.suggestedPrice
                "modified" -> body.modifiedPrice
                else -> null
            },
            scheduledStart = body.scheduledStart,
            scheduledEnd = body.scheduledEnd
        )

        suggestions[index] = updated
        saveSuggestions(biz, suggestions)

        logger.info("Sugerencia ${body.suggestionId} marcada como '${body.action}' para negocio=$business")

        val pending = suggestions.filter { it.status == "pending" }
        return PricingSuggestionsResponse(suggestions = pending)
    }

    // --- Utilidades de persistencia ---

    private fun loadSuggestions(biz: Business): List<StoredPricingSuggestion> {
        val json = biz.pricingSuggestionsJson ?: return emptyList()
        return try {
            val type = object : TypeToken<List<StoredPricingSuggestion>>() {}.type
            gson.fromJson(json, type) ?: emptyList()
        } catch (e: Exception) {
            logger.warn("Error parseando sugerencias almacenadas: ${e.message}")
            emptyList()
        }
    }

    private fun saveSuggestions(biz: Business, suggestions: List<StoredPricingSuggestion>) {
        biz.pricingSuggestionsJson = gson.toJson(suggestions)
        tableBusiness.updateItem(biz)
    }

    /**
     * Genera datos de ventas de ejemplo a partir del catalogo de productos.
     * Util cuando el negocio aun no tiene datos historicos reales.
     */
    private fun generateSampleSalesData(products: List<ProductSummary>): List<SalesSlotData> {
        val days = listOf("lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo")
        val slots = listOf("08:00-12:00", "12:00-16:00", "16:00-20:00", "20:00-00:00")

        return products.take(5).flatMap { product ->
            days.flatMap { day ->
                slots.map { slot ->
                    val baseQty = (1..10).random().toDouble()
                    SalesSlotData(
                        productName = product.name,
                        dayOfWeek = day,
                        timeSlot = slot,
                        averageQuantity = baseQty,
                        averageRevenue = baseQty * product.basePrice,
                        currentPrice = product.basePrice
                    )
                }
            }
        }
    }
}
