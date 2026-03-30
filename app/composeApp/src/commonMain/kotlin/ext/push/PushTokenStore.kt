package ext.push

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Store centralizado para el token push del dispositivo.
 * Se actualiza cuando Firebase/APNs genera o renueva un token.
 */
object PushTokenStore {

    private val _token = MutableStateFlow<String?>(null)
    val token: StateFlow<String?> = _token.asStateFlow()

    private val _isRegistered = MutableStateFlow(false)
    val isRegistered: StateFlow<Boolean> = _isRegistered.asStateFlow()

    fun updateToken(newToken: String) {
        _token.value = newToken
        _isRegistered.value = false // Necesita re-registro con backend
    }

    fun markRegistered() {
        _isRegistered.value = true
    }

    fun clear() {
        _token.value = null
        _isRegistered.value = false
    }
}
