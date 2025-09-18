package ui.sc

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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.jetbrains.compose.resources.stringResource
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.IntralePrimaryButton
import ui.rs.Res
import ui.rs.home
import ui.rs.home_headline
import ui.rs.home_subtitle
import ui.rs.login
import ui.rs.signup
import ui.th.spacing

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
        val loginLabel = stringResource(Res.string.login)
        val signupLabel = stringResource(Res.string.signup)

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
                    text = stringResource(Res.string.home_headline),
                    style = MaterialTheme.typography.headlineMedium,
                    textAlign = TextAlign.Center
                )

                Text(
                    text = stringResource(Res.string.home_subtitle),
                    style = MaterialTheme.typography.bodyLarge,
                    textAlign = TextAlign.Center
                )

                Spacer(modifier = Modifier.height(MaterialTheme.spacing.x2))

                IntralePrimaryButton(
                    text = loginLabel,
                    iconAsset = "ic_login.svg",
                    iconContentDescription = loginLabel,
                    modifier = Modifier.fillMaxWidth(),
                    onClick = {
                        logger.info { "Navegando a $LOGIN_PATH" }
                        navigate(LOGIN_PATH)
                    }
                )

                IntralePrimaryButton(
                    text = signupLabel,
                    iconAsset = "ic_register.svg",
                    iconContentDescription = signupLabel,
                    modifier = Modifier.fillMaxWidth(),
                    onClick = {
                        logger.info { "Navegando a $SELECT_SIGNUP_PROFILE_PATH" }
                        navigate(SELECT_SIGNUP_PROFILE_PATH)
                    }
                )
            }
        }
    }
}
