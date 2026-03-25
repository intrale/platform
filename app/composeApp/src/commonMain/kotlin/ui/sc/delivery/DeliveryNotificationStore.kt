package ui.sc.delivery

import asdo.delivery.DeliveryNotification
import asdo.delivery.DeliveryOrder
import asdo.delivery.DeliveryNotificationEventType
import asdo.delivery.toNotificationEventType
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

object DeliveryNotificationStore {

    private val _notifications = MutableStateFlow<List<DeliveryNotification>>(emptyList())
    val notifications: StateFlow<List<DeliveryNotification>> = _notifications.asStateFlow()

    val unreadCount: Int
        get() = _notifications.value.count { !it.isRead }

    fun updateFromOrders(orders: List<DeliveryOrder>) {
        val existing = _notifications.value.associateBy { it.id }.toMutableMap()
        orders.forEach { order ->
            val notifId = "${order.id}_${order.status.name}"
            if (!existing.containsKey(notifId)) {
                existing[notifId] = DeliveryNotification(
                    id = notifId,
                    orderId = order.id,
                    label = order.label,
                    businessName = order.businessName,
                    eventType = order.status.toNotificationEventType(),
                    timestamp = "",
                    isRead = false
                )
            }
        }
        _notifications.value = existing.values
            .sortedByDescending { it.timestamp }
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
        _notifications.value = emptyList()
    }
}
