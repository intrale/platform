package ui.sc

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import ar.com.intrale.BuildKonfig
import org.jetbrains.compose.resources.stringResource
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import diagnostics.FramePerformanceDiagnostics
import diagnostics.FramePerformanceSnapshot
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import ui.cp.IntralePrimaryButton
import ui.cp.IntraleButtonDefaults
import ui.cp.IntraleButtonStressTestState
import ui.rs.Res
import ui.rs.buttons_preview
import ui.rs.login
import ui.rs.logout
import ui.rs.signup

const val BUTTONS_PREVIEW_PATH = "/demo/buttons"

class ButtonsPreviewScreen : Screen(BUTTONS_PREVIEW_PATH, Res.string.buttons_preview) {

    private val logger = LoggerFactory.default.newLogger<ButtonsPreviewScreen>()

    @Composable
    override fun screen() {
        ScreenContent()
    }

    @Composable
    private fun ScreenContent() {
        val stressControlsEnabled = BuildKonfig.ENABLE_BUTTON_STRESS_TEST
        val jankSnapshot by FramePerformanceDiagnostics.snapshot.collectAsState()
        var stressTestEnabled by rememberSaveable { mutableStateOf(false) }
        var stressTick by remember { mutableStateOf(0) }

        LaunchedEffect(stressTestEnabled) {
            if (stressTestEnabled) {
                while (isActive) {
                    stressTick += 1
                    delay(IntraleButtonDefaults.STRESS_TAP_PERIOD_MILLIS)
                }
            }
        }

        val stressState = if (stressControlsEnabled) {
            IntraleButtonStressTestState(
                active = stressTestEnabled,
                tick = stressTick
            )
        } else {
            IntraleButtonStressTestState.Disabled
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 24.dp, vertical = 32.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(
                text = stringResource(Res.string.buttons_preview),
                style = MaterialTheme.typography.headlineSmall
            )

            if (stressControlsEnabled) {
                StressTestControls(
                    stressEnabled = stressTestEnabled,
                    snapshot = jankSnapshot,
                    onToggle = { enabled ->
                        stressTestEnabled = enabled
                        stressTick = 0
                        FramePerformanceDiagnostics.reset()
                    }
                )
            }

            IntralePrimaryButton(
                text = stringResource(Res.string.login),
                iconAsset = "ic_login.svg",
                onClick = { logger.info { "Vista previa: ingresar" } },
                stressTestState = stressState
            )

            IntralePrimaryButton(
                text = stringResource(Res.string.signup),
                iconAsset = "ic_register.svg",
                loading = true,
                onClick = { logger.info { "Vista previa: registrarme (loading)" } }
            )

            IntralePrimaryButton(
                text = stringResource(Res.string.logout),
                iconAsset = "ic_logout.svg",
                enabled = false,
                onClick = { logger.info { "Vista previa: salir" } }
            )
        }
    }

    @Composable
    private fun StressTestControls(
        stressEnabled: Boolean,
        snapshot: FramePerformanceSnapshot,
        onToggle: (Boolean) -> Unit
    ) {
        Column(
            verticalArrangement = Arrangement.spacedBy(8.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "Stress test automático",
                    style = MaterialTheme.typography.titleSmall
                )
                Spacer(modifier = Modifier.width(12.dp))
                Switch(
                    checked = stressEnabled,
                    onCheckedChange = onToggle
                )
            }
            Text(
                text = "Frames janky: ${snapshot.jankFrames} / ${snapshot.totalFrames}",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Text(
                text = "Habilitá este modo solo en builds de prueba para medir recomposiciones con Layout Inspector.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}
