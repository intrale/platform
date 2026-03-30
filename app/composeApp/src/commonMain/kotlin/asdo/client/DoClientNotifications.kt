package asdo.client

import ext.client.toClientException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.client.ClientNotificationStore
import ui.sc.client.ClientPushPreferencesStore

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

class DoGetPushPreferences(
    private val profileService: ext.client.CommClientProfileService
) : ToDoGetPushPreferences {

    private val logger = LoggerFactory.default.newLogger<DoGetPushPreferences>()

    override suspend fun execute(): Result<ClientPreferences> = runCatching {
        logger.info { "Obteniendo preferencias de notificaciones push" }
        ClientPushPreferencesStore.preferences.value.let { state ->
            ClientPreferences(
                pushNotificationsEnabled = state.enabled,
                pushOrderConfirmed = state.orderConfirmed,
                pushOrderDelivering = state.orderDelivering,
                pushOrderNearby = state.orderNearby,
                pushOrderDelivered = state.orderDelivered
            )
        }
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al obtener preferencias push" }
        throw throwable.toClientException()
    }
}

class DoUpdatePushPreferences(
    private val profileService: ext.client.CommClientProfileService
) : ToDoUpdatePushPreferences {

    private val logger = LoggerFactory.default.newLogger<DoUpdatePushPreferences>()

    override suspend fun execute(preferences: ClientPreferences): Result<ClientPreferences> = runCatching {
        logger.info { "Actualizando preferencias de notificaciones push" }
        ClientPushPreferencesStore.updateFromPreferences(preferences)
        preferences
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al actualizar preferencias push" }
        throw throwable.toClientException()
    }
}
