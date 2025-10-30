package ui.sc.signup

import DIManager
import asdo.signup.DoSignUpResult
import asdo.signup.ToDoSignUpPlatformAdmin
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import ar.com.intrale.strings.model.MessageKey
import ar.com.intrale.strings.resolveMessage
import io.konform.validation.Validation
import io.konform.validation.jsonschema.pattern
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

class SignUpPlatformAdminViewModel : ViewModel() {
    private val logger = LoggerFactory.default.newLogger<SignUpPlatformAdminViewModel>()
    private val toDoSignUpPlatformAdmin: ToDoSignUpPlatformAdmin by DIManager.di.instance()

    var state by mutableStateOf(SignUpUIState())
    var loading by mutableStateOf(false)
    data class SignUpUIState(val email: String = "")
    override fun getState(): Any = state

    init {
        validation = Validation<SignUpUIState> {
            SignUpUIState::email required {
                pattern(".+@.+\\..+") hint resolveMessage(MessageKey.form_error_invalid_email)
            }
        } as Validation<Any>
        initInputState()
    }

    override fun initInputState() {
        inputsStates = mutableMapOf(entry(SignUpUIState::email.name))
    }

    suspend fun signup(): Result<DoSignUpResult> =
        toDoSignUpPlatformAdmin.execute(state.email)
            .onSuccess { logger.info { "PlatformAdmin registrado: ${'$'}{state.email}" } }
            .onFailure { error -> logger.error { "Error registro PlatformAdmin: ${'$'}{error.message}" } }
}
