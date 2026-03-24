package ext.client

import asdo.client.ClientNotification
import asdo.client.NotificationType
import kotlinx.serialization.Serializable

@Serializable
data class ClientNotificationDTO(
    val id: String = "",
    val type: String = "UNKNOWN",
    val title: String = "",
    val message: String = "",
    val isRead: Boolean = false,
    val createdAt: String = "",
    val orderId: String? = null
)

fun ClientNotificationDTO.toDomain(): ClientNotification = ClientNotification(
    id = id,
    type = runCatching { NotificationType.valueOf(type) }.getOrElse { NotificationType.UNKNOWN },
    title = title,
    message = message,
    isRead = isRead,
    createdAt = createdAt,
    orderId = orderId
)
