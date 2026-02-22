package ui.sc.signup

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.shared.Screen
import ui.th.spacing

const val SELECT_SIGNUP_PROFILE_PATH = "/selectSignupProfile"

private data class SignUpProfile(
    val title: MessageKey,
    val description: MessageKey,
    val cta: MessageKey,
    val path: String,
)

class SelectSignUpProfileScreen : Screen(SELECT_SIGNUP_PROFILE_PATH) {

    override val messageTitle: MessageKey = MessageKey.signup

    private val logger = LoggerFactory.default.newLogger<SelectSignUpProfileScreen>()

    @Composable
    override fun screen() { screenImpl() }

    @Composable
    private fun screenImpl() {
        logger.debug { "Mostrando SelectSignUpProfileScreen" }
        val profiles = listOf(
            SignUpProfile(
                title = MessageKey.signup_platform_admin_title,
                description = MessageKey.signup_platform_admin_description,
                cta = MessageKey.signup_platform_admin,
                path = SIGNUP_PLATFORM_ADMIN_PATH,
            ),
            SignUpProfile(
                title = MessageKey.signup_delivery_title,
                description = MessageKey.signup_delivery_description,
                cta = MessageKey.signup_delivery,
                path = SIGNUP_DELIVERY_PATH,
            ),
        )

        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(
                    horizontal = MaterialTheme.spacing.x3,
                    vertical = MaterialTheme.spacing.x4
                ),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
        ) {
            Text(
                text = Txt(MessageKey.signup_select_subtitle),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            profiles.forEach { profile ->
                SignUpProfileCard(
                    profile = profile,
                    onSelect = {
                        logger.info { "Seleccionado perfil: ${profile.path}" }
                        navigate(profile.path)
                    }
                )
            }
        }
    }
}

@Composable
private fun SignUpProfileCard(
    profile: SignUpProfile,
    onSelect: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        ),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1_5)
        ) {
            Text(
                text = Txt(profile.title),
                style = MaterialTheme.typography.titleMedium
            )
            Text(
                text = Txt(profile.description),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(modifier = Modifier.height(MaterialTheme.spacing.x0_5))
            IntralePrimaryButton(
                text = Txt(profile.cta),
                onClick = onSelect,
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
}
