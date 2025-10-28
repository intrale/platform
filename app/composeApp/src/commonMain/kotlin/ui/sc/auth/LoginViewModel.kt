package ui.sc.auth

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import ar.com.intrale.strings.model.MessageKey
import asdo.auth.DoLoginResult
import asdo.auth.ToDoCheckPreviousLogin
import asdo.auth.ToDoLogin
import io.konform.validation.Validation
import io.konform.validation.jsonschema.minLength
import io.konform.validation.jsonschema.pattern
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.inputs.InputState
import ui.sc.shared.ViewModel

private const val MIN_PASSWORD_LENGTH = 8

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

    fun markCredentialsAsInvalid(message: MessageKey) {
        listOf(LoginUIState::user.name, LoginUIState::password.name).forEach { key ->
            inputsStates[key]?.let {
                it.value = it.value.copy(
                    isValid = false,
                    details = "",
                    messageKey = message,
                    messageParams = emptyMap(),
                )
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
            inputState.value = inputState.value.copy(
                isValid = true,
                details = "",
                messageKey = null,
                messageParams = emptyMap(),
            )
        }
        val result = loginValidation(state)
        result.errors.forEach { error ->
            val key = error.dataPath.substring(1)
            val mutableState = inputsStates.getOrPut(key) { mutableStateOf(InputState(key)) }
            val message = error.message
            val (messageKey, params) = message?.let(::parseMessageKeyWithParams) ?: (null to emptyMap())
            mutableState.value = if (messageKey != null) {
                mutableState.value.copy(
                    isValid = false,
                    details = "",
                    messageKey = messageKey,
                    messageParams = params,
                )
            } else {
                mutableState.value.copy(
                    isValid = false,
                    details = message ?: "",
                    messageKey = null,
                    messageParams = emptyMap(),
                )
            }
        }
    }

    private fun buildValidation(): Validation<LoginUIState> = Validation {
        LoginUIState::user required {
            minLength(1) hint MessageKey.validation_enter_email.name
            pattern(".+@.+\\..+") hint MessageKey.validation_enter_valid_email.name
        }
        LoginUIState::password required {
            minLength(1) hint MessageKey.validation_enter_password.name
            minLength(MIN_PASSWORD_LENGTH) hint messageWithParams(MessageKey.validation_min_length, "min" to MIN_PASSWORD_LENGTH.toString())
        }
        if (changePasswordRequired) {
            LoginUIState::newPassword required {
                minLength(1) hint MessageKey.validation_enter_new_password.name
                minLength(MIN_PASSWORD_LENGTH) hint messageWithParams(MessageKey.validation_min_length, "min" to MIN_PASSWORD_LENGTH.toString())
            }
            LoginUIState::name required {
                minLength(1) hint MessageKey.validation_enter_name.name
            }
            LoginUIState::familyName required {
                minLength(1) hint MessageKey.validation_enter_family_name.name
            }
        }
    }

    private fun messageWithParams(messageKey: MessageKey, vararg params: Pair<String, String>): String {
        val encodedParams = params.joinToString(separator = "|") { (param, value) -> "$param=$value" }
        return buildString {
            append(messageKey.name)
            if (encodedParams.isNotEmpty()) {
                append("|")
                append(encodedParams)
            }
        }
    }

    private fun parseMessageKeyWithParams(raw: String): Pair<MessageKey?, Map<String, String>> {
        val segments = raw.split("|")
        val key = segments.firstOrNull()?.let { runCatching { MessageKey.valueOf(it) }.getOrNull() }
        if (key == null) {
            return null to emptyMap()
        }
        val params = segments.drop(1).mapNotNull { segment ->
            val parts = segment.split("=", limit = 2)
            if (parts.size == 2) {
                parts[0] to parts[1]
            } else {
                null
            }
        }.toMap()
        return key to params
    }
}

