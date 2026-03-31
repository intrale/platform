package ui.sc.business

import asdo.business.ActiveSoundAlert
import asdo.business.BusinessOrder
import asdo.business.BusinessOrderStatus
import asdo.business.OrderSoundConfig
import asdo.business.OrderSoundType
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

/**
 * Store singleton que gestiona las notificaciones sonoras de pedidos nuevos.
 * Detecta ordenes nuevas PENDING y dispara alertas sonoras que se repiten
 * hasta que el pedido sea abierto o confirmado.
 */
object BusinessOrderNotificationStore {

    private val logger = LoggerFactory.default.newLogger<BusinessOrderNotificationStore>()

    private val _config = MutableStateFlow(OrderSoundConfig())
    val config: StateFlow<OrderSoundConfig> = _config.asStateFlow()

    private val _activeAlerts = MutableStateFlow<List<ActiveSoundAlert>>(emptyList())
    val activeAlerts: StateFlow<List<ActiveSoundAlert>> = _activeAlerts.asStateFlow()

    /** IDs de ordenes ya conocidas (no disparan alerta de nuevo) */
    private val knownOrderIds = mutableSetOf<String>()

    /**
     * Procesa una lista de ordenes y detecta nuevas ordenes PENDING.
     * Retorna los IDs de ordenes nuevas que requieren alerta sonora.
     */
    fun processOrders(orders: List<BusinessOrder>): List<BusinessOrder> {
        val newPendingOrders = orders.filter { order ->
            order.status == BusinessOrderStatus.PENDING && order.id !in knownOrderIds
        }

        // Registrar todas las ordenes como conocidas
        orders.forEach { knownOrderIds.add(it.id) }

        if (newPendingOrders.isNotEmpty()) {
            logger.info { "Detectados ${newPendingOrders.size} pedidos nuevos pendientes" }
            val now = kotlinx.datetime.Clock.System.now().toEpochMilliseconds()
            val newAlerts = newPendingOrders.map { order ->
                ActiveSoundAlert(
                    orderId = order.id,
                    shortCode = order.shortCode,
                    startedAt = now,
                    isPlaying = true
                )
            }
            _activeAlerts.update { current -> current + newAlerts }
        }

        // Remover alertas de ordenes que ya no estan PENDING
        val pendingIds = orders.filter { it.status == BusinessOrderStatus.PENDING }.map { it.id }.toSet()
        _activeAlerts.update { current ->
            current.filter { it.orderId in pendingIds }
        }

        return newPendingOrders
    }

    /**
     * Marca una alerta como atendida (el usuario abrio el pedido).
     */
    fun dismissAlert(orderId: String) {
        logger.info { "Descartando alerta del pedido $orderId" }
        _activeAlerts.update { current ->
            current.filter { it.orderId != orderId }
        }
    }

    /**
     * Descarta todas las alertas activas.
     */
    fun dismissAllAlerts() {
        logger.info { "Descartando todas las alertas activas" }
        _activeAlerts.value = emptyList()
    }

    /**
     * Silencia temporalmente las notificaciones.
     */
    fun toggleMute() {
        _config.update { it.copy(isMuted = !it.isMuted) }
        val muted = _config.value.isMuted
        logger.info { "Notificaciones ${if (muted) "silenciadas" else "activadas"}" }
    }

    fun updateConfig(config: OrderSoundConfig) {
        _config.value = config
        logger.info { "Configuracion de sonido actualizada: enabled=${config.enabled}, volume=${config.volume}" }
    }

    fun updateVolume(volume: Float) {
        _config.update {
            it.copy(volume = volume.coerceIn(OrderSoundConfig.MIN_VOLUME, OrderSoundConfig.MAX_VOLUME))
        }
    }

    fun updateSoundType(soundType: OrderSoundType) {
        _config.update { it.copy(soundType = soundType) }
    }

    fun toggleVibration() {
        _config.update { it.copy(vibrationEnabled = !it.vibrationEnabled) }
    }

    fun toggleEnabled() {
        _config.update { it.copy(enabled = !it.enabled) }
    }

    val hasActiveAlerts: Boolean
        get() = _activeAlerts.value.isNotEmpty()

    val shouldPlaySound: Boolean
        get() {
            val cfg = _config.value
            return cfg.enabled && !cfg.isMuted && _activeAlerts.value.any { it.isPlaying }
        }

    /**
     * Limpia el estado completo (usado al cerrar sesion).
     */
    fun clear() {
        knownOrderIds.clear()
        _activeAlerts.value = emptyList()
        _config.value = OrderSoundConfig()
    }
}
