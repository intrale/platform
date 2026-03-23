package ext.client

import asdo.client.ClientNotification
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

/**
 * Implementacion local (placeholder) del servicio de notificaciones.
 * Almacena las notificaciones en memoria hasta que se integre con el backend de push.
 */
class NotificationService : CommNotificationService {

    private val logger = LoggerFactory.default.newLogger<NotificationService>()

    private val _notifications = MutableStateFlow<List<ClientNotification>>(emptyList())

    override suspend fun listNotifications(): Result<List<ClientNotification>> {
        logger.info { "Listando notificaciones (placeholder local)" }
        return Result.success(_notifications.value)
    }

    override suspend fun markAsRead(notificationId: String): Result<Unit> {
        logger.info { "Marcando notificacion $notificationId como leida" }
        _notifications.update { list ->
            list.map { if (it.id == notificationId) it.copy(isRead = true) else it }
        }
        return Result.success(Unit)
    }

    override suspend fun markAllAsRead(): Result<Unit> {
        logger.info { "Marcando todas las notificaciones como leidas" }
        _notifications.update { list -> list.map { it.copy(isRead = true) } }
        return Result.success(Unit)
    }

    /**
     * Registra un nuevo evento como notificacion.
     * Llamar desde flujos de pedidos (creacion, cambio de estado, cancelacion, mensaje del negocio).
     */
    override suspend fun addNotification(notification: ClientNotification): Result<Unit> {
        logger.info { "Agregando notificacion: ${notification.type} - ${notification.title}" }
        _notifications.update { list -> listOf(notification) + list }
        return Result.success(Unit)
    }
}
