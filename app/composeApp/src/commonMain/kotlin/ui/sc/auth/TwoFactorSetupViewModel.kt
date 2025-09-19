package ui.sc.auth

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.auth.DoTwoFactorSetupResult
import asdo.auth.ToDoTwoFactorSetup
import io.konform.validation.Validation
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

class TwoFactorSetupViewModel : ViewModel() {

    private val toDoSetup: ToDoTwoFactorSetup by DIManager.di.instance()
    private val logger = LoggerFactory.default.newLogger<TwoFactorSetupViewModel>()

    var state by mutableStateOf(TwoFactorSetupState())
    var loading by mutableStateOf(false)

    private var secret: String = ""

    data class TwoFactorSetupState(
        val otpAuthUri: String = "",
        val showQr: Boolean = false,
        val issuerAccount: String = "",
        val secretMasked: String = "",
        val deepLinkTried: Boolean = false,
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

    fun onOtpAuthUri(uri: String) {
        val regex = Regex("otpauth://[^/]+/([^?]+)\\?secret=([^&]+)&issuer=([^&]+)")
        val match = regex.find(uri)
        val account = match?.groupValues?.getOrNull(1) ?: ""
        val sec = match?.groupValues?.getOrNull(2) ?: ""
        val issuer = match?.groupValues?.getOrNull(3) ?: ""
        secret = sec
        val masked = if (sec.length > 8) {
            sec.take(4) + "****" + sec.takeLast(4)
        } else sec
        state = state.copy(
            otpAuthUri = uri,
            issuerAccount = "${issuer}:${account}",
            secretMasked = masked
        )
    }

    fun onDeepLinkResult(success: Boolean) {
        state = state.copy(showQr = !success, deepLinkTried = true)
    }

    fun copySecret(): String = secret

    fun copyLink(): String = state.otpAuthUri
}

