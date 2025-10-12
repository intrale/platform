package ui.session

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * Representa los roles disponibles dentro de la aplicación.
 */
enum class UserRole(val rawValue: String) {
    PlatformAdmin("PlatformAdmin"),
    BusinessAdmin("BusinessAdmin"),
    Delivery("Delivery"),
    Saler("Saler"),
    Client("Client");

    companion object {
        fun fromRaw(value: String?): UserRole? = values().firstOrNull { it.rawValue == value }
    }
}

/**
 * Estado actual de la sesión del usuario.
 */
data class SessionState(
    val role: UserRole? = null,
    val selectedBusinessId: String? = null,
)

/**
 * Almacena y expone el estado global de la sesión en memoria.
 */
object SessionStore {
    private val mutableState = MutableStateFlow(SessionState())

    val sessionState: StateFlow<SessionState> = mutableState.asStateFlow()

    fun updateRole(role: UserRole?) {
        mutableState.update { current -> current.copy(role = role) }
    }

    fun updateSelectedBusiness(businessId: String?) {
        mutableState.update { current -> current.copy(selectedBusinessId = businessId) }
    }

    fun clear() {
        mutableState.value = SessionState()
    }
}
