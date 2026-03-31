package ext.business

import asdo.business.OrderSoundConfig

/**
 * Implementacion JVM/Desktop del servicio de sonido.
 * Usa java.awt.Toolkit para un beep basico.
 */
actual class OrderNotificationSoundService actual constructor() {

    actual fun playNotificationSound(config: OrderSoundConfig) {
        if (!config.enabled || config.isMuted) return
        try {
            java.awt.Toolkit.getDefaultToolkit().beep()
        } catch (_: Exception) {
            // Headless environment, ignorar
        }
    }

    actual fun stopSound() {
        // No-op en JVM: beep es instantaneo
    }

    actual fun vibrate(config: OrderSoundConfig) {
        // No-op: escritorio no soporta vibracion
    }

    actual fun release() {
        // No-op
    }

    actual fun isAvailable(): Boolean = true
}
