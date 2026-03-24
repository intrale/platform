package ext.client

import asdo.client.ClientNotification
import asdo.client.NotificationType
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

object ClientNotificationsLocalStore {

    private val _notifications = MutableStateFlow<List<ClientNotification>>(emptyList())
    val notifications: StateFlow<List<ClientNotification>> = _notifications.asStateFlow()

    fun add(notification: ClientNotification) {
        _notifications.update { current ->
            listOf(notification) + current
        }
    }

    fun addOrderCreated(orderId: String, shortCode: String, businessName: String) {
        add(
            ClientNotification(
                id = "order_created_$orderId",
                type = NotificationType.ORDER_CREATED,
                title = "Pedido creado",
                message = "Tu pedido #$shortCode en $businessName fue registrado correctamente.",
                isRead = false,
                createdAt = currentIsoTimestamp(),
                orderId = orderId
            )
        )
    }

    fun addOrderStatusChanged(orderId: String, shortCode: String, newStatus: String) {
        add(
            ClientNotification(
                id = "order_status_${orderId}_$newStatus",
                type = NotificationType.ORDER_STATUS_CHANGED,
                title = "Estado actualizado",
                message = "Tu pedido #$shortCode cambio de estado: $newStatus.",
                isRead = false,
                createdAt = currentIsoTimestamp(),
                orderId = orderId
            )
        )
    }

    fun addOrderCancelled(orderId: String, shortCode: String) {
        add(
            ClientNotification(
                id = "order_cancelled_$orderId",
                type = NotificationType.ORDER_CANCELLED,
                title = "Pedido cancelado",
                message = "Tu pedido #$shortCode fue cancelado.",
                isRead = false,
                createdAt = currentIsoTimestamp(),
                orderId = orderId
            )
        )
    }

    fun addBusinessMessage(message: String, businessName: String, orderId: String? = null) {
        val id = if (orderId != null) "business_msg_$orderId" else "business_msg_${currentIsoTimestamp()}"
        add(
            ClientNotification(
                id = id,
                type = NotificationType.BUSINESS_MESSAGE,
                title = "Mensaje de $businessName",
                message = message,
                isRead = false,
                createdAt = currentIsoTimestamp(),
                orderId = orderId
            )
        )
    }

    fun markAsRead(notificationId: String) {
        _notifications.update { current ->
            current.map { if (it.id == notificationId) it.copy(isRead = true) else it }
        }
    }

    fun markAllAsRead() {
        _notifications.update { current -> current.map { it.copy(isRead = true) } }
    }

    fun clear() {
        _notifications.value = emptyList()
    }

    private fun currentIsoTimestamp(): String {
        // Timestamp simple basado en milisegundos para compatibilidad KMP
        return kotlinx.datetime.Clock.System.now().toString()
    }
}
