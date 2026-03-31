@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package ui.sc.business

import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.lifecycle.viewmodel.compose.viewModel
import asdo.business.OrderSoundConfig
import asdo.business.OrderSoundType
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.Screen
import ui.th.spacing

const val BUSINESS_SOUND_CONFIG_PATH = "/business/sound-config"

class BusinessSoundConfigScreen : Screen(BUSINESS_SOUND_CONFIG_PATH) {

    override val messageTitle: MessageKey = MessageKey.business_notification_sound_config_title

    private val logger = LoggerFactory.default.newLogger<BusinessSoundConfigScreen>()

    @Composable
    override fun screen() {
        logger.info { "Renderizando pantalla de configuracion de sonido" }
        ScreenContent()
    }

    @Composable
    private fun ScreenContent(
        viewModel: BusinessSoundConfigViewModel = viewModel { BusinessSoundConfigViewModel() }
    ) {
        val state = viewModel.state

        Scaffold { padding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(horizontal = MaterialTheme.spacing.x4)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x4)
            ) {
                Spacer(modifier = Modifier.height(MaterialTheme.spacing.x4))

                Text(
                    text = Txt(MessageKey.business_notification_sound_config_title),
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold
                )

                // Activar/desactivar
                SoundToggleCard(
                    enabled = state.enabled,
                    onToggle = { viewModel.toggleEnabled() }
                )

                if (state.enabled) {
                    // Volumen
                    VolumeCard(
                        volume = state.volume,
                        onVolumeChange = { viewModel.updateVolume(it) }
                    )

                    // Tipo de sonido
                    SoundTypeCard(
                        selectedType = state.soundType,
                        onSelectType = { viewModel.selectSoundType(it) }
                    )

                    // Vibracion
                    VibrationCard(
                        enabled = state.vibrationEnabled,
                        onToggle = { viewModel.toggleVibration() }
                    )

                    // Silenciar temporalmente
                    MuteCard(
                        isMuted = state.isMuted,
                        onToggle = { viewModel.toggleMute() }
                    )

                    // Info de repeticion
                    Text(
                        text = Txt(
                            MessageKey.business_notification_sound_repeat_info,
                            mapOf("seconds" to state.repeatIntervalSeconds.toString())
                        ),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }

                Spacer(modifier = Modifier.height(MaterialTheme.spacing.x4))
            }
        }
    }
}

@Composable
private fun SoundToggleCard(enabled: Boolean, onToggle: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x4),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column {
                Text(
                    text = Txt(MessageKey.business_notification_sound_title),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    text = if (enabled) Txt(MessageKey.business_notification_sound_enabled)
                    else Txt(MessageKey.business_notification_sound_disabled),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Switch(checked = enabled, onCheckedChange = { onToggle() })
        }
    }
}

@Composable
private fun VolumeCard(volume: Float, onVolumeChange: (Float) -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x4)
        ) {
            Text(
                text = Txt(MessageKey.business_notification_sound_volume),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold
            )
            Spacer(modifier = Modifier.height(MaterialTheme.spacing.x2))
            @Suppress("MagicNumber")
            val volumePercent = (volume * 100).toInt()
            Text(
                text = "$volumePercent%",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Slider(
                value = volume,
                onValueChange = onVolumeChange,
                valueRange = OrderSoundConfig.MIN_VOLUME..OrderSoundConfig.MAX_VOLUME
            )
        }
    }
}

@Composable
private fun SoundTypeCard(
    selectedType: OrderSoundType,
    onSelectType: (OrderSoundType) -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x4),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
        ) {
            Text(
                text = Txt(MessageKey.business_notification_sound_type),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold
            )
            Row(horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)) {
                OrderSoundType.entries.forEach { type ->
                    FilterChip(
                        selected = selectedType == type,
                        onClick = { onSelectType(type) },
                        label = { Text(type.toLabel()) }
                    )
                }
            }
        }
    }
}

@Composable
private fun OrderSoundType.toLabel(): String = when (this) {
    OrderSoundType.DEFAULT -> Txt(MessageKey.business_notification_sound_type_default)
    OrderSoundType.BELL -> Txt(MessageKey.business_notification_sound_type_bell)
    OrderSoundType.CHIME -> Txt(MessageKey.business_notification_sound_type_chime)
    OrderSoundType.URGENT -> Txt(MessageKey.business_notification_sound_type_urgent)
}

@Composable
private fun VibrationCard(enabled: Boolean, onToggle: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x4),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = Txt(MessageKey.business_notification_sound_vibration),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold
            )
            Switch(checked = enabled, onCheckedChange = { onToggle() })
        }
    }
}

@Composable
private fun MuteCard(isMuted: Boolean, onToggle: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (isMuted) MaterialTheme.colorScheme.errorContainer
            else MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x4),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column {
                Text(
                    text = if (isMuted) Txt(MessageKey.business_notification_sound_muted)
                    else Txt(MessageKey.business_notification_sound_unmuted),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold
                )
            }
            Switch(
                checked = !isMuted,
                onCheckedChange = { onToggle() }
            )
        }
    }
}
