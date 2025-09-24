package ui.sc.shared

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.HowToReg
import androidx.compose.material.icons.filled.Login
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.rs.Res
import ui.rs.home
import ui.rs.home_headline
import ui.rs.home_subtitle
import ui.rs.login
import ui.rs.signup
import ui.th.spacing
import ui.sc.auth.LOGIN_PATH
import ui.sc.signup.SELECT_SIGNUP_PROFILE_PATH
import ui.util.RES_ERROR_PREFIX
import ui.util.fb
import ui.util.resString

const val HOME_PATH = "/home"

class Home : Screen(HOME_PATH, Res.string.home) {

    private val logger = LoggerFactory.default.newLogger<Home>()

    @Composable
    override fun screen() {
        logger.info { "Renderizando Home" }
        ScreenContent()
    }

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun ScreenContent() {
        val scrollState = rememberScrollState()
        val loginLabel = resString(
            composeId = Res.string.login,
            fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Iniciar sesion"),
        )
        val signupLabel = resString(
            composeId = Res.string.signup,
            fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Crear cuenta"),
        )

        Box(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(scrollState)
                .padding(
                    horizontal = MaterialTheme.spacing.x4,
                    vertical = MaterialTheme.spacing.x6
                )
        ) {
            Column(
                modifier = Modifier
                    .align(Alignment.Center)
                    .fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
            ) {
                Text(
                    text = resString(
                        composeId = Res.string.home_headline,
                        fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Mensaje principal"),
                    ),
                    style = MaterialTheme.typography.headlineMedium,
                    textAlign = TextAlign.Center
                )

                Text(
                    text = resString(
                        composeId = Res.string.home_subtitle,
                        fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Detalle introductorio"),
                    ),
                    style = MaterialTheme.typography.bodyLarge,
                    textAlign = TextAlign.Center
                )

                Spacer(modifier = Modifier.height(MaterialTheme.spacing.x2))

                IntralePrimaryButton(
                    text = loginLabel,
                    onClick = {
                        logger.info { "Navegando a $LOGIN_PATH" }
                        navigate(LOGIN_PATH)
                    },
                    modifier = Modifier.fillMaxWidth(),
                    leadingIcon = Icons.Filled.Login,
                    iconContentDescription = loginLabel
                )

                IntralePrimaryButton(
                    text = signupLabel,
                    onClick = {
                        logger.info { "Navegando a $SELECT_SIGNUP_PROFILE_PATH" }
                        navigate(SELECT_SIGNUP_PROFILE_PATH)
                    },
                    modifier = Modifier.fillMaxWidth(),
                    leadingIcon = Icons.Filled.HowToReg,
                    iconContentDescription = signupLabel
                )
            }
        }
    }
}
