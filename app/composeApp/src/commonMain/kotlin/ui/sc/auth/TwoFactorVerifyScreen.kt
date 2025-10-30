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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.model.MessageKey
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import kotlinx.coroutines.launch
import ui.cp.buttons.Button
import ui.cp.inputs.TextField
import ui.rs.Res
import ui.rs.two_factor_verify
import ui.th.spacing
import ui.sc.shared.Screen
import ui.sc.shared.callService
import ui.util.RES_ERROR_PREFIX
import ui.util.fb
import ui.util.resString

const val TWO_FACTOR_VERIFY_PATH = "/twoFactorVerify"

class TwoFactorVerifyScreen : Screen(TWO_FACTOR_VERIFY_PATH, Res.string.two_factor_verify) {

    private val logger = LoggerFactory.default.newLogger<TwoFactorVerifyScreen>()

    @Composable
    override fun screen() { screenImpl() }

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun screenImpl(viewModel: TwoFactorVerifyViewModel = viewModel { TwoFactorVerifyViewModel() }) {
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
                    label = MessageKey.confirm_password_recovery_code,
                    value = viewModel.state.code,
                    state = viewModel.inputsStates[TwoFactorVerifyViewModel.TwoFactorVerifyUIState::code.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(code = it) }
                )
                Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1_5))
                Button(
                    label = resString(
                        composeId = Res.string.two_factor_verify,
                        fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Verificar codigo"),
                    ),
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
                                onSuccess = { coroutine.launch { snackbarHostState.showSnackbar("Código verificado") } },
                                onError = { error ->
                                    logger.error { "Error al verificar: ${error.message}" }
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

