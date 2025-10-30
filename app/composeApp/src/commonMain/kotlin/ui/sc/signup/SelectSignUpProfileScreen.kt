package ui.sc.signup

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.Button
import ui.sc.shared.Screen
import ui.th.spacing

const val SELECT_SIGNUP_PROFILE_PATH = "/selectSignupProfile"

class SelectSignUpProfileScreen : Screen(SELECT_SIGNUP_PROFILE_PATH) {

    override val messageTitle: MessageKey = MessageKey.signup

    private val logger = LoggerFactory.default.newLogger<SelectSignUpProfileScreen>()

    @Composable
    override fun screen() { screenImpl() }

    @Composable
    private fun screenImpl() {
        logger.debug { "Mostrando SelectSignUpProfileScreen" }
        val platformAdminLabel = Txt(MessageKey.signup_platform_admin)
        val deliveryLabel = Txt(MessageKey.signup_delivery)
        Column(
            Modifier
                .fillMaxWidth()
                .padding(
                    horizontal = MaterialTheme.spacing.x3,
                    vertical = MaterialTheme.spacing.x4
                ),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1_5))
            Button(
                label = platformAdminLabel,
                loading = false,
                enabled = true,
                onClick = {
                    logger.info { "Seleccionado perfil PlatformAdmin" }
                    navigate(SIGNUP_PLATFORM_ADMIN_PATH)
                })
            Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1_5))
            Button(
                label = deliveryLabel,
                loading = false,
                enabled = true,
                onClick = {
                    logger.info { "Seleccionado perfil Delivery" }
                    navigate(SIGNUP_DELIVERY_PATH)
                })
        }
    }
}
