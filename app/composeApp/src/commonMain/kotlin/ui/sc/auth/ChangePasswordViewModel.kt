package ui.sc.auth

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.auth.DoChangePasswordResult
import asdo.auth.ToDoChangePassword
import io.konform.validation.Validation
import io.konform.validation.jsonschema.minLength
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

class ChangePasswordViewModel : ViewModel() {

    private val toDoChangePassword: ToDoChangePassword by DIManager.di.instance()
    private val logger = LoggerFactory.default.newLogger<ChangePasswordViewModel>()

    var state by mutableStateOf(ChangePasswordUIState())
    var loading by mutableStateOf(false)

    data class ChangePasswordUIState(
        val oldPassword: String = "",
        val newPassword: String = ""
    )

    override fun getState(): Any = state

    init {
        setupValidation()
        initInputState()
    }

    fun setupValidation() {
        validation = Validation<ChangePasswordUIState> {
            ChangePasswordUIState::oldPassword required {
                minLength(8) hint "Debe contener al menos 8 caracteres."
            }
            ChangePasswordUIState::newPassword required {
                minLength(8) hint "Debe contener al menos 8 caracteres."
            }
        } as Validation<Any>
    }

    override fun initInputState() {
        inputsStates = mutableMapOf(
            entry(ChangePasswordUIState::oldPassword.name),
            entry(ChangePasswordUIState::newPassword.name)
        )
    }

    suspend fun changePassword(): Result<DoChangePasswordResult> {
        logger.debug { "Ejecutando cambio de contraseña" }
        val result = toDoChangePassword.execute(state.oldPassword, state.newPassword)
        result.onSuccess { logger.debug { "Cambio de contraseña exitoso" } }
            .onFailure { error -> logger.error { "Error al cambiar contraseña: ${error.message}" } }
        return result
    }
}
