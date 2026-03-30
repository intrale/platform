package ar.com.intrale

import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * Respuesta con métricas de ventas del día para el panel del negocio.
 *
 * Campos alineados con [ar.com.intrale.shared.business.DailySalesMetricsDTO].
 */
data class DailySalesMetricsResponse(
    val orderCount: Int = 0,
    val totalRevenue: Double = 0.0,
    val averageTicket: Double = 0.0,
    val previousDayOrderCount: Int = 0,
    val previousDayRevenue: Double = 0.0,
    val revenueChangePercent: Double = 0.0,
    val orderCountChangePercent: Double = 0.0,
    val topProductName: String? = null,
    val topProductQuantity: Int = 0,
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * GET /\{business\}/business/sales-metrics
 *
 * Calcula y devuelve las métricas de ventas del día actual comparadas
 * con el día anterior. Solo se consideran pedidos con estado DELIVERED.
 */
class BusinessSalesMetricsFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val repository: ClientOrderRepository,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config, logger, jwtValidator) {

    companion object {
        private const val COMPLETED_STATUS = "DELIVERED"
    }

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.info("Calculando métricas de ventas del día para negocio {}", business)

        val zoneId = ZoneId.of(headers["X-Query-timezone"] ?: "America/Argentina/Buenos_Aires")
        val today = LocalDate.now(zoneId)
        val yesterday = today.minusDays(1)

        val allOrders = repository.listAllOrdersForBusiness(business)

        val todayOrders = allOrders.filter { item ->
            item.order.status.equals(COMPLETED_STATUS, ignoreCase = true) &&
                item.order.createdAt?.let { isOnDate(it, today, zoneId) } == true
        }

        val yesterdayOrders = allOrders.filter { item ->
            item.order.status.equals(COMPLETED_STATUS, ignoreCase = true) &&
                item.order.createdAt?.let { isOnDate(it, yesterday, zoneId) } == true
        }

        val todayRevenue = todayOrders.sumOf { it.order.total }
        val todayCount = todayOrders.size
        val averageTicket = if (todayCount > 0) todayRevenue / todayCount else 0.0

        val yesterdayRevenue = yesterdayOrders.sumOf { it.order.total }
        val yesterdayCount = yesterdayOrders.size

        val revenueChange = percentChange(yesterdayRevenue, todayRevenue)
        val orderCountChange = percentChange(yesterdayCount.toDouble(), todayCount.toDouble())

        // Producto más vendido del día (por cantidad total)
        val topProduct = todayOrders
            .flatMap { it.order.items }
            .groupBy { it.name.ifBlank { it.productName } }
            .mapValues { (_, items) -> items.sumOf { it.quantity } }
            .maxByOrNull { it.value }

        logger.info(
            "Métricas del día para {}: pedidos={}, monto={}, ticket promedio={}, top producto={}",
            business, todayCount, todayRevenue, averageTicket, topProduct?.key
        )

        return DailySalesMetricsResponse(
            orderCount = todayCount,
            totalRevenue = todayRevenue,
            averageTicket = averageTicket,
            previousDayOrderCount = yesterdayCount,
            previousDayRevenue = yesterdayRevenue,
            revenueChangePercent = revenueChange,
            orderCountChangePercent = orderCountChange,
            topProductName = topProduct?.key,
            topProductQuantity = topProduct?.value ?: 0
        )
    }

    private fun isOnDate(isoTimestamp: String, date: LocalDate, zoneId: ZoneId): Boolean {
        return try {
            val instant = Instant.parse(isoTimestamp)
            val orderDate = instant.atZone(zoneId).toLocalDate()
            orderDate == date
        } catch (e: Exception) {
            logger.warn("No se pudo parsear timestamp: {}", isoTimestamp)
            false
        }
    }

    private fun percentChange(previous: Double, current: Double): Double {
        if (previous == 0.0) return if (current > 0.0) 100.0 else 0.0
        return ((current - previous) / previous) * 100.0
    }
}
