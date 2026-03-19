package asdo.business

import ar.com.intrale.shared.business.BusinessOrderDTO
import ar.com.intrale.shared.business.BusinessOrderDetailDTO
import ar.com.intrale.shared.business.BusinessOrderItemDTO as SharedBusinessOrderItemDTO
import ar.com.intrale.shared.business.BusinessOrderStatusEventDTO as SharedBusinessOrderStatusEventDTO

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

data class BusinessOrderDetail(
    val id: String,
    val shortCode: String,
    val clientEmail: String,
    val clientName: String?,
    val status: BusinessOrderStatus,
    val total: Double,
    val items: List<BusinessOrderItem>,
    val deliveryAddress: String?,
    val deliveryCity: String?,
    val deliveryReference: String?,
    val statusHistory: List<BusinessOrderStatusEvent>,
    val createdAt: String,
    val updatedAt: String?
)

data class BusinessOrderItem(
    val id: String?,
    val name: String,
    val quantity: Int,
    val unitPrice: Double,
    val subtotal: Double
)

data class BusinessOrderStatusEvent(
    val status: BusinessOrderStatus,
    val timestamp: String,
    val message: String?
)

data class BusinessOrderStatusUpdateResult(
    val orderId: String,
    val newStatus: BusinessOrderStatus,
    val updatedAt: String
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
fun BusinessOrderDetailDTO.toDomain(): BusinessOrderDetail = BusinessOrderDetail(
    id = id,
    shortCode = shortCode ?: id.take(6).uppercase(),
    clientEmail = clientEmail,
    clientName = clientName,
    status = status.toBusinessOrderStatus(),
    total = total,
    items = items.map { it.toDomain() },
    deliveryAddress = deliveryAddress,
    deliveryCity = deliveryCity,
    deliveryReference = deliveryReference,
    statusHistory = statusHistory.map { it.toDomain() },
    createdAt = createdAt ?: "",
    updatedAt = updatedAt
)

fun SharedBusinessOrderItemDTO.toDomain(): BusinessOrderItem = BusinessOrderItem(
    id = id,
    name = name,
    quantity = quantity,
    unitPrice = unitPrice,
    subtotal = subtotal
)

fun SharedBusinessOrderStatusEventDTO.toDomain(): BusinessOrderStatusEvent = BusinessOrderStatusEvent(
    status = status.toBusinessOrderStatus(),
    timestamp = timestamp,
    message = message
)

/** Transiciones de estado validas para el negocio */
fun BusinessOrderStatus.validTransitions(): List<BusinessOrderStatus> = when (this) {
    BusinessOrderStatus.PENDING -> listOf(BusinessOrderStatus.PREPARING, BusinessOrderStatus.CANCELLED)
    BusinessOrderStatus.PREPARING -> listOf(BusinessOrderStatus.DELIVERING, BusinessOrderStatus.CANCELLED)
    BusinessOrderStatus.DELIVERING -> listOf(BusinessOrderStatus.DELIVERED)
    else -> emptyList()
}
