package ui.sc

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
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
import ui.rs.code
import ui.rs.password
import ui.rs.confirm_password_recovery

const val CONFIRM_PASSWORD_RECOVERY_PATH = "/confirmPasswordRecovery"

class ConfirmPasswordRecoveryScreen : Screen(CONFIRM_PASSWORD_RECOVERY_PATH, Res.string.confirm_password_recovery) {
    @Composable
    override fun screen() { screenImpl() }

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun screenImpl(viewModel: ConfirmPasswordRecoveryViewModel = viewModel { ConfirmPasswordRecoveryViewModel() }) {
        val coroutine = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
            Column(
                Modifier
                    .padding(padding)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Spacer(modifier = Modifier.size(10.dp))
                TextField(
                    Res.string.email,
                    value = viewModel.state.email,
                    state = viewModel.inputsStates[ConfirmPasswordRecoveryViewModel.ConfirmPasswordRecoveryUIState::email.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(email = it) }
                )
                Spacer(modifier = Modifier.size(10.dp))
                TextField(
                    Res.string.code,
                    value = viewModel.state.code,
                    state = viewModel.inputsStates[ConfirmPasswordRecoveryViewModel.ConfirmPasswordRecoveryUIState::code.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(code = it) }
                )
                Spacer(modifier = Modifier.size(10.dp))
                TextField(
                    Res.string.password,
                    visualTransformation = true,
                    value = viewModel.state.password,
                    state = viewModel.inputsStates[ConfirmPasswordRecoveryViewModel.ConfirmPasswordRecoveryUIState::password.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(password = it) }
                )
                Spacer(modifier = Modifier.size(10.dp))
                Button(
                    label = stringResource(Res.string.confirm_password_recovery),
                    loading = viewModel.loading,
                    enabled = !viewModel.loading,
                    onClick = {
                        if (viewModel.isValid()) {
                            callService(
                                coroutineScope = coroutine,
                                snackbarHostState = snackbarHostState,
                                setLoading = { viewModel.loading = it },
                                serviceCall = { viewModel.confirm() },
                                onSuccess = { coroutine.launch { snackbarHostState.showSnackbar("Contraseña actualizada") } }
                            )
                        }
                    }
                )
            }
        }
    }
}
