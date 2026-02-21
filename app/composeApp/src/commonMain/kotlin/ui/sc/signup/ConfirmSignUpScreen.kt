package ui.sc.signup

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
import ui.cp.buttons.Button
import ui.cp.inputs.TextField
import ui.sc.auth.LOGIN_PATH
import ui.sc.shared.Screen
import ui.sc.shared.callService
import ui.th.spacing

const val CONFIRM_SIGNUP_PATH = "/confirmSignUp"

class ConfirmSignUpScreen : Screen(CONFIRM_SIGNUP_PATH) {

    override val messageTitle: MessageKey = MessageKey.confirm_signup

    private val logger = LoggerFactory.default.newLogger<ConfirmSignUpScreen>()

    @Composable
    override fun screen() { screenImpl() }

    @Composable
    private fun screenImpl(viewModel: ConfirmSignUpViewModel = viewModel { ConfirmSignUpViewModel() }) {
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
                    label = MessageKey.email,
                    value = viewModel.state.email,
                    state = viewModel.inputsStates[ConfirmSignUpViewModel.ConfirmSignUpUIState::email.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(email = it) }
                )
                Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1_5))
                TextField(
                    label = MessageKey.confirm_signup_code,
                    value = viewModel.state.code,
                    state = viewModel.inputsStates[ConfirmSignUpViewModel.ConfirmSignUpUIState::code.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(code = it) }
                )
                Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1_5))
                val confirmLabel = Txt(MessageKey.confirm_signup_submit)
                val successMessage = Txt(MessageKey.confirm_signup_success)
                val genericErrorMessage = Txt(MessageKey.error_generic)
                Button(
                    label = confirmLabel,
                    loading = viewModel.loading,
                    enabled = !viewModel.loading,
                    onClick = {
                        if (viewModel.isValid()) {
                            logger.debug { "Formulario válido, confirmando registro" }
                            callService(
                                coroutineScope = coroutine,
                                snackbarHostState = snackbarHostState,
                                setLoading = { viewModel.loading = it },
                                serviceCall = { viewModel.confirmSignUp() },
                                onSuccess = { navigateClearingBackStack(LOGIN_PATH) },
                                onError = { error ->
                                    logger.error { "Error al confirmar registro: ${error.message}" }
                                    snackbarHostState.showSnackbar(error.message ?: genericErrorMessage)
                                }
                            )
                        }
                    }
                )
                Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1_5))
                val resendLabel = Txt(MessageKey.confirm_signup_resend)
                val resendSuccessMessage = Txt(MessageKey.confirm_signup_success)
                Button(
                    label = resendLabel,
                    loading = viewModel.loading,
                    enabled = !viewModel.loading,
                    onClick = {
                        logger.debug { "Reenviando código de verificación" }
                        coroutine.launch {
                            viewModel.loading = true
                            viewModel.resendCode()
                                .onSuccess {
                                    snackbarHostState.showSnackbar(resendSuccessMessage)
                                }
                                .onFailure { error ->
                                    logger.error { "Error al reenviar código: ${error.message}" }
                                    snackbarHostState.showSnackbar(error.message ?: genericErrorMessage)
                                }
                            viewModel.loading = false
                        }
                    }
                )
            }
        }
    }
}
