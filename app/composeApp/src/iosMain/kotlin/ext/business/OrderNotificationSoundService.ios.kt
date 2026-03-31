package ext.business

import asdo.business.OrderSoundConfig

/**
 * Implementacion iOS del servicio de sonido.
 * Pendiente de integracion nativa con AudioServicesPlaySystemSound.
 */
actual class OrderNotificationSoundService actual constructor() {

    actual fun playNotificationSound(config: OrderSoundConfig) {
        // TODO: integrar con AudioServicesPlaySystemSound en iOS
    }

    actual fun stopSound() {
        // No-op por ahora
    }

    actual fun vibrate(config: OrderSoundConfig) {
        // TODO: integrar con AudioServicesPlayAlertSound para haptic feedback
    }

    actual fun release() {
        // No-op
    }

    actual fun isAvailable(): Boolean = false
}
