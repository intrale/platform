package ui.sc

import DIManager
import asdo.ToDoReviewBusinessRegistration
import asdo.ToGetBusinesses
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.konform.validation.Validation
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class ReviewBusinessViewModel : ViewModel() {
    private val logger = LoggerFactory.default.newLogger<ReviewBusinessViewModel>()
    private val review: ToDoReviewBusinessRegistration by DIManager.di.instance()
    private val getBusinesses: ToGetBusinesses by DIManager.di.instance()

    var state by mutableStateOf(UIState())
    var loading by mutableStateOf(false)
    var pending by mutableStateOf(listOf<String>())

    data class UIState(
        val twoFactorCode: String = ""
    )

    override fun getState(): Any = state

    init {
        validation = Validation<UIState> {
            UIState::twoFactorCode required {}
        } as Validation<Any>
        initInputState()
    }

    override fun initInputState() {
        inputsStates = mutableMapOf(
            entry(UIState::twoFactorCode.name)
        )
    }

    suspend fun approve(business: String) =
        review.execute(business, "approved", state.twoFactorCode)
            .onSuccess { logger.info { "Negocio aprobado: ${'$'}business" } }
            .onFailure { error -> logger.error { "Error aprobando ${'$'}business: ${'$'}{error.message}" } }

    suspend fun reject(business: String) =
        review.execute(business, "rejected", state.twoFactorCode)
            .onSuccess { logger.warning { "Negocio rechazado: ${'$'}business" } }
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
