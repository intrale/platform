package ui.sc

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
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.jetbrains.compose.resources.stringResource
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import kotlinx.coroutines.launch
import ui.cp.Button
import ui.cp.TextField
import ui.rs.Res
import ui.rs.code
import ui.rs.two_factor_verify
import ui.th.spacing

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
                    Res.string.code,
                    value = viewModel.state.code,
                    state = viewModel.inputsStates[TwoFactorVerifyViewModel.TwoFactorVerifyUIState::code.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(code = it) }
                )
                Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1_5))
                Button(
                    label = stringResource(Res.string.two_factor_verify),
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

