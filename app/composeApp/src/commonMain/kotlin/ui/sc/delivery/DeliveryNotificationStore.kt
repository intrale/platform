package ui.sc.delivery

import asdo.delivery.DeliveryNotification
import asdo.delivery.DeliveryOrder
import asdo.delivery.DeliveryNotificationEventType
import asdo.delivery.toNotificationEventType
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

object DeliveryNotificationStore {

    private val logger = LoggerFactory.default.newLogger<DeliveryNotificationStore>()

    private val _notifications = MutableStateFlow<List<DeliveryNotification>>(emptyList())
    val notifications: StateFlow<List<DeliveryNotification>> = _notifications.asStateFlow()

    fun updateFromOrders(orders: List<DeliveryOrder>) {
        logger.info { "Actualizando notificaciones desde ${orders.size} pedidos" }
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
        _notifications.value = existing.values.toList()
    }

    fun markAsRead(id: String) {
        logger.info { "Marcando notificacion $id como leida" }
        _notifications.update { current ->
            current.map { if (it.id == id) it.copy(isRead = true) else it }
        }
    }

    fun markAllAsRead() {
        logger.info { "Marcando todas las notificaciones como leidas" }
        _notifications.update { current ->
            current.map { it.copy(isRead = true) }
        }
    }

    fun clear() {
        logger.info { "Limpiando notificaciones" }
        _notifications.value = emptyList()
    }
}
