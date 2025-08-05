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
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class PasswordRecoveryViewModel : ViewModel() {
    private val toDoPasswordRecovery: ToDoPasswordRecovery by DIManager.di.instance()
    private val logger = LoggerFactory.default.newLogger<PasswordRecoveryViewModel>()

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

    suspend fun recovery(): Result<DoPasswordRecoveryResult> {
        logger.debug { "Ejecutando recuperación de contraseña" }
        val result = toDoPasswordRecovery.execute(state.email)
        result.onSuccess { logger.debug { "Correo de recuperación enviado" } }
            .onFailure { error -> logger.error { "Error en recuperación de contraseña: ${error.message}" } }
        return result
    }
}
