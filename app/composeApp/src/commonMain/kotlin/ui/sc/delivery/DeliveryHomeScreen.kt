package ui.sc.delivery

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Login
import androidx.compose.material.icons.outlined.PersonAdd
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import ui.sc.auth.PASSWORD_RECOVERY_PATH
import ui.sc.shared.Screen
import ui.sc.signup.SIGNUP_DELIVERY_PATH
import ui.th.spacing

const val DELIVERY_HOME_PATH = "/delivery/home"

class DeliveryHomeScreen : Screen(DELIVERY_HOME_PATH) {

    override val messageTitle: MessageKey = MessageKey.delivery_home_title

    private val logger = LoggerFactory.default.newLogger<DeliveryHomeScreen>()

    @Composable
    override fun screen() {
        val scrollState = rememberScrollState()
        val loginLabel = Txt(MessageKey.login_button)
        val requestAccessLabel = Txt(MessageKey.delivery_request_access)
        val recoveryLabel = Txt(MessageKey.password_recovery)
        val headline = Txt(MessageKey.delivery_home_headline)
        val subtitle = Txt(MessageKey.delivery_home_subtitle)

        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(scrollState)
                .padding(
                    horizontal = MaterialTheme.spacing.x4,
                    vertical = MaterialTheme.spacing.x6
                ),
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
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center
            )

            Spacer(modifier = Modifier.height(MaterialTheme.spacing.x2))

            IntralePrimaryButton(
                text = loginLabel,
                onClick = {
                    logger.info { "[Delivery][Onboarding] Navegando a login" }
                    navigate(LOGIN_PATH)
                },
                modifier = Modifier.fillMaxWidth(),
                leadingIcon = Icons.Filled.Login,
                iconContentDescription = loginLabel
            )

            IntralePrimaryButton(
                text = requestAccessLabel,
                onClick = {
                    logger.info { "[Delivery][Onboarding] Navegando a solicitud de alta" }
                    navigate(SIGNUP_DELIVERY_PATH)
                },
                modifier = Modifier.fillMaxWidth(),
                leadingIcon = Icons.Outlined.PersonAdd,
                iconContentDescription = requestAccessLabel
            )

            TextButton(onClick = {
                logger.info { "[Delivery][Onboarding] Navegando a recuperación de contraseña" }
                navigate(PASSWORD_RECOVERY_PATH)
            }) {
                Text(text = recoveryLabel)
            }
        }
    }
}
