package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import com.google.gson.Gson
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import java.time.Instant
import java.time.temporal.ChronoUnit

// --- Response classes ---

/**
 * Respuesta con las sugerencias de promo para el negocio.
 */
class PromoSuggestionsResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val suggestions: List<PromoSuggestionPayload> = emptyList(),
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

data class PromoSuggestionPayload(
    val id: String = "",
    val productId: String = "",
    val productName: String = "",
    val promoType: String = "",
    val discountPercent: Int? = null,
    val promoText: String = "",
    val reason: String = "",
    val status: String = "PENDING",
    val startDate: String? = null,
    val endDate: String? = null,
    val daysSinceLastSale: Int = 0,
    val createdAt: String? = null
)

/**
 * Respuesta tras aprobar/rechazar una promo.
 */
class ReviewPromoResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val suggestion: PromoSuggestionPayload? = null,
    val productUpdated: Boolean = false,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * Request para revisar (aprobar/rechazar) una promo sugerida.
 */
data class ReviewPromoRequest(
    val action: String = "",
    val modifiedPromoText: String? = null,
    val modifiedDiscountPercent: Int? = null,
    val startDate: String? = null,
    val endDate: String? = null
)

/**
 * Respuesta con la configuracion de baja rotacion del negocio.
 */
class LowRotationConfigResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val thresholdDays: Int = 7,
    val autoPromoEnabled: Boolean = false,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * Request para configurar el umbral de baja rotacion.
 */
data class LowRotationConfigRequest(
    val thresholdDays: Int = 7,
    val enabled: Boolean = true
)

/**
 * Endpoint protegido para gestionar promos automaticas generadas por IA.
 *
 * GET /{business}/business/auto-promos -> Lista sugerencias de promo (genera si no hay pendientes)
 * POST /{business}/business/auto-promos/{promoId}/review -> Aprobar/rechazar una sugerencia
 * GET /{business}/business/auto-promos/config -> Ver configuracion de baja rotacion
 * PUT /{business}/business/auto-promos/config -> Actualizar configuracion de baja rotacion
 */
class BusinessAutoPromosFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableBusiness: DynamoDbTable<Business>,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>,
    private val lowRotationAnalyzer: LowRotationAnalyzer,
    private val promoGenerator: PromoGeneratorService,
    private val promoRepository: PromoSuggestionRepository,
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
        logger.debug("Iniciando business/auto-promos para negocio=$business, function=$function")

        requireApprovedProfile(
            cognito, headers, tableProfiles, business, PROFILE_BUSINESS_ADMIN
        ) ?: return UnauthorizedException()

        // Verificar que el negocio existe
        val key = Business().apply { name = business }
        val businessEntity = tableBusiness.getItem(key)
            ?: return ExceptionResponse("Negocio no encontrado", HttpStatusCode.NotFound)

        val method = headers["X-Http-Method"]?.uppercase() ?: HttpMethod.Get.value.uppercase()

        // Routing basado en la sub-ruta
        return when {
            function.endsWith("/config") && method == "GET" -> handleGetConfig(businessEntity)
            function.endsWith("/config") && method == "PUT" -> handlePutConfig(businessEntity, textBody)
            function.contains("/review") -> handleReview(business, function, textBody)
            method == "GET" -> handleListSuggestions(business, businessEntity)
            else -> RequestValidationException("Metodo no soportado: $method")
        }
    }

    /**
     * GET - Lista las sugerencias de promo. Si no hay pendientes, analiza y genera nuevas.
     */
    private suspend fun handleListSuggestions(business: String, businessEntity: Business): Response {
        val thresholdDays = businessEntity.lowRotationThresholdDays ?: 7

        // Verificar si ya hay sugerencias pendientes
        var pending = promoRepository.listPending(business)

        if (pending.isEmpty()) {
            // Generar nuevas sugerencias
            logger.info("Sin promos pendientes para negocio=$business, generando nuevas...")
            val lowRotation = lowRotationAnalyzer.detectLowRotation(business, thresholdDays)

            if (lowRotation.isEmpty()) {
                logger.info("No se detectaron productos con baja rotacion para negocio=$business")
                return PromoSuggestionsResponse(suggestions = emptyList())
            }

            // Generar promos para los primeros 5 productos con peor rotacion
            val now = Instant.now().toString()
            for (product in lowRotation.take(5)) {
                val generatedPromo = promoGenerator.generatePromo(business, product)
                val suggestion = PromoSuggestion(
                    productId = product.productId,
                    productName = product.productName,
                    promoType = generatedPromo.promoType,
                    discountPercent = generatedPromo.discountPercent,
                    promoText = generatedPromo.promoText,
                    reason = generatedPromo.reason,
                    status = "PENDING",
                    daysSinceLastSale = product.daysSinceLastSale,
                    createdAt = now
                )
                promoRepository.save(business, suggestion)
            }

            pending = promoRepository.listPending(business)
            logger.info("Generadas ${pending.size} sugerencias de promo para negocio=$business")
        }

        val payloads = pending.map { it.toPayload() }
        return PromoSuggestionsResponse(suggestions = payloads)
    }

    /**
     * POST - Aprobar o rechazar una sugerencia de promo.
     */
    private fun handleReview(business: String, function: String, textBody: String): Response {
        // Extraer promoId de la ruta: business/auto-promos/{promoId}/review
        val parts = function.split("/")
        val promoIdIndex = parts.indexOf("auto-promos") + 1
        if (promoIdIndex >= parts.size) {
            return RequestValidationException("Falta el ID de la promo en la ruta")
        }
        val promoId = parts[promoIdIndex]

        val body = parseBody<ReviewPromoRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        val action = body.action.uppercase()
        if (action !in listOf("APPROVE", "REJECT")) {
            return RequestValidationException("Accion invalida: '${body.action}'. Usar 'approve' o 'reject'")
        }

        val existing = promoRepository.get(business, promoId)
            ?: return ExceptionResponse("Sugerencia de promo no encontrada", HttpStatusCode.NotFound)

        if (existing.status != "PENDING") {
            return ExceptionResponse("La promo ya fue ${existing.status.lowercase()}", HttpStatusCode.Conflict)
        }

        return when (action) {
            "APPROVE" -> approvePromo(business, promoId, existing, body)
            "REJECT" -> rejectPromo(business, promoId)
            else -> RequestValidationException("Accion invalida")
        }
    }

    private fun approvePromo(
        business: String,
        promoId: String,
        existing: PromoSuggestion,
        body: ReviewPromoRequest
    ): Response {
        val now = Instant.now()
        val startDate = body.startDate ?: now.toString()
        val endDate = body.endDate ?: now.plus(7, ChronoUnit.DAYS).toString()

        // Actualizar la sugerencia
        val updated = existing.copy(
            status = "APPROVED",
            promoText = body.modifiedPromoText ?: existing.promoText,
            discountPercent = body.modifiedDiscountPercent ?: existing.discountPercent,
            startDate = startDate,
            endDate = endDate
        )
        promoRepository.update(business, promoId, updated)

        // Aplicar el precio promocional al producto
        var productUpdated = false
        if (updated.promoType == "DISCOUNT_PERCENT" && updated.discountPercent != null) {
            val product = productRepository.getProduct(business, updated.productId)
            if (product != null) {
                val promoPrice = product.basePrice * (1 - updated.discountPercent / 100.0)
                productRepository.updateProduct(
                    business,
                    product.id,
                    product.copy(promotionPrice = promoPrice)
                )
                productUpdated = true
                logger.info("Precio promocional aplicado al producto ${product.name}: \$${"%.2f".format(promoPrice)} para negocio=$business")
            }
        }

        logger.info("Promo aprobada: id=$promoId, producto=${updated.productName}, negocio=$business")
        return ReviewPromoResponse(
            suggestion = updated.toPayload(),
            productUpdated = productUpdated
        )
    }

    private fun rejectPromo(business: String, promoId: String): Response {
        val updated = promoRepository.updateStatus(business, promoId, "REJECTED")
            ?: return ExceptionResponse("Error actualizando promo", HttpStatusCode.InternalServerError)

        logger.info("Promo rechazada: id=$promoId, producto=${updated.productName}, negocio=$business")
        return ReviewPromoResponse(
            suggestion = updated.toPayload(),
            productUpdated = false
        )
    }

    /**
     * GET - Retorna la configuracion actual de baja rotacion.
     */
    private fun handleGetConfig(businessEntity: Business): Response {
        return LowRotationConfigResponse(
            thresholdDays = businessEntity.lowRotationThresholdDays ?: 7,
            autoPromoEnabled = businessEntity.autoPromoEnabled
        )
    }

    /**
     * PUT - Actualiza la configuracion de baja rotacion.
     */
    private fun handlePutConfig(businessEntity: Business, textBody: String): Response {
        val body = parseBody<LowRotationConfigRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        if (body.thresholdDays < 1 || body.thresholdDays > 90) {
            return RequestValidationException("El umbral debe estar entre 1 y 90 dias")
        }

        businessEntity.lowRotationThresholdDays = body.thresholdDays
        businessEntity.autoPromoEnabled = body.enabled
        tableBusiness.updateItem(businessEntity)

        logger.info("Configuracion de baja rotacion actualizada para negocio=${businessEntity.name}: threshold=${body.thresholdDays}, enabled=${body.enabled}")
        return LowRotationConfigResponse(
            thresholdDays = body.thresholdDays,
            autoPromoEnabled = body.enabled
        )
    }

    private fun PromoSuggestion.toPayload() = PromoSuggestionPayload(
        id = id,
        productId = productId,
        productName = productName,
        promoType = promoType,
        discountPercent = discountPercent,
        promoText = promoText,
        reason = reason,
        status = status,
        startDate = startDate,
        endDate = endDate,
        daysSinceLastSale = daysSinceLastSale,
        createdAt = createdAt
    )
}
