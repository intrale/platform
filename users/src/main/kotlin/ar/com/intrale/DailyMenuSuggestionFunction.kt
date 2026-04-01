package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import com.google.gson.Gson
import com.google.gson.annotations.SerializedName
import com.google.gson.reflect.TypeToken
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

/**
 * Respuesta estructurada de Claude para sugerencia de menu.
 */
data class AiMenuSuggestion(
    val title: String = "",
    val description: String = "",
    val items: List<AiMenuSuggestionItem> = emptyList(),
    val reasoning: String = ""
)

data class AiMenuSuggestionItem(
    @SerializedName("product_id")
    val productId: String = "",
    @SerializedName("product_name")
    val productName: String = "",
    val description: String = "",
    @SerializedName("suggested_price")
    val suggestedPrice: Double = 0.0
)

/**
 * Respuesta del endpoint de sugerencia de menu del dia.
 */
class DailyMenuSuggestionResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val suggestion: DailyMenuSuggestion? = null,
    val message: String = "",
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * Endpoint protegido para generar sugerencias de menu del dia.
 * Solo accesible por BusinessAdmin de negocios gastronomicos.
 *
 * GET /{business}/business/daily-menu -> Obtener sugerencia actual o generar nueva
 * POST /{business}/business/daily-menu -> Forzar nueva sugerencia (pedir otra)
 */
class DailyMenuSuggestionFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableBusiness: DynamoDbTable<Business>,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>,
    private val productRepository: ProductRepository,
    private val orderRepository: ClientOrderRepository,
    private val menuRepository: DailyMenuRepository,
    private val aiService: AiResponseService,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    private val gson = Gson()
    private companion object {
        const val MAX_DAILY_SUGGESTIONS = 5
    }

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("Iniciando business/daily-menu para negocio=$business")

        requireApprovedProfile(
            cognito, headers, tableProfiles, business, PROFILE_BUSINESS_ADMIN
        ) ?: return UnauthorizedException()

        val businessEntity = tableBusiness.getItem(Business().apply { name = business })
            ?: return ExceptionResponse("Negocio no encontrado", HttpStatusCode.NotFound)

        if (!businessEntity.dailyMenuEnabled) {
            return ExceptionResponse(
                "El menu del dia no esta habilitado para este negocio",
                HttpStatusCode.Forbidden
            )
        }

        val method = headers["X-Http-Method"]?.uppercase() ?: "GET"

        return when (method) {
            "GET" -> handleGetOrGenerate(business, businessEntity)
            "POST" -> handleForceNewSuggestion(business, businessEntity)
            else -> RequestValidationException("Metodo no soportado: $method")
        }
    }

    /**
     * GET: retorna la sugerencia existente del dia o genera una nueva.
     */
    private suspend fun handleGetOrGenerate(business: String, businessEntity: Business): Response {
        val existing = menuRepository.getLatestSuggestion(business)
        if (existing != null && existing.status == "PENDING") {
            logger.debug("Retornando sugerencia existente para negocio=$business id=${existing.id}")
            return DailyMenuSuggestionResponse(
                suggestion = existing,
                message = "Sugerencia del dia disponible"
            )
        }

        return generateNewSuggestion(business, businessEntity)
    }

    /**
     * POST: genera una nueva sugerencia descartando la anterior pendiente.
     */
    private suspend fun handleForceNewSuggestion(business: String, businessEntity: Business): Response {
        val todayCount = menuRepository.countTodaySuggestions(business)
        if (todayCount >= MAX_DAILY_SUGGESTIONS) {
            return ExceptionResponse(
                "Se alcanzo el limite de $MAX_DAILY_SUGGESTIONS sugerencias por dia",
                HttpStatusCode.TooManyRequests
            )
        }

        return generateNewSuggestion(business, businessEntity)
    }

    /**
     * Genera una nueva sugerencia de menu usando IA.
     */
    internal suspend fun generateNewSuggestion(business: String, businessEntity: Business): Response {
        val products = productRepository.listPublishedProducts(business)
        if (products.isEmpty()) {
            return ExceptionResponse(
                "No hay productos publicados para generar un menu",
                HttpStatusCode.UnprocessableEntity
            )
        }

        val availableProducts = products.filter { it.isAvailable && (it.stockQuantity == null || it.stockQuantity!! > 0) }
        if (availableProducts.isEmpty()) {
            return ExceptionResponse(
                "No hay productos con stock disponible para generar un menu",
                HttpStatusCode.UnprocessableEntity
            )
        }

        val recentMenus = menuRepository.getRecentApprovedMenus(business, days = 3)
        val recentOrders = orderRepository.listAllOrdersForBusiness(business)
        val context = buildBusinessContext(businessEntity, business)
        val menuPrompt = buildMenuPrompt(availableProducts, recentMenus, recentOrders)

        return try {
            val result = aiService.generateResponse(context, menuPrompt)

            if (result.escalated) {
                logger.warn("IA no pudo generar sugerencia de menu para negocio=$business")
                return DailyMenuSuggestionResponse(
                    message = "No se pudo generar una sugerencia automatica. Arma el menu manualmente.",
                    status = HttpStatusCode.OK
                )
            }

            val aiSuggestion = parseMenuSuggestion(result.answer)
            val suggestion = DailyMenuSuggestion(
                businessName = business,
                title = aiSuggestion.title.ifBlank { "Menu del dia" },
                description = aiSuggestion.description,
                items = aiSuggestion.items.map { item ->
                    DailyMenuItem(
                        productId = item.productId,
                        productName = item.productName,
                        description = item.description,
                        suggestedPrice = item.suggestedPrice
                    )
                },
                reasoning = aiSuggestion.reasoning,
                status = "PENDING"
            )

            val stored = menuRepository.storeSuggestion(business, suggestion)
            logger.info("Sugerencia de menu generada para negocio=$business id=${stored.id}")

            DailyMenuSuggestionResponse(
                suggestion = stored,
                message = "Nueva sugerencia de menu generada"
            )
        } catch (e: Exception) {
            logger.error("Error generando sugerencia de menu para negocio=$business", e)
            DailyMenuSuggestionResponse(
                message = "Error generando la sugerencia. Intenta de nuevo o arma el menu manualmente.",
                status = HttpStatusCode.InternalServerError
            )
        }
    }

    internal fun buildBusinessContext(businessEntity: Business, businessName: String): BusinessContext {
        val schedules = deserializeList<DayScheduleRecord>(businessEntity.schedulesJson)
        val deliveryZone = deserializeObject<DeliveryZoneRecord>(businessEntity.deliveryZoneJson)
        val paymentMethods = deserializeList<PaymentMethodRecord>(businessEntity.paymentMethodsJson)
        val products = productRepository.listPublishedProducts(businessName).map { p ->
            ProductSummary(
                name = p.name,
                shortDescription = p.shortDescription,
                basePrice = p.basePrice,
                unit = p.unit,
                category = p.categoryId,
                isAvailable = p.isAvailable
            )
        }

        return BusinessContext(
            businessName = businessName,
            description = businessEntity.description,
            address = businessEntity.address,
            phone = businessEntity.phone,
            schedules = schedules,
            deliveryZone = deliveryZone,
            paymentMethods = paymentMethods,
            products = products
        )
    }

    internal fun buildMenuPrompt(
        availableProducts: List<ProductRecord>,
        recentMenus: List<DailyMenuSuggestion>,
        recentOrders: List<BusinessOrderItem>
    ): String {
        val sb = StringBuilder()
        sb.appendLine("Necesito que generes una sugerencia de MENU DEL DIA para mi negocio gastronomico.")
        sb.appendLine()
        sb.appendLine("=== PRODUCTOS DISPONIBLES CON STOCK ===")
        availableProducts.forEach { p ->
            val stock = p.stockQuantity?.let { " (stock: $it)" } ?: ""
            sb.appendLine("- ID: ${p.id} | ${p.name} | \$${p.basePrice} | ${p.unit}$stock")
        }

        if (recentMenus.isNotEmpty()) {
            sb.appendLine()
            sb.appendLine("=== MENUS RECIENTES (NO REPETIR) ===")
            recentMenus.forEach { menu ->
                sb.appendLine("Fecha ${menu.date}: ${menu.title}")
                menu.items.forEach { item ->
                    sb.appendLine("  - ${item.productName}")
                }
            }
        }

        if (recentOrders.isNotEmpty()) {
            sb.appendLine()
            sb.appendLine("=== PRODUCTOS MAS VENDIDOS (ultimos pedidos) ===")
            val productCounts = recentOrders
                .flatMap { it.order.items ?: emptyList() }
                .groupBy { it.productId }
                .mapValues { it.value.sumOf { item -> item.quantity } }
                .toList()
                .sortedByDescending { it.second }
                .take(10)
            productCounts.forEach { (productId, count) ->
                val name = availableProducts.firstOrNull { it.id == productId }?.name ?: productId
                sb.appendLine("  - $name: $count unidades vendidas")
            }
        }

        sb.appendLine()
        sb.appendLine("=== INSTRUCCIONES ===")
        sb.appendLine("1. Selecciona 2 a 4 productos del stock disponible que formen un buen menu del dia")
        sb.appendLine("2. Prioriza los productos mas vendidos pero NO repitas el menu de los ultimos 3 dias")
        sb.appendLine("3. Podes sugerir un precio especial de combo si tiene sentido")
        sb.appendLine()
        sb.appendLine("=== FORMATO DE RESPUESTA (JSON OBLIGATORIO) ===")
        sb.appendLine("""{"answer": "{\"title\": \"Menu del dia\", \"description\": \"Descripcion atractiva del menu\", \"items\": [{\"product_id\": \"id\", \"product_name\": \"nombre\", \"description\": \"como se prepara o presenta\", \"suggested_price\": 1500.0}], \"reasoning\": \"Por que elegiste estos productos\"}", "confidence": 0.9, "escalate": false}""")

        return sb.toString()
    }

    internal fun parseMenuSuggestion(answer: String): AiMenuSuggestion {
        return try {
            gson.fromJson(answer, AiMenuSuggestion::class.java) ?: AiMenuSuggestion()
        } catch (e: Exception) {
            logger.warn("Error parseando sugerencia de menu de IA: ${e.message}")
            AiMenuSuggestion(
                title = "Menu del dia",
                description = answer.take(200),
                reasoning = "Sugerencia generada sin formato estructurado"
            )
        }
    }

    private inline fun <reified T> deserializeList(json: String?): List<T> {
        if (json.isNullOrBlank()) return emptyList()
        return try {
            val type = object : TypeToken<List<T>>() {}.type
            gson.fromJson(json, type) ?: emptyList()
        } catch (e: Exception) {
            logger.error("Error deserializando lista JSON", e)
            emptyList()
        }
    }

    private inline fun <reified T> deserializeObject(json: String?): T? {
        if (json.isNullOrBlank()) return null
        return try {
            gson.fromJson(json, T::class.java)
        } catch (e: Exception) {
            logger.error("Error deserializando objeto JSON", e)
            null
        }
    }
}
