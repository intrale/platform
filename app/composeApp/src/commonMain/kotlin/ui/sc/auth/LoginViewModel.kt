package ui.sc.auth

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import ar.com.intrale.strings.model.MessageKey
import ar.com.intrale.strings.resolveMessage
import asdo.auth.DoLoginResult
import asdo.auth.ToDoCheckPreviousLogin
import asdo.auth.ToDoLogin
import io.konform.validation.Validation
import io.konform.validation.jsonschema.minLength
import io.konform.validation.jsonschema.pattern
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.inputs.InputState
import ui.sc.shared.ViewModel

class LoginViewModel(
    private val todoLogin: ToDoLogin = DIManager.di.direct.instance(),
    private val toDoCheckPreviousLogin: ToDoCheckPreviousLogin = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<LoginViewModel>()

    // data state initialize
    var state by mutableStateOf(LoginUIState())
        private set
    var loading by mutableStateOf(false)
    var changePasswordRequired by mutableStateOf(false)
        private set
    private var loginValidation: Validation<LoginUIState> = buildValidation()

    data class LoginUIState (
        val user: String = "",
        val password: String = "",
        val newPassword: String = "",
        val name: String = "",
        val familyName: String = ""
    )
    override fun getState(): Any  = state

    // inputs and validations initialize
    init {
        setupValidation()
        initInputState()

   }

    fun setupValidation() {
        loginValidation = buildValidation()
        validation = loginValidation as Validation<Any>
    }
   override fun initInputState() {
       inputsStates = mutableMapOf(
            entry(LoginUIState::user.name),
            entry(LoginUIState::password.name),
            entry(LoginUIState::newPassword.name),
            entry(LoginUIState::name.name),
            entry(LoginUIState::familyName.name),
       )
       /*if (changePasswordRequired) {
            inputsStates[LoginUIState::newPassword.name] = mutableStateOf(InputState(LoginUIState::newPassword.name))
            inputsStates[LoginUIState::name.name] = mutableStateOf(InputState(LoginUIState::name.name))
            inputsStates[LoginUIState::familyName.name] = mutableStateOf(InputState(LoginUIState::familyName.name))
       }*/
    }

    // Features
    suspend fun login(): Result<DoLoginResult> {
        logger.debug { "Iniciando login" }
        setupValidation()
        validateCurrentState()
        val result = todoLogin.execute(
            user = state.user,
            password = state.password,
            newPassword = if (changePasswordRequired) state.newPassword else null,
            name = if (changePasswordRequired) state.name else null,
            familyName = if (changePasswordRequired) state.familyName else null
        )
        result.onSuccess { logger.debug { "Login exitoso" } }
            .onFailure { error -> logger.error { "Error al iniciar sesión: ${error.message}" } }
        return result
    }

    suspend fun previousLogin(): Boolean {
        logger.debug { "Verificando inicio de sesión previo" }
        val result = toDoCheckPreviousLogin.execute()
        logger.debug { "Resultado verificación: $result" }
        return result
    }

    fun onUserChange(value: String) {
        state = state.copy(user = value)
        validateCurrentState()
    }

    fun onPasswordChange(value: String) {
        state = state.copy(password = value)
        validateCurrentState()
    }

    fun onNewPasswordChange(value: String) {
        state = state.copy(newPassword = value)
        validateCurrentState()
    }

    fun onNameChange(value: String) {
        state = state.copy(name = value)
        validateCurrentState()
    }

    fun onFamilyNameChange(value: String) {
        state = state.copy(familyName = value)
        validateCurrentState()
    }

    fun markCredentialsAsInvalid(message: String) {
        listOf(LoginUIState::user.name, LoginUIState::password.name).forEach { key ->
            inputsStates[key]?.let {
                it.value = it.value.copy(isValid = false, details = message)
            }
        }
    }

    fun requirePasswordChange() {
        if (!changePasswordRequired) {
            changePasswordRequired = true
            setupValidation()
        }
        validateCurrentState()
    }

    private fun validateCurrentState() {
        inputsStates.forEach { (_, inputState) ->
            inputState.value = inputState.value.copy(isValid = true, details = "")
        }
        val result = loginValidation(state)
        result.errors.forEach { error ->
            val key = error.dataPath.substring(1)
            val mutableState = inputsStates.getOrPut(key) { mutableStateOf(InputState(key)) }
            mutableState.value = mutableState.value.copy(
                isValid = false,
                details = error.message
            )
        }
    }

    private fun buildValidation(): Validation<LoginUIState> = Validation {
        LoginUIState::user required {
            minLength(1) hint resolveMessage(MessageKey.form_error_required)
            pattern(".+@.+\\..+") hint resolveMessage(MessageKey.form_error_invalid_email)
        }
        LoginUIState::password required {
            minLength(1) hint resolveMessage(MessageKey.form_error_required)
            minLength(8) hint resolveMessage(MessageKey.form_error_min_length_8)
        }
        if (changePasswordRequired) {
            LoginUIState::newPassword required {
                minLength(1) hint resolveMessage(MessageKey.form_error_required)
                minLength(8) hint resolveMessage(MessageKey.form_error_min_length_8)
            }
            LoginUIState::name required {
                minLength(1) hint resolveMessage(MessageKey.form_error_required)
            }
            LoginUIState::familyName required {
                minLength(1) hint resolveMessage(MessageKey.form_error_required)
            }
        }
    }
}

