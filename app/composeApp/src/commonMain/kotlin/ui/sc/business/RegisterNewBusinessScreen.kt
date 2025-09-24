package ui.sc.business

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
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.cp.inputs.TextField
import ui.rs.Res
import ui.rs.description
import ui.rs.email_admin
import ui.rs.name
import ui.rs.register_business
import ui.rs.register_business_sent
import ui.th.spacing
import ui.sc.shared.Screen
import ui.sc.shared.callService
import ui.util.RES_ERROR_PREFIX
import ui.util.resStringOr

const val REGISTER_NEW_BUSINESS_PATH = "/registerNewBusiness"

class RegisterNewBusinessScreen : Screen(REGISTER_NEW_BUSINESS_PATH, Res.string.register_business) {
    private val logger = LoggerFactory.default.newLogger<RegisterNewBusinessScreen>()

    @Composable
    override fun screen() { screenImpl() }

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun screenImpl(viewModel: RegisterBusinessViewModel = viewModel { RegisterBusinessViewModel() }) {
        val coroutine = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }
        val registerBusinessSent = resStringOr(
            Res.string.register_business_sent,
            RES_ERROR_PREFIX + "Registro enviado"
        )

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
                Spacer(Modifier.size(MaterialTheme.spacing.x1_5))
                TextField(
                    Res.string.name,
                    value = viewModel.state.name,
                    state = viewModel.inputsStates[RegisterBusinessViewModel.UIState::name.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(name = it) }
                )
                Spacer(Modifier.size(MaterialTheme.spacing.x1_5))
                TextField(
                    Res.string.email_admin,
                    value = viewModel.state.email,
                    state = viewModel.inputsStates[RegisterBusinessViewModel.UIState::email.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(email = it) }
                )
                Spacer(Modifier.size(MaterialTheme.spacing.x1_5))
                TextField(
                    Res.string.description,
                    value = viewModel.state.description,
                    state = viewModel.inputsStates[RegisterBusinessViewModel.UIState::description.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(description = it) }
                )
                Spacer(Modifier.size(MaterialTheme.spacing.x1_5))
                val registerLabel = resStringOr(
                    Res.string.register_business,
                    RES_ERROR_PREFIX + "Registrar negocio"
                )
                IntralePrimaryButton(
                    text = registerLabel,
                    iconAsset = "ic_register_business.svg",
                    iconContentDescription = registerLabel,
                    loading = viewModel.loading,
                    enabled = !viewModel.loading,
                    onClick = {
                        if (viewModel.isValid()) {
                            logger.info { "Intento de registro de negocio" }
                            callService(
                                coroutineScope = coroutine,
                                snackbarHostState = snackbarHostState,
                                setLoading = { viewModel.loading = it },
                                serviceCall = { viewModel.register() },
                                onSuccess = {
                                    coroutine.launch { snackbarHostState.showSnackbar(registerBusinessSent) }
                                    viewModel.state = RegisterBusinessViewModel.UIState()
                                    viewModel.initInputState()
                                }
                            )
                        }
                    }
                )
                Spacer(Modifier.size(MaterialTheme.spacing.x1_5))
            }
        }
    }
}
