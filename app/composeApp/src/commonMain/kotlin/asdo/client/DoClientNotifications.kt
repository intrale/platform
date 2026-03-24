package asdo.client

import ext.client.CommClientNotificationsService
import ext.client.toClientException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DoGetClientNotifications(
    private val service: CommClientNotificationsService
) : ToDoGetClientNotifications {

    private val logger = LoggerFactory.default.newLogger<DoGetClientNotifications>()

    override suspend fun execute(): Result<List<ClientNotification>> = runCatching {
        logger.info { "Obteniendo notificaciones del cliente" }
        service.listNotifications().getOrThrow()
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al obtener notificaciones del cliente" }
        throw throwable.toClientException()
    }
}

class DoMarkNotificationRead(
    private val service: CommClientNotificationsService
) : ToDoMarkNotificationRead {

    private val logger = LoggerFactory.default.newLogger<DoMarkNotificationRead>()

    override suspend fun execute(notificationId: String): Result<Unit> = runCatching {
        logger.info { "Marcando notificacion $notificationId como leida" }
        service.markAsRead(notificationId).getOrThrow()
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al marcar notificacion $notificationId como leida" }
        throw throwable.toClientException()
    }
}

class DoMarkAllNotificationsRead(
    private val service: CommClientNotificationsService
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
