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
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.Button
import ui.cp.inputs.TextField
import ui.th.spacing
import ui.sc.shared.Screen
import ui.sc.shared.callService

const val REGISTER_SALER_PATH = "/registerSaler"

class RegisterSalerScreen : Screen(REGISTER_SALER_PATH) {
    private val logger = LoggerFactory.default.newLogger<RegisterSalerScreen>()

    override val messageTitle: MessageKey = MessageKey.register_saler_title

    @Composable
    override fun screen() { screenImpl() }

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun screenImpl(viewModel: RegisterSalerViewModel = viewModel { RegisterSalerViewModel() }) {
        val coroutine = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }
        val successMessage = Txt(MessageKey.register_saler_success)

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { paddingValues ->
            logger.debug { "Mostrando RegisterSalerScreen" }
            Column(
                Modifier
                    .padding(paddingValues)
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
                    state = viewModel.inputsStates[RegisterSalerViewModel.RegisterSalerUIState::email.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(email = it) }
                )
                Spacer(modifier = Modifier.size(MaterialTheme.spacing.x1_5))
                val registerLabel = Txt(MessageKey.register_saler_submit)
                Button(
                    label = registerLabel,
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
