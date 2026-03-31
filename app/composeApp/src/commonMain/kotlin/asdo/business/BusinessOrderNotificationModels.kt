package asdo.business

/**
 * Configuracion de notificaciones sonoras para pedidos del negocio.
 */
data class OrderSoundConfig(
    val enabled: Boolean = true,
    val volume: Float = 0.8f,
    val vibrationEnabled: Boolean = true,
    val repeatIntervalSeconds: Int = DEFAULT_REPEAT_INTERVAL_SECONDS,
    val soundType: OrderSoundType = OrderSoundType.DEFAULT,
    val isMuted: Boolean = false
) {
    companion object {
        const val DEFAULT_REPEAT_INTERVAL_SECONDS = 30
        const val MIN_VOLUME = 0.0f
        const val MAX_VOLUME = 1.0f
    }
}

/**
 * Tipos de sonido disponibles para notificacion de pedidos.
 */
enum class OrderSoundType {
    DEFAULT,
    BELL,
    CHIME,
    URGENT
}

/**
 * Estado de la alerta sonora activa.
 */
data class ActiveSoundAlert(
    val orderId: String,
    val shortCode: String,
    val startedAt: Long,
    val isPlaying: Boolean = true
)
