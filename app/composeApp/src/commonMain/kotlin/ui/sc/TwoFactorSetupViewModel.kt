package ui.sc

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.DoTwoFactorSetupResult
import asdo.ToDoTwoFactorSetup
import io.konform.validation.Validation
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class TwoFactorSetupViewModel : ViewModel() {

    private val toDoSetup: ToDoTwoFactorSetup by DIManager.di.instance()
    private val logger = LoggerFactory.default.newLogger<TwoFactorSetupViewModel>()

    var state by mutableStateOf(TwoFactorSetupState())
    var loading by mutableStateOf(false)

    data class TwoFactorSetupState(
        val otpAuthUri: String = ""
    )

    override fun getState(): Any = state

    init {
        setupValidation()
        initInputState()
    }

    fun setupValidation() {
        validation = Validation<TwoFactorSetupState> { } as Validation<Any>
    }

    override fun initInputState() {
        inputsStates = mutableMapOf()
    }

    suspend fun setup(): Result<DoTwoFactorSetupResult> {
        logger.debug { "Ejecutando setup de 2FA" }
        return toDoSetup.execute()
    }
}

