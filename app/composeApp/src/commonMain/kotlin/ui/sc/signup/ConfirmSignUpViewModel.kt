package ui.sc.signup

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.signup.DoConfirmSignUpResult
import asdo.signup.DoSignUpResult
import asdo.signup.ToDoConfirmSignUp
import asdo.signup.ToDoSignUp
import ar.com.intrale.strings.model.MessageKey
import ar.com.intrale.strings.resolveMessage
import io.konform.validation.Validation
import io.konform.validation.jsonschema.pattern
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

class ConfirmSignUpViewModel(
    private val toDoConfirmSignUp: ToDoConfirmSignUp = DIManager.di.direct.instance(),
    private val toDoSignUp: ToDoSignUp = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {
    private val logger = loggerFactory.newLogger<ConfirmSignUpViewModel>()

    var state by mutableStateOf(ConfirmSignUpUIState())
    var loading by mutableStateOf(false)

    data class ConfirmSignUpUIState(
        val email: String = "",
        val code: String = ""
    )

    override fun getState(): Any = state

    init {
        setupValidation()
        initInputState()
    }

    fun setupValidation() {
        validation = Validation<ConfirmSignUpUIState> {
            ConfirmSignUpUIState::email required {
                pattern(".+@.+\\..+") hint resolveMessage(MessageKey.form_error_invalid_email)
            }
            ConfirmSignUpUIState::code required {
                pattern("^\\d{6}$") hint resolveMessage(MessageKey.form_error_invalid_code)
            }
        } as Validation<Any>
    }

    override fun initInputState() {
        inputsStates = mutableMapOf(
            entry(ConfirmSignUpUIState::email.name),
            entry(ConfirmSignUpUIState::code.name)
        )
    }

    suspend fun confirmSignUp(): Result<DoConfirmSignUpResult> {
        logger.debug { "Ejecutando confirmación de registro" }
        val result = toDoConfirmSignUp.execute(state.email, state.code)
        result.onSuccess { logger.debug { "Confirmación de registro exitosa" } }
            .onFailure { error -> logger.error { "Error en confirmación de registro: ${error.message}" } }
        return result
    }

    suspend fun resendCode(): Result<DoSignUpResult> {
        logger.debug { "Reenviando código de verificación" }
        val result = toDoSignUp.execute(state.email)
        result.onSuccess { logger.info { "Código reenviado a: ${state.email}" } }
            .onFailure { error -> logger.error { "Error al reenviar código: ${error.message}" } }
        return result
    }
}
