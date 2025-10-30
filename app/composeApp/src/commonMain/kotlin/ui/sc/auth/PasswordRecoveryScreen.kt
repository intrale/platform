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
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.cp.inputs.TextField
import ui.th.spacing
import ui.sc.shared.Screen
import ui.sc.shared.callService

const val PASSWORD_RECOVERY_PATH = "/passwordRecovery"

class PasswordRecoveryScreen : Screen(PASSWORD_RECOVERY_PATH) {

    override val messageTitle: MessageKey = MessageKey.password_recovery

    private val logger = LoggerFactory.default.newLogger<PasswordRecoveryScreen>()

    @Composable
    override fun screen() { screenImpl() }

    @Composable
    private fun screenImpl(viewModel: PasswordRecoveryViewModel = viewModel { PasswordRecoveryViewModel() }) {
        val coroutine = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }
        val passwordRecoveryLabel = Txt(MessageKey.password_recovery)
        val passwordRecoverySuccessMessage = Txt(MessageKey.password_recovery_email_sent)
        val genericErrorMessage = Txt(MessageKey.error_generic)

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
                    MessageKey.email,
                    value = viewModel.state.email,
                    state = viewModel.inputsStates[PasswordRecoveryViewModel.PasswordRecoveryUIState::email.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(email = it) }
                )
                Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1_5))
                IntralePrimaryButton(
                    text = passwordRecoveryLabel,
                    iconAsset = "ic_recover.svg",
                    iconContentDescription = passwordRecoveryLabel,
                    loading = viewModel.loading,
                    enabled = !viewModel.loading,
                    onClick = {
                        if (viewModel.isValid()) {
                            logger.debug { "Formulario válido" }
                            logger.debug { "Solicitando recuperación de contraseña" }
                            callService(
                                coroutineScope = coroutine,
                                snackbarHostState = snackbarHostState,
                                setLoading = { viewModel.loading = it },
                                serviceCall = { viewModel.recovery() },
                                onSuccess = {
                                    coroutine.launch {
                                        snackbarHostState.showSnackbar(passwordRecoverySuccessMessage)
                                    }
                                },
                                onError = { error ->
                                    logger.error { "Error en recuperación de contraseña: ${error.message}" }
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
