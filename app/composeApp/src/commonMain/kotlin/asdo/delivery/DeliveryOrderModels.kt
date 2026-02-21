package asdo.delivery

import ext.delivery.DeliveryOrderDTO
import ext.delivery.DeliveryOrderDetailDTO
import ext.delivery.DeliveryOrderItemDTO
import ext.delivery.DeliveryOrderStatusUpdateResponse
import ext.delivery.DeliveryOrdersSummaryDTO

enum class DeliveryOrderStatus {
    PENDING, IN_PROGRESS, DELIVERED, UNKNOWN
}

data class DeliveryOrder(
    val id: String,
    val label: String,
    val businessName: String,
    val neighborhood: String,
    val status: DeliveryOrderStatus,
    val eta: String?
)

data class DeliveryOrdersSummary(
    val pending: Int = 0,
    val inProgress: Int = 0,
    val delivered: Int = 0
)

data class DeliveryOrderDetail(
    val id: String,
    val label: String,
    val businessName: String,
    val neighborhood: String,
    val status: DeliveryOrderStatus,
    val eta: String?,
    val distance: String?,
    val address: String?,
    val addressNotes: String?,
    val items: List<DeliveryOrderItem>,
    val notes: String?,
    val customerName: String?,
    val customerPhone: String?,
    val createdAt: String?,
    val updatedAt: String?
)

data class DeliveryOrderItem(
    val name: String,
    val quantity: Int,
    val notes: String?
)

data class DeliveryOrderStatusUpdateResult(
    val orderId: String,
    val newStatus: DeliveryOrderStatus
)

fun DeliveryOrderDTO.toDomain(): DeliveryOrder = DeliveryOrder(
    id = id,
    label = publicId ?: shortCode ?: id,
    businessName = businessName,
    neighborhood = neighborhood,
    status = status.toDeliveryOrderStatus(),
    eta = eta ?: promisedAt
)

fun DeliveryOrderDetailDTO.toDomain(): DeliveryOrderDetail = DeliveryOrderDetail(
    id = id,
    label = publicId ?: shortCode ?: id,
    businessName = businessName,
    neighborhood = neighborhood,
    status = status.toDeliveryOrderStatus(),
    eta = eta ?: promisedAt,
    distance = distance,
    address = address,
    addressNotes = addressNotes,
    items = items.map { it.toDomain() },
    notes = notes,
    customerName = customerName,
    customerPhone = customerPhone,
    createdAt = createdAt,
    updatedAt = updatedAt
)

fun DeliveryOrderItemDTO.toDomain(): DeliveryOrderItem = DeliveryOrderItem(
    name = name,
    quantity = quantity,
    notes = notes
)

fun DeliveryOrdersSummaryDTO.toDomain(): DeliveryOrdersSummary = DeliveryOrdersSummary(
    pending = pending,
    inProgress = inProgress,
    delivered = delivered
)

fun String.toDeliveryOrderStatus(): DeliveryOrderStatus = when (this.lowercase()) {
    "pending" -> DeliveryOrderStatus.PENDING
    "inprogress", "in_progress", "assigned" -> DeliveryOrderStatus.IN_PROGRESS
    "delivered" -> DeliveryOrderStatus.DELIVERED
    else -> DeliveryOrderStatus.UNKNOWN
}

fun DeliveryOrderStatus.toApiString(): String = when (this) {
    DeliveryOrderStatus.PENDING -> "pending"
    DeliveryOrderStatus.IN_PROGRESS -> "inprogress"
    DeliveryOrderStatus.DELIVERED -> "delivered"
    DeliveryOrderStatus.UNKNOWN -> "unknown"
}

fun DeliveryOrderStatusUpdateResponse.toDomain(): DeliveryOrderStatusUpdateResult =
    DeliveryOrderStatusUpdateResult(
        orderId = orderId,
        newStatus = status.toDeliveryOrderStatus()
    )
