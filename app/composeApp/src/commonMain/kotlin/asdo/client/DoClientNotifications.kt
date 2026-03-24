package asdo.client

import ext.client.toClientException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.client.ClientNotificationStore

class DoGetNotifications : ToDoGetNotifications {

    private val logger = LoggerFactory.default.newLogger<DoGetNotifications>()

    override suspend fun execute(): Result<List<ClientNotification>> = runCatching {
        logger.info { "Obteniendo notificaciones del cliente" }
        ClientNotificationStore.notifications.value
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al obtener notificaciones" }
        throw throwable.toClientException()
    }
}

class DoMarkNotificationRead : ToDoMarkNotificationRead {

    private val logger = LoggerFactory.default.newLogger<DoMarkNotificationRead>()

    override suspend fun execute(notificationId: String): Result<Unit> = runCatching {
        logger.info { "Marcando notificacion $notificationId como leida" }
        ClientNotificationStore.markAsRead(notificationId)
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al marcar notificacion $notificationId como leida" }
        throw throwable.toClientException()
    }
}

class DoMarkAllNotificationsRead : ToDoMarkAllNotificationsRead {

    private val logger = LoggerFactory.default.newLogger<DoMarkAllNotificationsRead>()

    override suspend fun execute(): Result<Unit> = runCatching {
        logger.info { "Marcando todas las notificaciones como leidas" }
        ClientNotificationStore.markAllAsRead()
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al marcar todas las notificaciones como leidas" }
        throw throwable.toClientException()
    }
}
