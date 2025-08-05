package ui.sc

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.jetbrains.compose.resources.stringResource
import ui.cp.Button
import ui.cp.TextField
import ui.rs.Res
import ui.rs.register_business
import ui.rs.name
import ui.rs.email_admin
import ui.rs.description
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

const val REGISTER_BUSINESS_PATH = "/registerBusiness"

class RegisterBusinessScreen : Screen(REGISTER_BUSINESS_PATH, Res.string.register_business) {
    private val logger = LoggerFactory.default.newLogger<RegisterBusinessScreen>()
    @Composable
    override fun screen() { screenImpl() }

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun screenImpl(viewModel: RegisterBusinessViewModel = viewModel { RegisterBusinessViewModel() }) {
        val coroutine = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Spacer(Modifier.size(10.dp))
                TextField(
                    Res.string.name,
                    value = viewModel.state.name,
                    state = viewModel.inputsStates[RegisterBusinessViewModel.UIState::name.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(name = it) }
                )
                Spacer(Modifier.size(10.dp))
                TextField(
                    Res.string.email_admin,
                    value = viewModel.state.email,
                    state = viewModel.inputsStates[RegisterBusinessViewModel.UIState::email.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(email = it) }
                )
                Spacer(Modifier.size(10.dp))
                TextField(
                    Res.string.description,
                    value = viewModel.state.description,
                    state = viewModel.inputsStates[RegisterBusinessViewModel.UIState::description.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(description = it) }
                )
                Spacer(Modifier.size(10.dp))
                Button(
                    label = stringResource(Res.string.register_business),
                    loading = viewModel.loading,
                    enabled = !viewModel.loading,
                    onClick = {
                        if (viewModel.isValid()) {
                            logger.info { "Intento de registro de negocio" }
                            callService(
                                coroutineScope = coroutine,
                                snackbarHostState = snackbarHostState,
                                setLoading = { viewModel.loading = it },
                                serviceCall = { viewModel.register() }
                            )
                        }
                    }
                )
                Spacer(Modifier.size(20.dp))
            }
        }
    }
}
