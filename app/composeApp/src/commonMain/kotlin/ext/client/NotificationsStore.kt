package ext.client

import asdo.client.NotificationItem
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * Store local de notificaciones. Actúa como fuente de verdad in-memory hasta que
 * se integre la capa de notificaciones push del backend.
 */
object NotificationsStore {

    private val _notifications = MutableStateFlow<List<NotificationItem>>(emptyList())
    val notifications: StateFlow<List<NotificationItem>> = _notifications.asStateFlow()

    fun add(notification: NotificationItem) {
        _notifications.update { current ->
            // Evita duplicados por id
            if (current.any { it.id == notification.id }) current
            else listOf(notification) + current
        }
    }

    fun markAsRead(notificationId: String) {
        _notifications.update { current ->
            current.map { if (it.id == notificationId) it.copy(isRead = true) else it }
        }
    }

    fun markAllAsRead() {
        _notifications.update { current -> current.map { it.copy(isRead = true) } }
    }

    fun unreadCount(): Int = _notifications.value.count { !it.isRead }

    fun clear() {
        _notifications.value = emptyList()
    }
}
