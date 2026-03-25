package asdo.delivery

enum class DeliveryNotificationEventType {
    ORDER_AVAILABLE,
    ORDER_ASSIGNED,
    ORDER_DELIVERED,
    ORDER_NOT_DELIVERED
}

data class DeliveryNotification(
    val id: String,
    val orderId: String,
    val label: String,
    val businessName: String,
    val eventType: DeliveryNotificationEventType,
    val timestamp: String,
    val isRead: Boolean = false
)

fun DeliveryOrderStatus.toNotificationEventType(): DeliveryNotificationEventType = when (this) {
    DeliveryOrderStatus.PENDING -> DeliveryNotificationEventType.ORDER_AVAILABLE
    DeliveryOrderStatus.IN_PROGRESS -> DeliveryNotificationEventType.ORDER_ASSIGNED
    DeliveryOrderStatus.DELIVERED -> DeliveryNotificationEventType.ORDER_DELIVERED
    DeliveryOrderStatus.NOT_DELIVERED -> DeliveryNotificationEventType.ORDER_NOT_DELIVERED
    DeliveryOrderStatus.UNKNOWN -> DeliveryNotificationEventType.ORDER_AVAILABLE
}
