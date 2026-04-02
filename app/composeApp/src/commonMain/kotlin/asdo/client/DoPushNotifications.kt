package asdo.client

import ext.client.CommPushTokenService
import ext.client.toClientException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.client.ClientNotificationStore
import ui.sc.client.ClientPushPreferencesStore

class DoRegisterPushToken(
    private val pushTokenService: CommPushTokenService
) : ToDoRegisterPushToken {

    private val logger = LoggerFactory.default.newLogger<DoRegisterPushToken>()

    override suspend fun execute(registration: PushTokenRegistration): Result<PushTokenResult> = runCatching {
        logger.info { "Registrando token push para ${registration.platform}" }
        pushTokenService.registerToken(
            token = registration.token,
            platform = registration.platform.name.lowercase(),
            appType = registration.appType
        ).getOrThrow()
        PushTokenResult(registered = true)
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al registrar token push" }
        throw throwable.toClientException()
    }
}

class DoUnregisterPushToken(
    private val pushTokenService: CommPushTokenService
) : ToDoUnregisterPushToken {

    private val logger = LoggerFactory.default.newLogger<DoUnregisterPushToken>()

    override suspend fun execute(token: String): Result<Unit> = runCatching {
        logger.info { "Desregistrando token push" }
        pushTokenService.unregisterToken(token).getOrThrow()
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al desregistrar token push" }
        throw throwable.toClientException()
    }
}

class DoPushNotificationHandler : ToDoPushNotificationHandler {

    private val logger = LoggerFactory.default.newLogger<DoPushNotificationHandler>()

    override suspend fun execute(notification: IncomingPushNotification): Result<Boolean> = runCatching {
        logger.info { "Procesando push notification: ${notification.eventType} para pedido ${notification.shortCode}" }

        val preferences = ClientPushPreferencesStore.preferences.value

        // Si las notificaciones push estan desactivadas globalmente, descartamos
        if (!preferences.enabled) {
            logger.info { "Push notifications desactivadas globalmente, descartando" }
            return@runCatching false
        }

        // Filtrar segun preferencias especificas por tipo de evento
        val shouldNotify = when (notification.eventType) {
            NotificationEventType.ORDER_CONFIRMED -> preferences.orderConfirmed
            NotificationEventType.ORDER_DELIVERING -> preferences.orderDelivering
            NotificationEventType.ORDER_DELIVERED -> preferences.orderDelivered
            NotificationEventType.ORDER_READY -> preferences.orderNearby
            // Los demas tipos siempre se notifican si push esta habilitado
            NotificationEventType.ORDER_CREATED,
            NotificationEventType.ORDER_PREPARING,
            NotificationEventType.ORDER_CANCELLED,
            NotificationEventType.BUSINESS_MESSAGE -> true
        }

        if (!shouldNotify) {
            logger.info { "Notificacion filtrada por preferencias: ${notification.eventType}" }
            return@runCatching false
        }

        // Agregar al store de notificaciones
        val notifId = "${notification.orderId}_${notification.eventType.name}"
        val clientNotification = ClientNotification(
            id = notifId,
            orderId = notification.orderId,
            shortCode = notification.shortCode,
            businessName = notification.businessName,
            eventType = notification.eventType,
            message = notification.message,
            timestamp = notification.timestamp,
            isRead = false
        )

        ClientNotificationStore.addFromPush(clientNotification)
        logger.info { "Push notification agregada al store: $notifId" }
        true
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Error procesando push notification" }
        throw throwable.toClientException()
    }
}
