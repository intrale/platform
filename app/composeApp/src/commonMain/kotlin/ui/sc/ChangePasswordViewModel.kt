package ui.sc

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.DoChangePasswordResult
import asdo.ToDoChangePassword
import io.konform.validation.Validation
import io.konform.validation.jsonschema.minLength
import org.kodein.di.instance

class ChangePasswordViewModel : ViewModel() {

    private val toDoChangePassword: ToDoChangePassword by DIManager.di.instance()

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

    suspend fun changePassword(): Result<DoChangePasswordResult> =
        toDoChangePassword.execute(state.oldPassword, state.newPassword)
}
