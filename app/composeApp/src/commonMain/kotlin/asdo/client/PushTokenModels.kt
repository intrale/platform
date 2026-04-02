package asdo.client

/**
 * Modelo para el registro de token push del dispositivo.
 */
data class PushTokenRegistration(
    val token: String,
    val platform: PushPlatform,
    val appType: String
)

enum class PushPlatform {
    ANDROID,
    IOS,
    WEB,
    DESKTOP
}

/**
 * Datos de un push notification entrante desde el servidor.
 */
data class IncomingPushNotification(
    val orderId: String,
    val shortCode: String,
    val businessName: String,
    val eventType: NotificationEventType,
    val message: String,
    val timestamp: String
)

/**
 * Resultado del registro de token push.
 */
data class PushTokenResult(
    val registered: Boolean
)
