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
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.rs.Res
import ui.rs.buttons_preview
import ui.rs.login
import ui.rs.logout
import ui.rs.signup
import ui.th.spacing
import ui.util.RES_ERROR_PREFIX
import ui.util.resStringOr

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
                text = resStringOr(
                    Res.string.buttons_preview,
                    RES_ERROR_PREFIX + "Vista previa de botones"
                ),
                style = MaterialTheme.typography.headlineMedium
            )

            IntralePrimaryButton(
                text = resStringOr(
                    Res.string.login,
                    RES_ERROR_PREFIX + "Iniciar sesión"
                ),
                onClick = { logger.info { "Vista previa: ingresar" } },
                leadingIcon = Icons.Filled.Login
            )

            IntralePrimaryButton(
                text = resStringOr(
                    Res.string.signup,
                    RES_ERROR_PREFIX + "Crear cuenta"
                ),
                onClick = { logger.info { "Vista previa: registrarme (loading)" } },
                leadingIcon = Icons.Filled.HowToReg,
                loading = true
            )

            IntralePrimaryButton(
                text = resStringOr(
                    Res.string.logout,
                    RES_ERROR_PREFIX + "Cerrar sesión"
                ),
                onClick = { logger.info { "Vista previa: salir" } },
                leadingIcon = Icons.Filled.Logout,
                enabled = false
            )
        }
    }
}
