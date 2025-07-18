package ui.sc

import DIManager
import asdo.ToDoSignUpDelivery
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.konform.validation.Validation
import io.konform.validation.jsonschema.pattern
import org.kodein.di.instance

class SignUpDeliveryViewModel : ViewModel() {
    private val toDoSignUp: ToDoSignUpDelivery by DIManager.di.instance()

    var state by mutableStateOf(SignUpUIState())
    data class SignUpUIState(val email: String = "")
    override fun getState(): Any = state

    init {
        validation = Validation<SignUpUIState> {
            SignUpUIState::email required {
                pattern(".+@.+\\..+") hint "Correo inválido"
            }
        } as Validation<Any>
        initInputState()
    }

    override fun initInputState() {
        inputsStates = mutableMapOf(entry(SignUpUIState::email.name))
    }

    suspend fun signup() {
        toDoSignUp.execute(state.email)
    }
}
