package ui.sc.signup

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.signup.DoSignUpResult
import asdo.signup.ToDoSignUp
import io.konform.validation.Validation
import io.konform.validation.jsonschema.pattern
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

class SignUpViewModel : ViewModel() {
    private val logger = LoggerFactory.default.newLogger<SignUpViewModel>()
    private val toDoSignUpGeneric: ToDoSignUp by DIManager.di.instance()

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
        toDoSignUpGeneric.execute(state.email)
            .onSuccess { logger.info { "Usuario registrado: ${'$'}{state.email}" } }
            .onFailure { error -> logger.error { "Error registro usuario: ${'$'}{error.message}" } }
}
