package ext.push

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Store para manejar deep links desde notificaciones push.
 * Cuando el usuario toca una notificacion, se guarda el orderId pendiente
 * y la UI navega al detalle del pedido.
 */
object PushDeepLinkStore {

    private val _pendingOrderId = MutableStateFlow<String?>(null)
    val pendingOrderId: StateFlow<String?> = _pendingOrderId.asStateFlow()

    /**
     * Establece un orderId pendiente de navegacion desde un push.
     */
    fun setPendingOrderNavigation(orderId: String) {
        _pendingOrderId.value = orderId
    }

    /**
     * Consume el orderId pendiente (una vez navegado, se limpia).
     * @return el orderId si habia uno pendiente, null si no.
     */
    fun consumePendingOrderNavigation(): String? {
        val current = _pendingOrderId.value
        _pendingOrderId.value = null
        return current
    }

    fun clear() {
        _pendingOrderId.value = null
    }
}
