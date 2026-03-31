package ar.com.intrale.shared.business

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class DailySalesMetricsDTO(
    @SerialName("orderCount")
    val orderCount: Int = 0,
    @SerialName("totalRevenue")
    val totalRevenue: Double = 0.0,
    @SerialName("averageTicket")
    val averageTicket: Double = 0.0,
    @SerialName("previousDayOrderCount")
    val previousDayOrderCount: Int = 0,
    @SerialName("previousDayRevenue")
    val previousDayRevenue: Double = 0.0,
    @SerialName("revenueChangePercent")
    val revenueChangePercent: Double = 0.0,
    @SerialName("orderCountChangePercent")
    val orderCountChangePercent: Double = 0.0,
    @SerialName("topProductName")
    val topProductName: String? = null,
    @SerialName("topProductQuantity")
    val topProductQuantity: Int = 0
)

@Serializable
data class DailySalesMetricsResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val metrics: DailySalesMetricsDTO? = null
)
