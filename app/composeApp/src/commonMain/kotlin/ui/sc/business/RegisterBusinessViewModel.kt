package ui.sc.business

import DIManager
import asdo.business.ToDoRegisterBusiness
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import ar.com.intrale.strings.model.MessageKey
import io.konform.validation.Validation
import io.konform.validation.jsonschema.pattern
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

class RegisterBusinessViewModel : ViewModel() {
    private val logger = LoggerFactory.default.newLogger<RegisterBusinessViewModel>()
    private val register: ToDoRegisterBusiness by DIManager.di.instance()

    var state by mutableStateOf(UIState())
    var loading by mutableStateOf(false)

    data class UIState(
        val name: String = "",
        val email: String = "",
        val description: String = ""
    )

    override fun getState(): Any = state

    init {
        validation = Validation<UIState> {
            UIState::name required {
                hint(MessageKey.form_error_required.name)
            }
            UIState::email required {
                hint(MessageKey.form_error_required.name)
                pattern(".+@.+\\..+") hint MessageKey.form_error_invalid_email.name
            }
            UIState::description required {
                hint(MessageKey.form_error_required.name)
            }
        } as Validation<Any>
        initInputState()
    }

    override fun initInputState() {
        inputsStates = mutableMapOf(
            entry(UIState::name.name),
            entry(UIState::email.name),
            entry(UIState::description.name)
        )
    }

    suspend fun register() =
        register.execute(state.name, state.email, state.description)
            .onSuccess { logger.info { "Negocio registrado: ${'$'}{state.name}" } }
            .onFailure { error -> logger.error { "Error registrando negocio: ${'$'}{error.message}" } }
}
