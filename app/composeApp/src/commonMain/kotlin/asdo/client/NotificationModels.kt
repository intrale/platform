package asdo.client

enum class NotificationType {
    ORDER_CREATED,
    ORDER_STATUS_CHANGED,
    ORDER_CANCELLED,
    BUSINESS_MESSAGE
}

data class ClientNotification(
    val id: String,
    val type: NotificationType,
    val title: String,
    val body: String,
    val isRead: Boolean = false,
    val timestamp: String,
    val orderId: String? = null
)
