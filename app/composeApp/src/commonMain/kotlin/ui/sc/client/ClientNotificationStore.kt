package ui.sc.client

import asdo.client.ClientNotification
import asdo.client.ClientOrder
import asdo.client.NotificationEventType
import asdo.client.toNotificationEventType
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

object ClientNotificationStore {

    private val _notifications = MutableStateFlow<List<ClientNotification>>(emptyList())
    val notifications: StateFlow<List<ClientNotification>> = _notifications.asStateFlow()

    val unreadCount: Int
        get() = _notifications.value.count { !it.isRead }

    fun updateFromOrders(orders: List<ClientOrder>) {
        _notifications.update { current ->
            val existing = current.associateBy { it.id }.toMutableMap()
            orders.forEach { order ->
                val notifId = "${order.id}_${order.status.name}"
                if (!existing.containsKey(notifId)) {
                    existing[notifId] = ClientNotification(
                        id = notifId,
                        orderId = order.id,
                        shortCode = order.shortCode,
                        businessName = order.businessName,
                        eventType = order.status.toNotificationEventType(),
                        message = "",
                        timestamp = order.createdAt,
                        isRead = false
                    )
                }
            }
            existing.values.sortedByDescending { it.timestamp }
        }
    }

    fun addBusinessMessage(orderId: String, shortCode: String, businessName: String, message: String, timestamp: String) {
        val notifId = "${orderId}_BUSINESS_MESSAGE_${message.hashCode()}"
        _notifications.update { current ->
            if (current.any { it.id == notifId }) return@update current
            val newNotif = ClientNotification(
                id = notifId,
                orderId = orderId,
                shortCode = shortCode,
                businessName = businessName,
                eventType = NotificationEventType.BUSINESS_MESSAGE,
                message = message,
                timestamp = timestamp,
                isRead = false
            )
            (current + newNotif).sortedByDescending { it.timestamp }
        }
    }

    fun addFromPush(notification: ClientNotification) {
        _notifications.update { current ->
            if (current.any { it.id == notification.id }) return@update current
            (current + notification).sortedByDescending { it.timestamp }
        }
    }

    fun markAsRead(id: String) {
        _notifications.update { current ->
            current.map { if (it.id == id) it.copy(isRead = true) else it }
        }
    }

    fun markAllAsRead() {
        _notifications.update { current ->
            current.map { it.copy(isRead = true) }
        }
    }

    fun clear() {
        _notifications.update { emptyList() }
    }
}
