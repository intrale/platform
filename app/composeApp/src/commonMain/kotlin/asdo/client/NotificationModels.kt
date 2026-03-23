package asdo.client

enum class NotificationType {
    ORDER_CREATED,
    STATUS_CHANGED,
    ORDER_CANCELLED,
    BUSINESS_MESSAGE
}

data class NotificationItem(
    val id: String,
    val type: NotificationType,
    val title: String,
    val message: String,
    val orderId: String? = null,
    val shortCode: String? = null,
    val businessName: String,
    val createdAt: String,
    val isRead: Boolean = false
)
