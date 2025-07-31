package ui.sc

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.DoPasswordRecoveryResult
import asdo.ToDoPasswordRecovery
import io.konform.validation.Validation
import io.konform.validation.jsonschema.pattern
import org.kodein.di.instance

class PasswordRecoveryViewModel : ViewModel() {
    private val toDoPasswordRecovery: ToDoPasswordRecovery by DIManager.di.instance()

    var state by mutableStateOf(PasswordRecoveryUIState())
    var loading by mutableStateOf(false)

    data class PasswordRecoveryUIState(val email: String = "")

    override fun getState(): Any = state

    init {
        setupValidation()
        initInputState()
    }

    fun setupValidation() {
        validation = Validation<PasswordRecoveryUIState> {
            PasswordRecoveryUIState::email required {
                pattern(".+@.+\\..+") hint "Correo inválido"
            }
        } as Validation<Any>
    }

    override fun initInputState() {
        inputsStates = mutableMapOf(entry(PasswordRecoveryUIState::email.name))
    }

    suspend fun recovery(): Result<DoPasswordRecoveryResult> =
        toDoPasswordRecovery.execute(state.email)
}
