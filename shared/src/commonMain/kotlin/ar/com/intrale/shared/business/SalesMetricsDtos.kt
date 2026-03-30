package ar.com.intrale.shared.business

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Métricas de ventas del día para el panel del negocio.
 */
@Serializable
data class DailySalesMetricsDTO(
    /** Cantidad de pedidos completados del día */
    @SerialName("orderCount")
    val orderCount: Int = 0,

    /** Monto total facturado del día */
    @SerialName("totalRevenue")
    val totalRevenue: Double = 0.0,

    /** Ticket promedio (totalRevenue / orderCount) */
    @SerialName("averageTicket")
    val averageTicket: Double = 0.0,

    /** Cantidad de pedidos del día anterior */
    @SerialName("previousDayOrderCount")
    val previousDayOrderCount: Int = 0,

    /** Monto total facturado del día anterior */
    @SerialName("previousDayRevenue")
    val previousDayRevenue: Double = 0.0,

    /** Variación porcentual del monto vs día anterior (positivo = sube, negativo = baja) */
    @SerialName("revenueChangePercent")
    val revenueChangePercent: Double = 0.0,

    /** Variación porcentual de pedidos vs día anterior */
    @SerialName("orderCountChangePercent")
    val orderCountChangePercent: Double = 0.0,

    /** Producto más vendido del día (nombre) */
    @SerialName("topProductName")
    val topProductName: String? = null,

    /** Cantidad vendida del producto más vendido */
    @SerialName("topProductQuantity")
    val topProductQuantity: Int = 0
)

@Serializable
data class DailySalesMetricsResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val metrics: DailySalesMetricsDTO? = null
)
