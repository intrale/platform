package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.TextStyle
import java.util.Locale

/**
 * Respuesta con la prediccion de demanda semanal.
 */
class DemandPredictionResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val weekStartDate: String = "",
    val weekEndDate: String = "",
    val topProducts: List<Map<String, Any?>> = emptyList(),
    val summary: String = "",
    val dataWeeksUsed: Int = 0,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * Endpoint protegido para obtener la prediccion de demanda semanal del negocio.
 * Analiza ventas historicas y genera sugerencias de stock con IA.
 *
 * GET /{business}/business/demand-prediction -> Prediccion para la proxima semana
 *
 * Requiere perfil BUSINESS_ADMIN aprobado.
 */
class DemandPredictionFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>,
    private val orderRepository: ClientOrderRepository,
    private val productRepository: ProductRepository,
    private val predictionService: DemandPredictionService,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.info("Generando prediccion de demanda para negocio=$business")

        // Verificar autorizacion
        requireApprovedProfile(
            cognito, headers, tableProfiles, business, PROFILE_BUSINESS_ADMIN
        ) ?: return UnauthorizedException()

        return try {
            // Obtener historial de ventas del negocio
            val salesHistory = buildSalesHistory(business)

            if (salesHistory.isEmpty()) {
                logger.info("Sin datos de ventas para negocio=$business")
                return DemandPredictionResponse(
                    statusCode_value = mapOf("value" to 200, "description" to "OK"),
                    summary = "No hay suficientes datos de ventas para generar una prediccion. " +
                            "Se necesitan al menos 2 semanas de datos.",
                    dataWeeksUsed = 0
                )
            }

            // Calcular el inicio de la proxima semana (lunes)
            val today = LocalDate.now()
            val nextMonday = today.with(java.time.temporal.TemporalAdjusters.next(DayOfWeek.MONDAY))

            // Generar prediccion con IA
            val prediction = predictionService.generatePrediction(
                businessName = business,
                salesHistory = salesHistory,
                targetWeekStart = nextMonday
            )

            val topProductsMaps = prediction.topProducts.map { p ->
                mapOf<String, Any?>(
                    "productName" to p.productName,
                    "expectedQuantity" to p.expectedQuantity,
                    "trend" to p.trend,
                    "changePercent" to p.changePercent,
                    "stockAlert" to p.stockAlert,
                    "insight" to p.insight
                )
            }

            logger.info("Prediccion generada para negocio=$business: ${prediction.topProducts.size} productos, ${prediction.dataWeeksUsed} semanas de datos")

            DemandPredictionResponse(
                weekStartDate = nextMonday.toString(),
                weekEndDate = nextMonday.plusDays(6).toString(),
                topProducts = topProductsMaps,
                summary = prediction.summary,
                dataWeeksUsed = prediction.dataWeeksUsed
            )
        } catch (e: Exception) {
            logger.error("Error generando prediccion de demanda para negocio=$business", e)
            ExceptionResponse(
                "Error generando prediccion de demanda: ${e.message}",
                HttpStatusCode.InternalServerError
            )
        }
    }

    /**
     * Construye el historial de ventas a partir de las ordenes del negocio.
     * Agrupa los items vendidos por producto y dia.
     */
    internal fun buildSalesHistory(business: String): List<ProductDailySales> {
        val allOrders = orderRepository.listAllOrdersForBusiness(business)

        // Filtrar solo ordenes entregadas (completadas)
        val deliveredOrders = allOrders.filter {
            it.order.status.uppercase() == "DELIVERED"
        }

        if (deliveredOrders.isEmpty()) return emptyList()

        val salesByProductAndDate = mutableMapOf<String, MutableMap<String, ProductDailySales>>()

        for (orderItem in deliveredOrders) {
            val order = orderItem.order
            val orderDate = try {
                val instant = Instant.parse(order.createdAt ?: continue)
                instant.atZone(ZoneId.of("America/Argentina/Buenos_Aires")).toLocalDate()
            } catch (_: Exception) {
                continue
            }

            val dateStr = orderDate.toString()
            val dayOfWeek = orderDate.dayOfWeek.getDisplayName(TextStyle.FULL, Locale.of("es", "AR"))

            for (item in order.items) {
                val productName = item.name.ifBlank { item.productName }
                if (productName.isBlank()) continue

                val productSales = salesByProductAndDate.getOrPut(productName) { mutableMapOf() }
                val existing = productSales[dateStr]

                if (existing != null) {
                    productSales[dateStr] = existing.copy(
                        quantity = existing.quantity + item.quantity,
                        revenue = existing.revenue + item.subtotal
                    )
                } else {
                    productSales[dateStr] = ProductDailySales(
                        productName = productName,
                        date = dateStr,
                        dayOfWeek = dayOfWeek,
                        quantity = item.quantity,
                        revenue = item.subtotal
                    )
                }
            }
        }

        return salesByProductAndDate.values.flatMap { it.values }
    }
}
