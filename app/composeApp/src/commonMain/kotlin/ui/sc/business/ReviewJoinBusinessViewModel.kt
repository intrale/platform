package ui.sc.business

import DIManager
import ar.com.intrale.BuildKonfig
import asdo.business.ToDoReviewJoinBusiness
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.konform.validation.Validation
import io.konform.validation.jsonschema.pattern
import io.konform.validation.required
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

class ReviewJoinBusinessViewModel(
    private val reviewJoin: ToDoReviewJoinBusiness = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {
    private val logger = loggerFactory.newLogger<ReviewJoinBusinessViewModel>()

    var state by mutableStateOf(UIState())
    var loading by mutableStateOf(false)

    data class UIState(
        val email: String = ""
    )

    override fun getState(): Any = state

    init {
        validation = Validation<UIState> {
            UIState::email required { pattern(".+@.+\\..+") hint "Correo inválido" }
        } as Validation<Any>
        initInputState()
    }

    override fun initInputState() {
        inputsStates = mutableMapOf(
            entry(UIState::email.name)
        )
    }

    suspend fun approve() =
        reviewJoin.execute(BuildKonfig.BUSINESS, state.email, "APPROVED")
            .onFailure { error -> logger.error { "Error aprobando solicitud: ${error.message}" } }

    suspend fun reject() =
        reviewJoin.execute(BuildKonfig.BUSINESS, state.email, "REJECTED")
            .onFailure { error -> logger.error { "Error rechazando solicitud: ${error.message}" } }
}
