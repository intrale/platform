package asdo.client

import ext.client.CommNotificationService
import ext.client.toClientException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DoGetNotifications(
    private val service: CommNotificationService
) : ToDoGetNotifications {

    private val logger = LoggerFactory.default.newLogger<DoGetNotifications>()

    override suspend fun execute(): Result<List<ClientNotification>> = runCatching {
        logger.info { "Obteniendo notificaciones del cliente" }
        service.listNotifications().getOrThrow()
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al obtener notificaciones" }
        throw throwable.toClientException()
    }
}

class DoMarkNotificationAsRead(
    private val service: CommNotificationService
) : ToDoMarkNotificationAsRead {

    private val logger = LoggerFactory.default.newLogger<DoMarkNotificationAsRead>()

    override suspend fun execute(notificationId: String): Result<Unit> = runCatching {
        logger.info { "Marcando notificacion $notificationId como leida" }
        service.markAsRead(notificationId).getOrThrow()
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al marcar notificacion como leida" }
        throw throwable.toClientException()
    }
}

class DoMarkAllNotificationsAsRead(
    private val service: CommNotificationService
) : ToDoMarkAllNotificationsAsRead {

    private val logger = LoggerFactory.default.newLogger<DoMarkAllNotificationsAsRead>()

    override suspend fun execute(): Result<Unit> = runCatching {
        logger.info { "Marcando todas las notificaciones como leidas" }
        service.markAllAsRead().getOrThrow()
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al marcar todas las notificaciones como leidas" }
        throw throwable.toClientException()
    }
}
