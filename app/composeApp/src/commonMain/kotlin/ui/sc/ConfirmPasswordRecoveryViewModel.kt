package ui.sc

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.DoConfirmPasswordRecoveryResult
import asdo.ToDoConfirmPasswordRecovery
import io.konform.validation.Validation
import io.konform.validation.jsonschema.minLength
import io.konform.validation.jsonschema.pattern
import org.kodein.di.instance

class ConfirmPasswordRecoveryViewModel : ViewModel() {
    private val toDoConfirmPasswordRecovery: ToDoConfirmPasswordRecovery by DIManager.di.instance()

    var state by mutableStateOf(ConfirmPasswordRecoveryUIState())
    var loading by mutableStateOf(false)

    data class ConfirmPasswordRecoveryUIState(
        val email: String = "",
        val code: String = "",
        val password: String = ""
    )

    override fun getState(): Any = state

    init {
        setupValidation()
        initInputState()
    }

    fun setupValidation() {
        validation = Validation<ConfirmPasswordRecoveryUIState> {
            ConfirmPasswordRecoveryUIState::email required {
                pattern(".+@.+\\..+") hint "Correo inválido"
            }
            ConfirmPasswordRecoveryUIState::code required {}
            ConfirmPasswordRecoveryUIState::password required {
                minLength(8) hint "Debe contener al menos 8 caracteres."
            }
        } as Validation<Any>
    }

    override fun initInputState() {
        inputsStates = mutableMapOf(
            entry(ConfirmPasswordRecoveryUIState::email.name),
            entry(ConfirmPasswordRecoveryUIState::code.name),
            entry(ConfirmPasswordRecoveryUIState::password.name)
        )
    }

    suspend fun confirm(): Result<DoConfirmPasswordRecoveryResult> =
        toDoConfirmPasswordRecovery.execute(state.email, state.code, state.password)
}
