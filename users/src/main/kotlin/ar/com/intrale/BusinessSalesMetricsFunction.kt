package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * Respuesta con las metricas diarias de ventas del negocio.
 * Compatible con DailySalesMetricsResponseDTO del shared module.
 */
class SalesMetricsResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val metrics: SalesMetricsPayload? = null,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

data class SalesMetricsPayload(
    val orderCount: Int = 0,
    val totalRevenue: Double = 0.0,
    val averageTicket: Double = 0.0,
    val previousDayOrderCount: Int = 0,
    val previousDayRevenue: Double = 0.0,
    val revenueChangePercent: Double = 0.0,
    val orderCountChangePercent: Double = 0.0,
    val topProductName: String? = null,
    val topProductQuantity: Int = 0
)

/**
 * Endpoint protegido para obtener metricas diarias de ventas del negocio.
 * Calcula resumen del dia actual comparado con el dia anterior.
 *
 * GET /{business}/business/sales-metrics -> Metricas de ventas del dia
 *
 * Requiere perfil BUSINESS_ADMIN aprobado.
 */
class BusinessSalesMetricsFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>,
    private val orderRepository: ClientOrderRepository,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    private val buenosAiresZone = ZoneId.of("America/Argentina/Buenos_Aires")

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.info("Calculando metricas de ventas para negocio=$business")

        // Verificar autorizacion
        requireApprovedProfile(
            cognito, headers, tableProfiles, business, PROFILE_BUSINESS_ADMIN
        ) ?: return UnauthorizedException()

        return try {
            val metrics = calculateDailyMetrics(business)

            SalesMetricsResponse(
                metrics = metrics
            )
        } catch (e: Exception) {
            logger.error("Error calculando metricas de ventas para negocio=$business", e)
            ExceptionResponse(
                "Error calculando metricas de ventas: ${e.message}",
                HttpStatusCode.InternalServerError
            )
        }
    }

    /**
     * Calcula las metricas de ventas del dia actual comparando con el dia anterior.
     */
    internal fun calculateDailyMetrics(business: String): SalesMetricsPayload {
        val allOrders = orderRepository.listAllOrdersForBusiness(business)
        val today = LocalDate.now(buenosAiresZone)
        val yesterday = today.minusDays(1)

        val todayOrders = filterOrdersByDate(allOrders, today)
        val yesterdayOrders = filterOrdersByDate(allOrders, yesterday)

        val todayCount = todayOrders.size
        val todayRevenue = todayOrders.sumOf { it.order.total }
        val todayAvgTicket = if (todayCount > 0) todayRevenue / todayCount else 0.0

        val yesterdayCount = yesterdayOrders.size
        val yesterdayRevenue = yesterdayOrders.sumOf { it.order.total }

        val revenueChange = calculateChangePercent(yesterdayRevenue, todayRevenue)
        val orderCountChange = calculateChangePercent(yesterdayCount.toDouble(), todayCount.toDouble())

        // Producto mas vendido del dia
        val topProduct = findTopProduct(todayOrders)

        return SalesMetricsPayload(
            orderCount = todayCount,
            totalRevenue = todayRevenue,
            averageTicket = Math.round(todayAvgTicket * 100.0) / 100.0,
            previousDayOrderCount = yesterdayCount,
            previousDayRevenue = yesterdayRevenue,
            revenueChangePercent = Math.round(revenueChange * 100.0) / 100.0,
            orderCountChangePercent = Math.round(orderCountChange * 100.0) / 100.0,
            topProductName = topProduct?.first,
            topProductQuantity = topProduct?.second ?: 0
        )
    }

    /**
     * Filtra ordenes entregadas por fecha (zona horaria de Buenos Aires).
     */
    internal fun filterOrdersByDate(
        orders: List<BusinessOrderItem>,
        date: LocalDate
    ): List<BusinessOrderItem> {
        return orders.filter { item ->
            val order = item.order
            if (order.status.uppercase() != "DELIVERED") return@filter false
            val orderDate = try {
                val instant = Instant.parse(order.createdAt ?: return@filter false)
                instant.atZone(buenosAiresZone).toLocalDate()
            } catch (_: Exception) {
                return@filter false
            }
            orderDate == date
        }
    }

    /**
     * Calcula el porcentaje de cambio entre dos valores.
     */
    internal fun calculateChangePercent(previous: Double, current: Double): Double {
        if (previous == 0.0) {
            return if (current > 0.0) 100.0 else 0.0
        }
        return ((current - previous) / previous) * 100.0
    }

    /**
     * Encuentra el producto mas vendido (por cantidad) en las ordenes dadas.
     * Retorna par (nombre, cantidad) o null si no hay items.
     */
    internal fun findTopProduct(orders: List<BusinessOrderItem>): Pair<String, Int>? {
        val productQuantities = mutableMapOf<String, Int>()

        for (orderItem in orders) {
            for (item in orderItem.order.items) {
                val name = item.name.ifBlank { item.productName }
                if (name.isBlank()) continue
                productQuantities[name] = (productQuantities[name] ?: 0) + item.quantity
            }
        }

        return productQuantities.maxByOrNull { it.value }?.let { Pair(it.key, it.value) }
    }
}
