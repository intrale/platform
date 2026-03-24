package asdo.client

enum class NotificationEventType {
    ORDER_CREATED,
    ORDER_CONFIRMED,
    ORDER_PREPARING,
    ORDER_READY,
    ORDER_DELIVERING,
    ORDER_DELIVERED,
    ORDER_CANCELLED,
    BUSINESS_MESSAGE
}

data class ClientNotification(
    val id: String,
    val orderId: String,
    val shortCode: String,
    val businessName: String,
    val eventType: NotificationEventType,
    val message: String,
    val timestamp: String,
    val isRead: Boolean = false
)

fun ClientOrderStatus.toNotificationEventType(): NotificationEventType = when (this) {
    ClientOrderStatus.PENDING -> NotificationEventType.ORDER_CREATED
    ClientOrderStatus.CONFIRMED -> NotificationEventType.ORDER_CONFIRMED
    ClientOrderStatus.PREPARING -> NotificationEventType.ORDER_PREPARING
    ClientOrderStatus.READY -> NotificationEventType.ORDER_READY
    ClientOrderStatus.DELIVERING -> NotificationEventType.ORDER_DELIVERING
    ClientOrderStatus.DELIVERED -> NotificationEventType.ORDER_DELIVERED
    ClientOrderStatus.CANCELLED -> NotificationEventType.ORDER_CANCELLED
    ClientOrderStatus.UNKNOWN -> NotificationEventType.ORDER_CREATED
}
