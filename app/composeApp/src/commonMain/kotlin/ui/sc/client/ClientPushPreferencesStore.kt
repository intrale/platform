package ui.sc.client

import asdo.client.ClientPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Store centralizado para las preferencias de notificaciones push del cliente.
 * Mantiene el estado en memoria y se sincroniza con el perfil del usuario.
 */
object ClientPushPreferencesStore {

    private val _preferences = MutableStateFlow(PushPreferencesState())
    val preferences: StateFlow<PushPreferencesState> = _preferences.asStateFlow()

    fun updateFromPreferences(prefs: ClientPreferences) {
        _preferences.value = PushPreferencesState(
            enabled = prefs.pushNotificationsEnabled,
            orderConfirmed = prefs.pushOrderConfirmed,
            orderDelivering = prefs.pushOrderDelivering,
            orderNearby = prefs.pushOrderNearby,
            orderDelivered = prefs.pushOrderDelivered
        )
    }

    fun toggleEnabled(value: Boolean) {
        _preferences.value = _preferences.value.copy(enabled = value)
    }

    fun toggleOrderConfirmed(value: Boolean) {
        _preferences.value = _preferences.value.copy(orderConfirmed = value)
    }

    fun toggleOrderDelivering(value: Boolean) {
        _preferences.value = _preferences.value.copy(orderDelivering = value)
    }

    fun toggleOrderNearby(value: Boolean) {
        _preferences.value = _preferences.value.copy(orderNearby = value)
    }

    fun toggleOrderDelivered(value: Boolean) {
        _preferences.value = _preferences.value.copy(orderDelivered = value)
    }

    fun toPreferencesUpdate(base: ClientPreferences): ClientPreferences {
        val current = _preferences.value
        return base.copy(
            pushNotificationsEnabled = current.enabled,
            pushOrderConfirmed = current.orderConfirmed,
            pushOrderDelivering = current.orderDelivering,
            pushOrderNearby = current.orderNearby,
            pushOrderDelivered = current.orderDelivered
        )
    }

    fun clear() {
        _preferences.value = PushPreferencesState()
    }
}

data class PushPreferencesState(
    val enabled: Boolean = true,
    val orderConfirmed: Boolean = true,
    val orderDelivering: Boolean = true,
    val orderNearby: Boolean = true,
    val orderDelivered: Boolean = true
)
