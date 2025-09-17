package ui.sc

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.DoLoginResult
import asdo.ToDoCheckPreviousLogin
import asdo.ToDoLogin
import io.konform.validation.Validation
import io.konform.validation.jsonschema.minLength
import io.konform.validation.jsonschema.pattern
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.InputState

class LoginViewModel : ViewModel() {

    private val todoLogin: ToDoLogin by DIManager.di.instance()
    private val toDoCheckPreviousLogin: ToDoCheckPreviousLogin by DIManager.di.instance()
    private val logger = LoggerFactory.default.newLogger<LoginViewModel>()

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
            minLength(1) hint "Ingresá tu correo electrónico"
            pattern(".+@.+\\..+") hint "Ingresá un correo electrónico válido"
        }
        LoginUIState::password required {
            minLength(1) hint "Ingresá tu contraseña"
            minLength(8) hint "Debe contener al menos 8 caracteres"
        }
        if (changePasswordRequired) {
            LoginUIState::newPassword required {
                minLength(1) hint "Ingresá tu nueva contraseña"
                minLength(8) hint "Debe contener al menos 8 caracteres"
            }
            LoginUIState::name required {
                minLength(1) hint "Ingresá tu nombre"
            }
            LoginUIState::familyName required {
                minLength(1) hint "Ingresá tu apellido"
            }
        }
    }
}

