package ui.sc

import DIManager
import asdo.DoSignUpResult
import asdo.ToDoSignUpDelivery
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.konform.validation.Validation
import io.konform.validation.jsonschema.pattern
import org.kodein.di.instance

class SignUpDeliveryViewModel : ViewModel() {
    private val toDoSignUpDelivery: ToDoSignUpDelivery by DIManager.di.instance()

    var state by mutableStateOf(SignUpUIState())
    var loading by mutableStateOf(false)
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

    suspend fun signup(): Result<DoSignUpResult> =
        toDoSignUpDelivery.execute(state.email)
}
