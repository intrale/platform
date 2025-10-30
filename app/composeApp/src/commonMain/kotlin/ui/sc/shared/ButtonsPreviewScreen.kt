package ui.sc.shared

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.HowToReg
import androidx.compose.material.icons.filled.Login
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.th.spacing

const val BUTTONS_PREVIEW_PATH = "/demo/buttons"

class ButtonsPreviewScreen : Screen(BUTTONS_PREVIEW_PATH) {

    override val messageTitle: MessageKey = MessageKey.buttons_preview_title

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
                text = Txt(MessageKey.buttons_preview_title),
                style = MaterialTheme.typography.headlineMedium
            )

            IntralePrimaryButton(
                text = Txt(MessageKey.buttons_preview_login),
                onClick = { logger.info { "Vista previa: ingresar" } },
                leadingIcon = Icons.Filled.Login
            )

            IntralePrimaryButton(
                text = Txt(MessageKey.buttons_preview_signup),
                onClick = { logger.info { "Vista previa: registrarme (loading)" } },
                leadingIcon = Icons.Filled.HowToReg,
                loading = true
            )

            IntralePrimaryButton(
                text = Txt(MessageKey.buttons_preview_logout),
                onClick = { logger.info { "Vista previa: salir" } },
                leadingIcon = Icons.Filled.Logout,
                enabled = false
            )
        }
    }
}
