package ext.dto

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class BusinessDashboardSummaryDTO(
    @SerialName("productsCount")
    val productsCount: Int = 0,
    @SerialName("pendingOrders")
    val pendingOrders: Int = 0,
    @SerialName("activeDrivers")
    val activeDrivers: Int = 0
)
