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
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.Button
import ui.cp.TextField
import ui.rs.Res
import ui.rs.email
import ui.rs.register_saler
import ui.rs.register_saler_success

const val REGISTER_SALER_PATH = "/registerSaler"

class RegisterSalerScreen : Screen(REGISTER_SALER_PATH, Res.string.register_saler) {
    private val logger = LoggerFactory.default.newLogger<RegisterSalerScreen>()

    @Composable
    override fun screen() { screenImpl() }

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun screenImpl(viewModel: RegisterSalerViewModel = viewModel { RegisterSalerViewModel() }) {
        val coroutine = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }
        val successMessage = stringResource(Res.string.register_saler_success)

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { paddingValues ->
            logger.debug { "Mostrando RegisterSalerScreen" }
            Column(
                Modifier
                    .padding(paddingValues)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Spacer(modifier = Modifier.size(10.dp))
                TextField(
                    Res.string.email,
                    value = viewModel.state.email,
                    state = viewModel.inputsStates[RegisterSalerViewModel.RegisterSalerUIState::email.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(email = it) }
                )
                Spacer(modifier = Modifier.size(10.dp))
                Button(
                    label = stringResource(Res.string.register_saler),
                    loading = viewModel.loading,
                    enabled = !viewModel.loading,
                    onClick = {
                        logger.info { "Intento de registro de vendedor" }
                        if (viewModel.isValid()) {
                            callService(
                                coroutineScope = coroutine,
                                snackbarHostState = snackbarHostState,
                                setLoading = { viewModel.loading = it },
                                serviceCall = { viewModel.register() },
                                onSuccess = { _ ->
                                    coroutine.launch { snackbarHostState.showSnackbar(successMessage) }
                                    viewModel.state = RegisterSalerViewModel.RegisterSalerUIState()
                                }
                            )
                        }
                    }
                )
            }
        }
    }
}
