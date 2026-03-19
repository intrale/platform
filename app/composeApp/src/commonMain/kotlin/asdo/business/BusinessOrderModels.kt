package asdo.business

import ar.com.intrale.shared.business.BusinessOrderDTO

enum class BusinessOrderStatus {
    PENDING, CONFIRMED, PREPARING, READY, DELIVERING, DELIVERED, CANCELLED, UNKNOWN
}

enum class BusinessOrderDateFilter {
    ALL, TODAY, LAST_7_DAYS
}

data class BusinessOrder(
    val id: String,
    val shortCode: String,
    val clientEmail: String,
    val status: BusinessOrderStatus,
    val total: Double,
    val assignedDeliveryPersonEmail: String? = null,
    val createdAt: String
)

fun String.toBusinessOrderStatus(): BusinessOrderStatus = when (this.uppercase()) {
    "PENDING" -> BusinessOrderStatus.PENDING
    "CONFIRMED" -> BusinessOrderStatus.CONFIRMED
    "PREPARING" -> BusinessOrderStatus.PREPARING
    "READY" -> BusinessOrderStatus.READY
    "DELIVERING" -> BusinessOrderStatus.DELIVERING
    "DELIVERED" -> BusinessOrderStatus.DELIVERED
    "CANCELLED" -> BusinessOrderStatus.CANCELLED
    else -> BusinessOrderStatus.UNKNOWN
}

fun BusinessOrderDTO.toDomain(): BusinessOrder = BusinessOrder(
    id = id,
    shortCode = shortCode ?: id.take(6).uppercase(),
    clientEmail = clientEmail,
    status = status.toBusinessOrderStatus(),
    total = total,
    assignedDeliveryPersonEmail = assignedDeliveryPersonEmail,
    createdAt = createdAt ?: ""
)

data class DeliveryPersonSummary(
    val email: String,
    val fullName: String
)
