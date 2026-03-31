package ext.business

import asdo.business.OrderSoundConfig
import asdo.business.OrderSoundType

/**
 * Servicio multiplataforma para reproducir sonidos de notificacion de pedidos.
 * Cada plataforma provee su propia implementacion.
 */
expect class OrderNotificationSoundService() {

    /**
     * Reproduce el sonido de notificacion segun la configuracion.
     */
    fun playNotificationSound(config: OrderSoundConfig)

    /**
     * Detiene cualquier sonido en reproduccion.
     */
    fun stopSound()

    /**
     * Activa vibracion si esta habilitada en la configuracion.
     */
    fun vibrate(config: OrderSoundConfig)

    /**
     * Libera recursos del servicio de sonido.
     */
    fun release()

    /**
     * Indica si el servicio esta disponible en la plataforma actual.
     */
    fun isAvailable(): Boolean
}
