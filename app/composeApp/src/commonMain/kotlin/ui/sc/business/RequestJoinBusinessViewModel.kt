package ui.sc.business

import DIManager
import asdo.business.ToDoRequestJoinBusiness
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.konform.validation.Validation
import io.konform.validation.required
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

class RequestJoinBusinessViewModel(
    private val requestJoin: ToDoRequestJoinBusiness = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {
    private val logger = loggerFactory.newLogger<RequestJoinBusinessViewModel>()

    var state by mutableStateOf(UIState())
    var loading by mutableStateOf(false)

    data class UIState(
        val business: String = "",
        val resultState: String? = null
    )

    override fun getState(): Any = state

    init {
        validation = Validation<UIState> {
            UIState::business required {}
        } as Validation<Any>
        initInputState()
    }

    override fun initInputState() {
        inputsStates = mutableMapOf(
            entry(UIState::business.name)
        )
    }

    suspend fun request() =
        requestJoin.execute(state.business)
            .onSuccess { state = state.copy(resultState = it.state) }
            .onFailure { error -> logger.error { "Error al solicitar unión: ${error.message}" } }
}
