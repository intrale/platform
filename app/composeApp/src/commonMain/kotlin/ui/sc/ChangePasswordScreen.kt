package ui.sc

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.jetbrains.compose.resources.stringResource
import ui.cp.Button
import ui.cp.TextField
import ui.rs.Res
import ui.rs.old_password
import ui.rs.new_password
import ui.rs.update_password

const val CHANGE_PASSWORD_PATH = "/change-password"

class ChangePasswordScreen : Screen(CHANGE_PASSWORD_PATH, Res.string.update_password) {
    @Composable
    override fun screen() { screenImpl() }

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun screenImpl(viewModel: ChangePasswordViewModel = viewModel { ChangePasswordViewModel() }) {
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
                    Res.string.old_password,
                    visualTransformation = true,
                    value = viewModel.state.oldPassword,
                    state = viewModel.inputsStates[ChangePasswordViewModel.ChangePasswordUIState::oldPassword.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(oldPassword = it) }
                )
                Spacer(modifier = Modifier.size(10.dp))
                TextField(
                    Res.string.new_password,
                    visualTransformation = true,
                    value = viewModel.state.newPassword,
                    state = viewModel.inputsStates[ChangePasswordViewModel.ChangePasswordUIState::newPassword.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(newPassword = it) }
                )
                Spacer(modifier = Modifier.size(10.dp))
                Button(
                    label = stringResource(Res.string.update_password),
                    loading = viewModel.loading,
                    enabled = !viewModel.loading,
                    onClick = {
                        if (viewModel.isValid()) {
                            callService(
                                coroutineScope = coroutine,
                                snackbarHostState = snackbarHostState,
                                setLoading = { viewModel.loading = it },
                                serviceCall = { viewModel.changePassword() },
                                onSuccess = { coroutine.launch { snackbarHostState.showSnackbar("Contraseña actualizada") } }
                            )
                        }
                    }
                )
            }
        }
    }
}
