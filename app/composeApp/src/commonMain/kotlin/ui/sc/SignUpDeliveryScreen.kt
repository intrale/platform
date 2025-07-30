package ui.sc

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Scaffold
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.jetbrains.compose.resources.stringResource
import ui.cp.Button
import ui.cp.TextField
import ui.rs.Res
import ui.rs.email
import ui.rs.signup_delivery
import ui.sc.callService
import LOGIN_PATH
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import ui.rs.business

const val SIGNUP_DELIVERY_PATH = "/signupDelivery"

class SignUpDeliveryScreen : Screen(SIGNUP_DELIVERY_PATH, Res.string.signup_delivery) {
    @Composable
    override fun screen() { screenImpl() }

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun screenImpl(viewModel: SignUpDeliveryViewModel = viewModel { SignUpDeliveryViewModel() }) {
        val coroutine = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Spacer(modifier = Modifier.size(10.dp))
            TextField(
                Res.string.email,
                value = viewModel.state.email,
                state = viewModel.inputsStates[SignUpDeliveryViewModel.SignUpUIState::email.name]!!,
                onValueChange = { viewModel.state = viewModel.state.copy(email = it) }
            )
            Spacer(modifier = Modifier.size(10.dp))
            var expanded by remember { mutableStateOf(false) }
            TextField(
                Res.string.business,
                value = viewModel.state.business,
                state = viewModel.inputsStates[SignUpDeliveryViewModel.SignUpUIState::business.name]!!,
                onValueChange = {
                    viewModel.state = viewModel.state.copy(business = it)
                    coroutine.launch { viewModel.searchBusinesses(it) }
                    expanded = true
                }
            )
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                viewModel.suggestions.forEach { name ->
                    DropdownMenuItem(text = { androidx.compose.material3.Text(name) }, onClick = {
                        viewModel.state = viewModel.state.copy(business = name)
                        expanded = false
                    })
                }
            }
            Spacer(modifier = Modifier.size(10.dp))
            Button(
                label = stringResource(Res.string.signup_delivery),
                loading = viewModel.loading,
                enabled = !viewModel.loading,
                onClick =  {
                if (viewModel.isValid()) {
                    callService(
                        coroutineScope = coroutine,
                        snackbarHostState = snackbarHostState,
                        setLoading = { viewModel.loading = it },
                        serviceCall = { viewModel.signup() },
                        onSuccess = { navigate(LOGIN_PATH) }
                    )
                }
            })
        }
        }
    }
}
