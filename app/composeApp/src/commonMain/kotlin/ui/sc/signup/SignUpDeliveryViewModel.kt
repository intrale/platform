package ui.sc.signup

import DIManager
import asdo.signup.DoSignUpResult
import asdo.signup.ToDoSignUpDelivery
import asdo.business.ToGetBusinesses
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.konform.validation.Validation
import io.konform.validation.jsonschema.pattern
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.business.BusinessView
import ui.sc.shared.ViewModel

class SignUpDeliveryViewModel(
    private val toDoSignUpDelivery: ToDoSignUpDelivery = DIManager.di.direct.instance(),
    private val toGetBusinesses: ToGetBusinesses = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {
    private val logger = loggerFactory.newLogger<SignUpDeliveryViewModel>()

    var state by mutableStateOf(SignUpUIState())
    var suggestions by mutableStateOf(listOf<BusinessView>())
    var loading by mutableStateOf(false)
    data class SignUpUIState(val email: String = "", val businessPublicId: String = "", val businessName: String = "")
    override fun getState(): Any = state

    init {
        validation = Validation<SignUpUIState> {
            SignUpUIState::email required {
                pattern(".+@.+\\..+") hint "Correo inválido"
            }
            SignUpUIState::businessPublicId required {}
        } as Validation<Any>
        initInputState()
    }

    override fun initInputState() {
        inputsStates = mutableMapOf(
            entry(SignUpUIState::email.name),
            entry(SignUpUIState::businessPublicId.name),
            entry(SignUpUIState::businessName.name))
    }

    suspend fun signup(): Result<DoSignUpResult> =
        toDoSignUpDelivery.execute(state.businessPublicId, state.email)
            .onSuccess { logger.info { "Delivery registrado: ${'$'}{state.email}" } }
            .onFailure { error -> logger.error { "Error registro delivery: ${'$'}{error.message}" } }

    suspend fun searchBusinesses(query: String) {
        logger.debug { "Buscando negocios con ${'$'}query" }
        toGetBusinesses.execute(query = query)
            .onSuccess { suggestions = it.businesses.map { biz -> BusinessView(biz.publicId, biz.name )} }
            .onFailure { error -> logger.error { "Error buscando negocios: ${'$'}{error.message}" } }
    }
}
