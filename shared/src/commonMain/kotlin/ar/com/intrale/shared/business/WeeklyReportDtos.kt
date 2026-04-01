package ar.com.intrale.shared.business

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Configuracion de reportes semanales del negocio.
 */
@Serializable
data class WeeklyReportConfigDTO(
    @SerialName("enabled")
    val enabled: Boolean = false,
    @SerialName("contactType")
    val contactType: String? = null,
    @SerialName("contactId")
    val contactId: String? = null
)

@Serializable
data class WeeklyReportConfigResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val config: WeeklyReportConfigDTO? = null
)

/**
 * Resumen del producto mas vendido.
 */
@Serializable
data class TopProductDTO(
    @SerialName("name")
    val name: String = "",
    @SerialName("quantity")
    val quantity: Int = 0,
    @SerialName("revenue")
    val revenue: Double = 0.0
)

/**
 * Metricas semanales del negocio.
 */
@Serializable
data class WeeklyMetricsDTO(
    @SerialName("totalRevenue")
    val totalRevenue: Double = 0.0,
    @SerialName("orderCount")
    val orderCount: Int = 0,
    @SerialName("averageTicket")
    val averageTicket: Double = 0.0,
    @SerialName("previousWeekRevenue")
    val previousWeekRevenue: Double = 0.0,
    @SerialName("previousWeekOrderCount")
    val previousWeekOrderCount: Int = 0,
    @SerialName("revenueChangePercent")
    val revenueChangePercent: Double = 0.0,
    @SerialName("orderCountChangePercent")
    val orderCountChangePercent: Double = 0.0,
    @SerialName("topProducts")
    val topProducts: List<TopProductDTO> = emptyList()
)

@Serializable
data class WeeklyReportResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val metrics: WeeklyMetricsDTO? = null,
    @SerialName("reportText")
    val reportText: String? = null,
    @SerialName("sent")
    val sent: Boolean = false,
    @SerialName("sentTo")
    val sentTo: String? = null
)
