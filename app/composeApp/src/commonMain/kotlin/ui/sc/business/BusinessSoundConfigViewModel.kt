package ui.sc.business

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.business.OrderSoundConfig
import asdo.business.OrderSoundType
import io.konform.validation.Validation
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

data class BusinessSoundConfigUIState(
    val enabled: Boolean = true,
    val volume: Float = OrderSoundConfig().volume,
    val vibrationEnabled: Boolean = true,
    val soundType: OrderSoundType = OrderSoundType.DEFAULT,
    val isMuted: Boolean = false,
    val repeatIntervalSeconds: Int = OrderSoundConfig.DEFAULT_REPEAT_INTERVAL_SECONDS
)

class BusinessSoundConfigViewModel : ViewModel() {

    private val logger = LoggerFactory.default.newLogger<BusinessSoundConfigViewModel>()

    var state by mutableStateOf(BusinessSoundConfigUIState())
        private set

    override fun getState(): Any = state
    override fun initInputState() {}

    init {
        @Suppress("UNCHECKED_CAST")
        validation = Validation<BusinessSoundConfigUIState> { } as Validation<Any>
        initInputState()
        loadFromStore()
    }

    private fun loadFromStore() {
        val config = BusinessOrderNotificationStore.config.value
        state = BusinessSoundConfigUIState(
            enabled = config.enabled,
            volume = config.volume,
            vibrationEnabled = config.vibrationEnabled,
            soundType = config.soundType,
            isMuted = config.isMuted,
            repeatIntervalSeconds = config.repeatIntervalSeconds
        )
    }

    fun toggleEnabled() {
        state = state.copy(enabled = !state.enabled)
        syncToStore()
        logger.info { "Sonido ${if (state.enabled) "activado" else "desactivado"}" }
    }

    fun updateVolume(volume: Float) {
        state = state.copy(
            volume = volume.coerceIn(OrderSoundConfig.MIN_VOLUME, OrderSoundConfig.MAX_VOLUME)
        )
        syncToStore()
    }

    fun selectSoundType(soundType: OrderSoundType) {
        state = state.copy(soundType = soundType)
        syncToStore()
        logger.info { "Tipo de sonido: $soundType" }
    }

    fun toggleVibration() {
        state = state.copy(vibrationEnabled = !state.vibrationEnabled)
        syncToStore()
    }

    fun toggleMute() {
        state = state.copy(isMuted = !state.isMuted)
        syncToStore()
        logger.info { "Sonido ${if (state.isMuted) "silenciado" else "activado"}" }
    }

    private fun syncToStore() {
        BusinessOrderNotificationStore.updateConfig(
            OrderSoundConfig(
                enabled = state.enabled,
                volume = state.volume,
                vibrationEnabled = state.vibrationEnabled,
                repeatIntervalSeconds = state.repeatIntervalSeconds,
                soundType = state.soundType,
                isMuted = state.isMuted
            )
        )
    }
}
