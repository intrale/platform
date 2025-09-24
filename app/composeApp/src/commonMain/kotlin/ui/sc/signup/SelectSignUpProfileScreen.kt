package ui.sc.signup

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.material3.MaterialTheme
import org.jetbrains.compose.resources.ExperimentalResourceApi
import ui.cp.buttons.Button
import ui.rs.Res
import ui.rs.signup
import ui.rs.signup_delivery
import ui.rs.signup_platform_admin
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.th.spacing
import ui.sc.shared.Screen
import ui.util.RES_ERROR_PREFIX
import ui.util.resStringOr

const val SELECT_SIGNUP_PROFILE_PATH = "/selectSignupProfile"

class SelectSignUpProfileScreen : Screen(SELECT_SIGNUP_PROFILE_PATH, Res.string.signup) {
    private val logger = LoggerFactory.default.newLogger<SelectSignUpProfileScreen>()
    @Composable
    override fun screen() { screenImpl() }

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun screenImpl() {
        logger.debug { "Mostrando SelectSignUpProfileScreen" }
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
                label = resStringOr(
                    Res.string.signup_platform_admin,
                    RES_ERROR_PREFIX + "Registrar administrador"
                ),
                loading = false,
                enabled = true,
                onClick = {
                    logger.info { "Seleccionado perfil PlatformAdmin" }
                    navigate(SIGNUP_PLATFORM_ADMIN_PATH)
                })
            Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1_5))
            Button(
                label = resStringOr(
                    Res.string.signup_delivery,
                    RES_ERROR_PREFIX + "Registrar repartidor"
                ),
                loading = false,
                enabled = true,
                onClick = {
                    logger.info { "Seleccionado perfil Delivery" }
                    navigate(SIGNUP_DELIVERY_PATH)
                })
        }
    }
}
