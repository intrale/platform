package asdo.client

import ext.client.CommNotificationsService
import ext.client.toClientException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DoGetNotifications(
    private val service: CommNotificationsService
) : ToDoGetNotifications {

    private val logger = LoggerFactory.default.newLogger<DoGetNotifications>()

    override suspend fun execute(): Result<List<NotificationItem>> = runCatching {
        logger.info { "Obteniendo notificaciones" }
        service.getNotifications().getOrThrow()
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al obtener notificaciones" }
        throw throwable.toClientException()
    }
}

class DoMarkNotificationRead(
    private val service: CommNotificationsService
) : ToDoMarkNotificationRead {

    private val logger = LoggerFactory.default.newLogger<DoMarkNotificationRead>()

    override suspend fun execute(notificationId: String): Result<Unit> = runCatching {
        logger.info { "Marcando notificacion $notificationId como leida" }
        service.markAsRead(notificationId).getOrThrow()
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al marcar notificacion como leida" }
        throw throwable.toClientException()
    }
}

class DoMarkAllNotificationsRead(
    private val service: CommNotificationsService
) : ToDoMarkAllNotificationsRead {

    private val logger = LoggerFactory.default.newLogger<DoMarkAllNotificationsRead>()

    override suspend fun execute(): Result<Unit> = runCatching {
        logger.info { "Marcando todas las notificaciones como leidas" }
        service.markAllAsRead().getOrThrow()
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al marcar todas las notificaciones como leidas" }
        throw throwable.toClientException()
    }
}
