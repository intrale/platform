package ui.sc

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.jetbrains.compose.resources.stringResource
import ui.cp.Button
import ui.rs.Res
import ui.rs.signup
import ui.rs.signup_platform_admin
import ui.rs.signup_delivery
import ui.rs.signup_saler

const val SELECT_SIGNUP_PROFILE_PATH = "/selectSignupProfile"

class SelectSignUpProfileScreen : Screen(SELECT_SIGNUP_PROFILE_PATH, Res.string.signup) {
    @Composable
    override fun screen() { screenImpl() }

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun screenImpl() {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            Spacer(modifier = Modifier.size(10.dp))
            Button(
                label = stringResource(Res.string.signup_platform_admin),
                loading = false,
                enabled = true,
                onClick = {
                    navigate(SIGNUP_PLATFORM_ADMIN_PATH)
                })
            Spacer(modifier = Modifier.size(10.dp))
            Button(
                label = stringResource(Res.string.signup_delivery),
                loading = false,
                enabled = true,
                onClick = {
                    navigate(SIGNUP_DELIVERY_PATH)
                })
            Spacer(modifier = Modifier.size(10.dp))
            Button(
                label = stringResource(Res.string.signup_saler),
                loading = false,
                enabled = true,
                onClick = {
                    navigate(SIGNUP_SALER_PATH)
                })
        }
    }
}
