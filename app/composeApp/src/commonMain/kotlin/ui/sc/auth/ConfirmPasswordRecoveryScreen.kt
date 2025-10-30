package ui.sc.auth

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.cp.inputs.TextField
import ui.sc.shared.Screen
import ui.sc.shared.callService
import ui.th.spacing

const val CONFIRM_PASSWORD_RECOVERY_PATH = "/confirmPasswordRecovery"

class ConfirmPasswordRecoveryScreen : Screen(CONFIRM_PASSWORD_RECOVERY_PATH) {

    override val messageTitle: MessageKey = MessageKey.confirm_password_recovery

    private val logger = LoggerFactory.default.newLogger<ConfirmPasswordRecoveryScreen>()

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
                    .verticalScroll(rememberScrollState())
                    .padding(
                        horizontal = MaterialTheme.spacing.x3,
                        vertical = MaterialTheme.spacing.x4
                    ),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1_5))
                TextField(
                    label = MessageKey.confirm_password_recovery_email,
                    value = viewModel.state.email,
                    state = viewModel.inputsStates[ConfirmPasswordRecoveryViewModel.ConfirmPasswordRecoveryUIState::email.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(email = it) }
                )
                Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1_5))
                TextField(
                    label = MessageKey.confirm_password_recovery_code,
                    value = viewModel.state.code,
                    state = viewModel.inputsStates[ConfirmPasswordRecoveryViewModel.ConfirmPasswordRecoveryUIState::code.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(code = it) }
                )
                Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1_5))
                TextField(
                    label = MessageKey.password,
                    visualTransformation = true,
                    value = viewModel.state.password,
                    state = viewModel.inputsStates[ConfirmPasswordRecoveryViewModel.ConfirmPasswordRecoveryUIState::password.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(password = it) }
                )
                Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1_5))
                val confirmLabel = Txt(MessageKey.confirm_password_recovery)
                val passwordUpdatedMessage = Txt(MessageKey.confirm_password_recovery_success)
                val genericErrorMessage = Txt(MessageKey.error_generic)
                IntralePrimaryButton(
                    text = confirmLabel,
                    iconAsset = "ic_recover.svg",
                    iconContentDescription = confirmLabel,
                    loading = viewModel.loading,
                    enabled = !viewModel.loading,
                    onClick = {
                        if (viewModel.isValid()) {
                            logger.debug { "Formulario válido" }
                            logger.debug { "Confirmando recuperación de contraseña" }
                            callService(
                                coroutineScope = coroutine,
                                snackbarHostState = snackbarHostState,
                                setLoading = { viewModel.loading = it },
                                serviceCall = { viewModel.confirm() },
                                onSuccess = { coroutine.launch { snackbarHostState.showSnackbar(passwordUpdatedMessage) } },
                                onError = { error ->
                                    logger.error { "Error al confirmar recuperación: ${error.message}" }
                                    snackbarHostState.showSnackbar(error.message ?: genericErrorMessage)
                                }
                            )
                        }
                    }
                )
            }
        }
    }
}
