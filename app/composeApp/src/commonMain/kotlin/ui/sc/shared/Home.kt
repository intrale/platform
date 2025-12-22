package ui.sc.shared

import ar.com.intrale.appconfig.AppRuntimeConfig
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
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.auth.LOGIN_PATH
import ui.sc.business.REGISTER_NEW_BUSINESS_PATH
import ui.sc.signup.SELECT_SIGNUP_PROFILE_PATH
import ui.th.spacing

const val HOME_PATH = "/home"

class Home : Screen(HOME_PATH) {

    override val messageTitle: MessageKey = MessageKey.home_title

    private val logger = LoggerFactory.default.newLogger<Home>()

    @Composable
    override fun screen() {
        logger.info { "Renderizando Home" }
        ScreenContent()
    }

    @Composable
    private fun ScreenContent() {
        val scrollState = rememberScrollState()
        val isBusinessApp = AppRuntimeConfig.isBusiness
        val loginLabel = Txt(MessageKey.login_button)
        val secondaryLabel = if (isBusinessApp) {
            Txt(MessageKey.register_business)
        } else {
            Txt(MessageKey.signup)
        }
        val headline = if (isBusinessApp) {
            Txt(MessageKey.home_business_headline)
        } else {
            Txt(MessageKey.home_headline)
        }
        val subtitle = if (isBusinessApp) {
            Txt(MessageKey.home_business_subtitle)
        } else {
            Txt(MessageKey.home_subtitle)
        }

        val secondaryDestination = if (isBusinessApp) {
            REGISTER_NEW_BUSINESS_PATH
        } else {
            SELECT_SIGNUP_PROFILE_PATH
        }

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
                    text = headline,
                    style = MaterialTheme.typography.headlineMedium,
                    textAlign = TextAlign.Center
                )

                Text(
                    text = subtitle,
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
                    text = secondaryLabel,
                    onClick = {
                        logger.info { "Navegando a $secondaryDestination" }
                        navigate(secondaryDestination)
                    },
                    modifier = Modifier.fillMaxWidth(),
                    leadingIcon = Icons.Filled.HowToReg,
                    iconContentDescription = secondaryLabel
                )
            }
        }
    }
}
