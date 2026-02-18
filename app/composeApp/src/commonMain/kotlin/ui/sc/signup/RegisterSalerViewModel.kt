package ui.sc.signup

import DIManager
import asdo.signup.DoRegisterSalerResult
import asdo.signup.ToDoRegisterSaler
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import ar.com.intrale.strings.model.MessageKey
import ar.com.intrale.strings.resolveMessage
import io.konform.validation.Validation
import io.konform.validation.jsonschema.pattern
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

class RegisterSalerViewModel(
    private val toDoRegisterSaler: ToDoRegisterSaler = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {
    private val logger = loggerFactory.newLogger<RegisterSalerViewModel>()

    var state by mutableStateOf(RegisterSalerUIState())
    var loading by mutableStateOf(false)

    data class RegisterSalerUIState(val email: String = "")

    override fun getState(): Any = state

    init {
        validation = Validation<RegisterSalerUIState> {
            RegisterSalerUIState::email required {
                pattern(".+@.+\\..+") hint resolveMessage(MessageKey.register_saler_email_invalid)
            }
        } as Validation<Any>
        initInputState()
    }

    override fun initInputState() {
        inputsStates = mutableMapOf(entry(RegisterSalerUIState::email.name))
    }

    suspend fun register(): Result<DoRegisterSalerResult> =
        toDoRegisterSaler.execute(state.email)
            .onSuccess { logger.info { "Vendedor registrado: ${state.email}" } }
            .onFailure { error -> logger.error { "Error al registrar vendedor: ${error.message}" } }
}
