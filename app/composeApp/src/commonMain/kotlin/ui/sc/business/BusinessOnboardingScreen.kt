package ui.sc.business

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ListAlt
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Store
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.auth.LOGIN_PATH
import ui.sc.auth.PASSWORD_RECOVERY_PATH
import ui.sc.shared.Screen
import ui.sc.signup.SELECT_SIGNUP_PROFILE_PATH
import ui.th.elevations
import ui.th.spacing

const val BUSINESS_ONBOARDING_PATH = "/business/onboarding"

class BusinessOnboardingScreen : Screen(BUSINESS_ONBOARDING_PATH) {

    override val messageTitle: MessageKey = MessageKey.business_onboarding_title

    private val logger = LoggerFactory.default.newLogger<BusinessOnboardingScreen>()

    @Composable
    override fun screen() {
        logger.info { "Renderizando onboarding de negocio" }
        ScreenContent()
    }

    @Composable
    private fun ScreenContent() {
        val scrollState = rememberScrollState()
        val headline = Txt(MessageKey.business_onboarding_headline)
        val subtitle = Txt(MessageKey.business_onboarding_subtitle)
        val loginLabel = Txt(MessageKey.business_onboarding_login_cta)
        val signupLabel = Txt(MessageKey.business_onboarding_signup_cta)
        val recoveryLabel = Txt(MessageKey.business_onboarding_recovery_cta)

        val valueBlocks = listOf(
            BusinessValueBlock(
                icon = Icons.Default.Store,
                title = Txt(MessageKey.business_onboarding_value_store_title),
                description = Txt(MessageKey.business_onboarding_value_store_description)
            ),
            BusinessValueBlock(
                icon = Icons.Default.Groups,
                title = Txt(MessageKey.business_onboarding_value_team_title),
                description = Txt(MessageKey.business_onboarding_value_team_description)
            ),
            BusinessValueBlock(
                icon = Icons.AutoMirrored.Filled.ListAlt,
                title = Txt(MessageKey.business_onboarding_value_orders_title),
                description = Txt(MessageKey.business_onboarding_value_orders_description)
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
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3),
            horizontalAlignment = Alignment.CenterHorizontally
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

            valueBlocks.forEach { block ->
                Surface(
                    modifier = Modifier.fillMaxWidth(),
                    tonalElevation = MaterialTheme.elevations.level1,
                    shape = MaterialTheme.shapes.large
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(MaterialTheme.spacing.x3),
                        horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(
                            imageVector = block.icon,
                            contentDescription = block.title,
                            tint = MaterialTheme.colorScheme.primary
                        )
                        Column(
                            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
                        ) {
                            Text(
                                text = block.title,
                                style = MaterialTheme.typography.titleMedium
                            )
                            Text(
                                text = block.description,
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                }
            }

            IntralePrimaryButton(
                text = loginLabel,
                onClick = { navigate(LOGIN_PATH) },
                modifier = Modifier.fillMaxWidth()
            )

            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                TextButton(onClick = { navigate(SELECT_SIGNUP_PROFILE_PATH) }) {
                    Text(text = signupLabel)
                }
                TextButton(onClick = { navigate(PASSWORD_RECOVERY_PATH) }) {
                    Text(text = recoveryLabel)
                }
            }
        }
    }
}

private data class BusinessValueBlock(
    val icon: ImageVector,
    val title: String,
    val description: String
)
