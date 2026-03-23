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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import asdo.auth.DoTwoFactorVerifyException
import kotlinx.coroutines.launch
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.Button
import ui.cp.inputs.TextField
import ui.sc.shared.Screen
import ui.sc.shared.callService
import ui.th.spacing

const val TWO_FACTOR_VERIFY_PATH = "/twoFactorVerify"

class TwoFactorVerifyScreen : Screen(TWO_FACTOR_VERIFY_PATH) {

    override val messageTitle: MessageKey = MessageKey.dashboard_menu_verify_two_factor

    private val logger = LoggerFactory.default.newLogger<TwoFactorVerifyScreen>()

    @Composable
    override fun screen() { screenImpl() }

    @Composable
    private fun screenImpl(viewModel: TwoFactorVerifyViewModel = viewModel { TwoFactorVerifyViewModel() }) {
        val coroutine = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }
        val verifyLabel = Txt(MessageKey.two_factor_verify_submit)
        val successMessage = Txt(MessageKey.two_factor_verify_success)
        val genericError = Txt(MessageKey.error_generic)
        val invalidCodeError = Txt(MessageKey.two_factor_verify_error_invalid)
        val codeHint = Txt(MessageKey.two_factor_verify_code_hint)

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
                    label = MessageKey.confirm_password_recovery_code,
                    value = viewModel.state.code,
                    state = viewModel.inputsStates[TwoFactorVerifyViewModel.TwoFactorVerifyUIState::code.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(code = it) }
                )
                Text(
                    text = codeHint,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1_5))
                Button(
                    label = verifyLabel,
                    loading = viewModel.loading,
                    enabled = !viewModel.loading,
                    onClick = {
                        if (viewModel.isValid()) {
                            logger.debug { "Verificando código de 2FA" }
                            callService(
                                coroutineScope = coroutine,
                                snackbarHostState = snackbarHostState,
                                setLoading = { viewModel.loading = it },
                                serviceCall = { viewModel.verify() },
                                onSuccess = {
                                    coroutine.launch { snackbarHostState.showSnackbar(successMessage) }
                                },
                                onError = { error ->
                                    logger.error { "Error al verificar código 2FA: ${error.message}" }
                                    val message = when {
                                        error is DoTwoFactorVerifyException -> invalidCodeError
                                        else -> error.message ?: genericError
                                    }
                                    snackbarHostState.showSnackbar(message)
                                }
                            )
                        }
                    }
                )
            }
        }
    }
}
