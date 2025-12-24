package ui.sc.business

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoGraph
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Store
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntraleGhostButton
import ui.cp.buttons.IntraleOutlinedButton
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.auth.LOGIN_PATH
import ui.sc.auth.PASSWORD_RECOVERY_PATH
import ui.sc.shared.Screen
import ui.sc.signup.SELECT_SIGNUP_PROFILE_PATH
import ui.th.spacing

const val BUSINESS_ONBOARDING_PATH = "/business/onboarding"

private data class BusinessValue(
    val title: MessageKey,
    val description: MessageKey,
    val icon: ImageVector,
)

class BusinessOnboardingScreen : Screen(BUSINESS_ONBOARDING_PATH) {

    override val messageTitle: MessageKey = MessageKey.business_onboarding_title

    private val logger = LoggerFactory.default.newLogger<BusinessOnboardingScreen>()

    @Composable
    override fun screen() {
        val scrollState = rememberScrollState()
        val title = Txt(MessageKey.business_onboarding_title)
        val subtitle = Txt(MessageKey.business_onboarding_subtitle)
        val loginLabel = Txt(MessageKey.login_button)
        val signupLabel = Txt(MessageKey.signup)
        val recoveryLabel = Txt(MessageKey.password_recovery)
        val values = listOf(
            BusinessValue(
                title = MessageKey.business_onboarding_value_store_title,
                description = MessageKey.business_onboarding_value_store_description,
                icon = Icons.Default.Store
            ),
            BusinessValue(
                title = MessageKey.business_onboarding_value_team_title,
                description = MessageKey.business_onboarding_value_team_description,
                icon = Icons.Default.Groups
            ),
            BusinessValue(
                title = MessageKey.business_onboarding_value_monitor_title,
                description = MessageKey.business_onboarding_value_monitor_description,
                icon = Icons.Default.AutoGraph
            )
        )

        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(scrollState)
                .padding(
                    horizontal = MaterialTheme.spacing.x3,
                    vertical = MaterialTheme.spacing.x4
                ),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
        ) {
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
            ) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.headlineMedium
                )
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            values.forEach { value ->
                BusinessValueCard(value = value)
            }

            Spacer(modifier = Modifier.height(MaterialTheme.spacing.x1))

            IntralePrimaryButton(
                text = loginLabel,
                onClick = {
                    logger.info { "Navegando al login de negocio" }
                    navigate(LOGIN_PATH)
                },
                modifier = Modifier.fillMaxWidth()
            )

            IntraleOutlinedButton(
                text = signupLabel,
                onClick = {
                    logger.info { "Navegando al registro/selección de perfil" }
                    navigate(SELECT_SIGNUP_PROFILE_PATH)
                },
                modifier = Modifier.fillMaxWidth()
            )

            IntraleGhostButton(
                text = recoveryLabel,
                onClick = {
                    logger.info { "Navegando a recuperación de contraseña" }
                    navigate(PASSWORD_RECOVERY_PATH)
                },
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
}

@Composable
private fun BusinessValueCard(value: BusinessValue) {
    val title = Txt(value.title)
    val description = Txt(value.description)

    Surface(
        shape = MaterialTheme.shapes.large,
        tonalElevation = MaterialTheme.spacing.x0_5,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
        ) {
            Surface(
                shape = MaterialTheme.shapes.medium,
                color = MaterialTheme.colorScheme.primary.copy(alpha = 0.12f),
                tonalElevation = 0.dp
            ) {
                Icon(
                    imageVector = value.icon,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier
                        .padding(MaterialTheme.spacing.x2)
                        .size(MaterialTheme.spacing.x4)
                )
            }

            Column(
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
            ) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleMedium
                )
                Text(
                    text = description,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}
