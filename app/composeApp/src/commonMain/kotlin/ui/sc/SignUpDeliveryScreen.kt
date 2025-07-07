package ui.sc

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.jetbrains.compose.resources.stringResource
import ui.cp.Button
import ui.cp.TextField
import ui.rs.Res
import ui.rs.email
import ui.rs.signup_delivery

const val SIGNUP_DELIVERY_PATH = "/signupDelivery"

class SignUpDeliveryScreen : Screen(SIGNUP_DELIVERY_PATH, Res.string.signup_delivery) {
    @Composable
    override fun screen() { screenImpl() }

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun screenImpl(viewModel: SignUpDeliveryViewModel = viewModel { SignUpDeliveryViewModel() }) {
        val coroutine = rememberCoroutineScope()
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            Spacer(modifier = Modifier.size(10.dp))
            TextField(
                Res.string.email,
                value = viewModel.state.email,
                state = viewModel.inputsStates[SignUpDeliveryViewModel.SignUpUIState::email.name]!!,
                onValueChange = { viewModel.state = viewModel.state.copy(email = it) }
            )
            Spacer(modifier = Modifier.size(10.dp))
            Button(label = stringResource(Res.string.signup_delivery)) {
                if (viewModel.isValid()) {
                    coroutine.launch { viewModel.signup() }
                }
            }
        }
    }
}
