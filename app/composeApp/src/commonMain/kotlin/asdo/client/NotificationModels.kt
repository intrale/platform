package asdo.client

enum class NotificationType {
    ORDER_CREATED,
    ORDER_STATUS_CHANGED,
    ORDER_CANCELLED,
    BUSINESS_MESSAGE,
    UNKNOWN
}

data class ClientNotification(
    val id: String,
    val type: NotificationType,
    val title: String,
    val message: String,
    val isRead: Boolean,
    val createdAt: String,
    val orderId: String? = null
)
