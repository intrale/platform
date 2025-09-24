package ui.sc.auth

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.Button
import ui.cp.inputs.TextField
import ui.rs.Res
import ui.rs.new_password
import ui.rs.old_password
import ui.rs.update_password
import ui.th.spacing
import ui.sc.shared.Screen
import ui.sc.shared.callService
import ui.util.RES_ERROR_PREFIX
import ui.util.resStringOr

const val CHANGE_PASSWORD_PATH = "/change-password"

class ChangePasswordScreen : Screen(CHANGE_PASSWORD_PATH, Res.string.update_password) {

    private val logger = LoggerFactory.default.newLogger<ChangePasswordScreen>()

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
                    .verticalScroll(rememberScrollState())
                    .padding(
                        horizontal = MaterialTheme.spacing.x3,
                        vertical = MaterialTheme.spacing.x4
                    ),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1_5))
                TextField(
                    Res.string.old_password,
                    visualTransformation = true,
                    value = viewModel.state.oldPassword,
                    state = viewModel.inputsStates[ChangePasswordViewModel.ChangePasswordUIState::oldPassword.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(oldPassword = it) }
                )
                Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1_5))
                TextField(
                    Res.string.new_password,
                    visualTransformation = true,
                    value = viewModel.state.newPassword,
                    state = viewModel.inputsStates[ChangePasswordViewModel.ChangePasswordUIState::newPassword.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(newPassword = it) }
                )
                Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1_5))
                Button(
                    label = resStringOr(
                        Res.string.update_password,
                        RES_ERROR_PREFIX + "Actualizar contraseña"
                    ),
                    loading = viewModel.loading,
                    enabled = !viewModel.loading,
                    onClick = {
                        if (viewModel.isValid()) {
                            logger.debug { "Formulario válido" }
                            logger.debug { "Invocando cambio de contraseña" }
                            callService(
                                coroutineScope = coroutine,
                                snackbarHostState = snackbarHostState,
                                setLoading = { viewModel.loading = it },
                                serviceCall = { viewModel.changePassword() },
                                onSuccess = { coroutine.launch { snackbarHostState.showSnackbar("Contraseña actualizada") } },
                                onError = { error ->
                                    logger.error { "Error al cambiar contraseña: ${error.message}" }
                                    snackbarHostState.showSnackbar(error.message ?: "Error")
                                }
                            )
                        }
                    }
                )
            }
        }
    }
}
