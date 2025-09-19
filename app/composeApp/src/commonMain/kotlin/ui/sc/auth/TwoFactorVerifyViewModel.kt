package ui.sc.auth

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.auth.DoTwoFactorVerifyResult
import asdo.auth.ToDoTwoFactorVerify
import io.konform.validation.Validation
import io.konform.validation.jsonschema.minLength
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

class TwoFactorVerifyViewModel : ViewModel() {

    private val toDoVerify: ToDoTwoFactorVerify by DIManager.di.instance()
    private val logger = LoggerFactory.default.newLogger<TwoFactorVerifyViewModel>()

    var state by mutableStateOf(TwoFactorVerifyUIState())
    var loading by mutableStateOf(false)

    data class TwoFactorVerifyUIState(
        val code: String = ""
    )

    override fun getState(): Any = state

    init {
        setupValidation()
        initInputState()
    }

    fun setupValidation() {
        validation = Validation<TwoFactorVerifyUIState> {
            TwoFactorVerifyUIState::code required {
                minLength(6) hint "Debe contener 6 dígitos."
            }
        } as Validation<Any>
    }

    override fun initInputState() {
        inputsStates = mutableMapOf(
            entry(TwoFactorVerifyUIState::code.name)
        )
    }

    suspend fun verify(): Result<DoTwoFactorVerifyResult> {
        logger.debug { "Ejecutando verificación de 2FA" }
        return toDoVerify.execute(state.code)
    }
}

