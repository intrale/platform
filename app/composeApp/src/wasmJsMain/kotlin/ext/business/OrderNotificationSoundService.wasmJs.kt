package ext.business

import asdo.business.OrderSoundConfig

/**
 * Implementacion Wasm/Web del servicio de sonido.
 * Pendiente de integracion con Web Audio API.
 */
actual class OrderNotificationSoundService actual constructor() {

    actual fun playNotificationSound(config: OrderSoundConfig) {
        // TODO: integrar con Web Audio API
    }

    actual fun stopSound() {
        // No-op por ahora
    }

    actual fun vibrate(config: OrderSoundConfig) {
        // TODO: integrar con navigator.vibrate()
    }

    actual fun release() {
        // No-op
    }

    actual fun isAvailable(): Boolean = false
}
