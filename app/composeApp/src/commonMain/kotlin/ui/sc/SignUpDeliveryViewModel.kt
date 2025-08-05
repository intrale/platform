package ui.sc

import DIManager
import asdo.DoSignUpResult
import asdo.ToDoSignUpDelivery
import asdo.ToGetBusinesses
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.konform.validation.Validation
import io.konform.validation.jsonschema.pattern
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class SignUpDeliveryViewModel : ViewModel() {
    private val logger = LoggerFactory.default.newLogger<SignUpDeliveryViewModel>()
    private val toDoSignUpDelivery: ToDoSignUpDelivery by DIManager.di.instance()
    private val toGetBusinesses: ToGetBusinesses by DIManager.di.instance()

    var state by mutableStateOf(SignUpUIState())
    var suggestions by mutableStateOf(listOf<String>())
    var loading by mutableStateOf(false)
    data class SignUpUIState(val email: String = "", val business: String = "")
    override fun getState(): Any = state

    init {
        validation = Validation<SignUpUIState> {
            SignUpUIState::email required {
                pattern(".+@.+\\..+") hint "Correo inválido"
            }
            SignUpUIState::business required {}
        } as Validation<Any>
        initInputState()
    }

    override fun initInputState() {
        inputsStates = mutableMapOf(entry(SignUpUIState::email.name), entry(SignUpUIState::business.name))
    }

    suspend fun signup(): Result<DoSignUpResult> =
        toDoSignUpDelivery.execute(state.business, state.email)
            .onSuccess { logger.info { "Delivery registrado: ${'$'}{state.email}" } }
            .onFailure { error -> logger.error { "Error registro delivery: ${'$'}{error.message}" } }

    suspend fun searchBusinesses(query: String) {
        logger.debug { "Buscando negocios con ${'$'}query" }
        toGetBusinesses.execute(query)
            .onSuccess { suggestions = it.businesses }
            .onFailure { error -> logger.error { "Error buscando negocios: ${'$'}{error.message}" } }
    }
}
