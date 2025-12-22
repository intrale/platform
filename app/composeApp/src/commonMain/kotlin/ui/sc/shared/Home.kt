package ui.sc.shared

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.HowToReg
import androidx.compose.material.icons.filled.LockReset
import androidx.compose.material.icons.filled.Login
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import ar.com.intrale.appconfig.AppRuntimeConfig
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.auth.LOGIN_PATH
import ui.sc.auth.PASSWORD_RECOVERY_PATH
import ui.sc.signup.SELECT_SIGNUP_PROFILE_PATH
import ui.sc.signup.SIGNUP_DELIVERY_PATH
import ui.th.spacing

const val HOME_PATH = "/home"

class Home : Screen(HOME_PATH) {

    override val messageTitle: MessageKey = if (AppRuntimeConfig.isDelivery) {
        MessageKey.home_delivery_title
    } else {
        MessageKey.home_title
    }

    private val logger = LoggerFactory.default.newLogger<Home>()

    @Composable
    override fun screen() {
        logger.info { "Renderizando Home" }
        ScreenContent()
    }

    @Composable
    private fun ScreenContent() {
        if (AppRuntimeConfig.isDelivery) {
            DeliveryOnboardingContent()
        } else {
            DefaultHomeContent()
        }
    }

    @Composable
    private fun DefaultHomeContent() {
        val scrollState = rememberScrollState()
        val loginLabel = Txt(MessageKey.login_button)
        val signupLabel = Txt(MessageKey.signup)
        val headline = Txt(MessageKey.home_headline)
        val subtitle = Txt(MessageKey.home_subtitle)

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

    @Composable
    private fun DeliveryOnboardingContent() {
        val scrollState = rememberScrollState()
        val brandTitle = Txt(MessageKey.home_delivery_title)
        val headline = Txt(MessageKey.home_delivery_headline)
        val subtitle = Txt(MessageKey.home_delivery_subtitle)
        val loginLabel = Txt(MessageKey.login_button)
        val signupLabel = Txt(MessageKey.home_delivery_signup_placeholder)
        val passwordRecovery = Txt(MessageKey.password_recovery)

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
                    text = brandTitle,
                    style = MaterialTheme.typography.headlineLarge,
                    textAlign = TextAlign.Center
                )

                Text(
                    text = headline,
                    style = MaterialTheme.typography.headlineMedium,
                    textAlign = TextAlign.Center
                )

                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodyLarge,
                    textAlign = TextAlign.Center,
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
                        logger.info { "Navegando a $SIGNUP_DELIVERY_PATH" }
                        navigate(SIGNUP_DELIVERY_PATH)
                    },
                    modifier = Modifier.fillMaxWidth(),
                    leadingIcon = Icons.Filled.PersonAdd,
                    iconContentDescription = signupLabel
                )

                TextButton(onClick = {
                    logger.info { "Navegando a $PASSWORD_RECOVERY_PATH" }
                    navigate(PASSWORD_RECOVERY_PATH)
                }) {
                    androidx.compose.material3.Icon(
                        imageVector = Icons.Filled.LockReset,
                        contentDescription = passwordRecovery
                    )
                    Spacer(modifier = Modifier.width(MaterialTheme.spacing.x1))
                    Text(text = passwordRecovery)
                }
            }
        }
    }
}
