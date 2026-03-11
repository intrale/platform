package ui.sc.auth

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import ar.com.intrale.strings.model.MessageKey
import ar.com.intrale.strings.resolveMessage
import asdo.auth.DoLoginResult
import asdo.auth.ToDoLogin
import io.konform.validation.Validation
import io.konform.validation.jsonschema.minLength
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

/**
 * Almacén temporal de credenciales para el flujo de cambio de contraseña obligatorio.
 * Se limpia automáticamente tras completar el login.
 */
internal object ForceChangePasswordCredentialsStore {
    var user: String = ""
    var password: String = ""

    fun store(user: String, password: String) {
        this.user = user
        this.password = password
    }

    fun clear() {
        user = ""
        password = ""
    }
}

class ForceChangePasswordViewModel(
    private val todoLogin: ToDoLogin = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<ForceChangePasswordViewModel>()

    var state by mutableStateOf(ForceChangePasswordUIState())
        private set
    var loading by mutableStateOf(false)

    data class ForceChangePasswordUIState(
        val newPassword: String = "",
        val name: String = "",
        val familyName: String = ""
    )

    override fun getState(): Any = state

    init {
        setupValidation()
        initInputState()
    }

    fun setupValidation() {
        validation = Validation<ForceChangePasswordUIState> {
            ForceChangePasswordUIState::newPassword required {
                minLength(1) hint resolveMessage(MessageKey.form_error_required)
                minLength(8) hint resolveMessage(MessageKey.form_error_min_length_8)
            }
            ForceChangePasswordUIState::name required {
                minLength(1) hint resolveMessage(MessageKey.form_error_required)
            }
            ForceChangePasswordUIState::familyName required {
                minLength(1) hint resolveMessage(MessageKey.form_error_required)
            }
        } as Validation<Any>
    }

    override fun initInputState() {
        inputsStates = mutableMapOf(
            entry(ForceChangePasswordUIState::newPassword.name),
            entry(ForceChangePasswordUIState::name.name),
            entry(ForceChangePasswordUIState::familyName.name),
        )
    }

    fun onNewPasswordChange(value: String) {
        state = state.copy(newPassword = value)
    }

    fun onNameChange(value: String) {
        state = state.copy(name = value)
    }

    fun onFamilyNameChange(value: String) {
        state = state.copy(familyName = value)
    }

    suspend fun completeLogin(): Result<DoLoginResult> {
        logger.debug { "Completando login con cambio de contraseña obligatorio" }
        val credentials = ForceChangePasswordCredentialsStore
        val result = todoLogin.execute(
            user = credentials.user,
            password = credentials.password,
            newPassword = state.newPassword,
            name = state.name,
            familyName = state.familyName
        )
        result.onSuccess {
            logger.debug { "Login con cambio de contraseña exitoso" }
            ForceChangePasswordCredentialsStore.clear()
        }.onFailure { error ->
            logger.error { "Error al completar el cambio de contraseña: ${error.message}" }
        }
        return result
    }
}
