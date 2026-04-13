package ext.push

import asdo.client.IncomingPushNotification

/**
 * Interfaz para mostrar notificaciones del sistema (barra de notificaciones).
 * Cada plataforma implementa su propia version.
 */
interface PushNotificationDisplay {

    /**
     * Muestra una notificacion del sistema con los datos del push.
     * @param notification datos de la notificacion entrante
     * @return true si la notificacion fue mostrada correctamente
     */
    fun show(notification: IncomingPushNotification): Boolean

    /**
     * Inicializa los canales de notificacion (necesario en Android 8+).
     */
    fun initializeChannels()
}

/**
 * Implementacion no-op para plataformas sin soporte de notificaciones push del sistema.
 */
class NoOpPushNotificationDisplay : PushNotificationDisplay {
    override fun show(notification: IncomingPushNotification): Boolean = false
    override fun initializeChannels() {}
}
