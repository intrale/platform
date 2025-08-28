package ui.sc

import DIManager
import ar.com.intrale.BuildKonfig
import asdo.ToDoReviewJoinBusiness
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.konform.validation.Validation
import io.konform.validation.jsonschema.pattern
import io.konform.validation.required
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class ReviewJoinBusinessViewModel : ViewModel() {
    private val logger = LoggerFactory.default.newLogger<ReviewJoinBusinessViewModel>()
    private val reviewJoin: ToDoReviewJoinBusiness by DIManager.di.instance()

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
