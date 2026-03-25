package asdo.delivery

import ext.delivery.toDeliveryException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.delivery.DeliveryNotificationStore

class DoGetDeliveryNotifications : ToDoGetDeliveryNotifications {

    private val logger = LoggerFactory.default.newLogger<DoGetDeliveryNotifications>()

    override suspend fun execute(): Result<List<DeliveryNotification>> = runCatching {
        logger.info { "Obteniendo notificaciones de delivery" }
        DeliveryNotificationStore.notifications.value
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al obtener notificaciones de delivery" }
        throw throwable.toDeliveryException()
    }
}

class DoMarkDeliveryNotificationRead : ToDoMarkDeliveryNotificationRead {

    private val logger = LoggerFactory.default.newLogger<DoMarkDeliveryNotificationRead>()

    override suspend fun execute(notificationId: String): Result<Unit> = runCatching {
        logger.info { "Marcando notificacion delivery $notificationId como leida" }
        DeliveryNotificationStore.markAsRead(notificationId)
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al marcar notificacion delivery $notificationId como leida" }
        throw throwable.toDeliveryException()
    }
}

class DoMarkAllDeliveryNotificationsRead : ToDoMarkAllDeliveryNotificationsRead {

    private val logger = LoggerFactory.default.newLogger<DoMarkAllDeliveryNotificationsRead>()

    override suspend fun execute(): Result<Unit> = runCatching {
        logger.info { "Marcando todas las notificaciones delivery como leidas" }
        DeliveryNotificationStore.markAllAsRead()
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al marcar todas las notificaciones delivery como leidas" }
        throw throwable.toDeliveryException()
    }
}
