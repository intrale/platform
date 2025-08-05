package ui.sc

import DIManager
import asdo.ToDoRegisterBusiness
import asdo.ToDoReviewBusinessRegistration
import asdo.ToGetBusinesses
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.konform.validation.Validation
import io.konform.validation.jsonschema.pattern
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class RegisterBusinessViewModel : ViewModel() {
    private val logger = LoggerFactory.default.newLogger<RegisterBusinessViewModel>()
    private val register: ToDoRegisterBusiness by DIManager.di.instance()
    private val review: ToDoReviewBusinessRegistration by DIManager.di.instance()
    private val getBusinesses: ToGetBusinesses by DIManager.di.instance()

    var state by mutableStateOf(UIState())
    var loading by mutableStateOf(false)
    var pending by mutableStateOf(listOf<String>())

    data class UIState(
        val name: String = "",
        val email: String = "",
        val description: String = "",
        val twoFactorCode: String = ""
    )

    override fun getState(): Any = state

    init {
        validation = Validation<UIState> {
            UIState::name required {}
            UIState::email required { pattern(".+@.+\\..+") hint "Correo inválido" }
            UIState::description required {}
        } as Validation<Any>
        initInputState()
    }

    override fun initInputState() {
        inputsStates = mutableMapOf(
            entry(UIState::name.name),
            entry(UIState::email.name),
            entry(UIState::description.name),
            entry(UIState::twoFactorCode.name)
        )
    }

    suspend fun register() =
        register.execute(state.name, state.email, state.description)
            .onSuccess { logger.info { "Negocio registrado: ${'$'}{state.name}" } }
            .onFailure { error -> logger.error { "Error registrando negocio: ${'$'}{error.message}" } }

    suspend fun approve(business: String) =
        review.execute(business, "approved", state.twoFactorCode)
            .onSuccess { logger.info { "Negocio aprobado: ${'$'}business" } }
            .onFailure { error -> logger.error { "Error aprobando ${'$'}business: ${'$'}{error.message}" } }

    suspend fun reject(business: String) =
        review.execute(business, "rejected", state.twoFactorCode)
            .onSuccess { logger.warn { "Negocio rechazado: ${'$'}business" } }
            .onFailure { error -> logger.error { "Error rechazando ${'$'}business: ${'$'}{error.message}" } }

    suspend fun loadPending() {
        logger.debug { "Cargando negocios pendientes" }
        getBusinesses.execute("PENDING")
            .onSuccess {
                pending = it.businesses
                logger.info { "Pendientes obtenidos: ${'$'}{pending.size}" }
            }
            .onFailure { error -> logger.error { "Error cargando pendientes: ${'$'}{error.message}" } }
    }
}
