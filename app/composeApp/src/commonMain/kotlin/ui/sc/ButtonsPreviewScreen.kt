package ui.sc

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import org.jetbrains.compose.resources.stringResource
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.IntralePrimaryButton
import ui.rs.Res
import ui.rs.buttons_preview
import ui.rs.login
import ui.rs.logout
import ui.rs.signup
import ui.th.spacing

const val BUTTONS_PREVIEW_PATH = "/demo/buttons"

class ButtonsPreviewScreen : Screen(BUTTONS_PREVIEW_PATH, Res.string.buttons_preview) {

    private val logger = LoggerFactory.default.newLogger<ButtonsPreviewScreen>()

    @Composable
    override fun screen() {
        ScreenContent()
    }

    @Composable
    private fun ScreenContent() {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(
                    horizontal = MaterialTheme.spacing.x3,
                    vertical = MaterialTheme.spacing.x4
                ),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(
                text = stringResource(Res.string.buttons_preview),
                style = MaterialTheme.typography.headlineMedium
            )

            IntralePrimaryButton(
                text = stringResource(Res.string.login),
                iconAsset = "ic_login.svg",
                onClick = { logger.info { "Vista previa: ingresar" } }
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
}
