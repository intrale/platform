package ext.client

import asdo.client.ClientNotification
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class LocalClientNotificationsService : CommClientNotificationsService {

    private val logger = LoggerFactory.default.newLogger<LocalClientNotificationsService>()

    override suspend fun listNotifications(): Result<List<ClientNotification>> = runCatching {
        logger.info { "Obteniendo notificaciones locales" }
        ClientNotificationsLocalStore.notifications.value
    }

    override suspend fun markAsRead(notificationId: String): Result<Unit> = runCatching {
        logger.info { "Marcando notificacion $notificationId como leida" }
        ClientNotificationsLocalStore.markAsRead(notificationId)
    }

    override suspend fun markAllAsRead(): Result<Unit> = runCatching {
        logger.info { "Marcando todas las notificaciones como leidas" }
        ClientNotificationsLocalStore.markAllAsRead()
    }
}
