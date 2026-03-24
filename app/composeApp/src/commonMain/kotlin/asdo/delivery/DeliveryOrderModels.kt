package asdo.delivery

import ar.com.intrale.shared.delivery.DeliveryOrderDTO
import ar.com.intrale.shared.delivery.DeliveryOrderItemDTO
import ar.com.intrale.shared.delivery.DeliveryOrderStatusUpdateResponse
import ar.com.intrale.shared.delivery.DeliveryOrdersSummaryDTO
import ar.com.intrale.shared.delivery.DeliveryStatusHistoryEntryDTO

enum class DeliveryOrderStatus {
    ASSIGNED, HEADING_TO_BUSINESS, AT_BUSINESS, HEADING_TO_CLIENT,
    DELIVERED, NOT_DELIVERED, UNKNOWN;

    fun nextStatus(): DeliveryOrderStatus? = when (this) {
        ASSIGNED -> HEADING_TO_BUSINESS
        HEADING_TO_BUSINESS -> AT_BUSINESS
        AT_BUSINESS -> HEADING_TO_CLIENT
        HEADING_TO_CLIENT -> DELIVERED
        DELIVERED, NOT_DELIVERED, UNKNOWN -> null
    }

    fun canAdvance(): Boolean = nextStatus() != null

    fun canMarkNotDelivered(): Boolean = this != DELIVERED && this != NOT_DELIVERED && this != UNKNOWN

    fun isFinal(): Boolean = this == DELIVERED || this == NOT_DELIVERED

    fun stepIndex(): Int = when (this) {
        ASSIGNED -> 0
        HEADING_TO_BUSINESS -> 1
        AT_BUSINESS -> 2
        HEADING_TO_CLIENT -> 3
        DELIVERED -> 4
        NOT_DELIVERED -> 5
        UNKNOWN -> -1
    }

    companion object {
        val DELIVERY_SEQUENCE = listOf(
            ASSIGNED, HEADING_TO_BUSINESS, AT_BUSINESS, HEADING_TO_CLIENT, DELIVERED
        )
    }
}

data class DeliveryStatusHistoryEntry(
    val status: DeliveryOrderStatus,
    val timestamp: String,
    val reason: String? = null
)

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
    val paymentMethod: String?,
    val collectOnDelivery: Boolean?,
    val createdAt: String?,
    val updatedAt: String?,
    val statusHistory: List<DeliveryStatusHistoryEntry> = emptyList()
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

fun DeliveryOrderDTO.toDetailDomain(): DeliveryOrderDetail = DeliveryOrderDetail(
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
    paymentMethod = paymentMethod,
    collectOnDelivery = collectOnDelivery,
    createdAt = createdAt,
    updatedAt = updatedAt,
    statusHistory = statusHistory?.map { entry ->
        DeliveryStatusHistoryEntry(
            status = entry.status.toDeliveryOrderStatus(),
            timestamp = entry.timestamp,
            reason = entry.reason
        )
    } ?: emptyList()
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
    "assigned", "pending" -> DeliveryOrderStatus.ASSIGNED
    "heading_to_business" -> DeliveryOrderStatus.HEADING_TO_BUSINESS
    "at_business", "picked_up" -> DeliveryOrderStatus.AT_BUSINESS
    "heading_to_client", "in_transit", "inprogress", "in_progress" -> DeliveryOrderStatus.HEADING_TO_CLIENT
    "delivered" -> DeliveryOrderStatus.DELIVERED
    "not_delivered", "notdelivered", "cancelled" -> DeliveryOrderStatus.NOT_DELIVERED
    else -> DeliveryOrderStatus.UNKNOWN
}

fun DeliveryOrderStatus.toApiString(): String = when (this) {
    DeliveryOrderStatus.ASSIGNED -> "assigned"
    DeliveryOrderStatus.HEADING_TO_BUSINESS -> "heading_to_business"
    DeliveryOrderStatus.AT_BUSINESS -> "at_business"
    DeliveryOrderStatus.HEADING_TO_CLIENT -> "heading_to_client"
    DeliveryOrderStatus.DELIVERED -> "delivered"
    DeliveryOrderStatus.NOT_DELIVERED -> "not_delivered"
    DeliveryOrderStatus.UNKNOWN -> "unknown"
}

fun DeliveryOrderStatusUpdateResponse.toDomain(): DeliveryOrderStatusUpdateResult =
    DeliveryOrderStatusUpdateResult(
        orderId = orderId,
        newStatus = status.toDeliveryOrderStatus()
    )
