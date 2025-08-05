package ui.sc

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import kotlinx.coroutines.launch
import ui.rs.Res
import ui.rs.pending_requests
import ui.rs.approve
import ui.rs.reject
import ui.rs.code
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

        LaunchedEffect(true) {
            logger.debug { "Cargando solicitudes pendientes" }
            viewModel.loadPending()
        }

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Spacer(Modifier.size(10.dp))
                Text(stringResource(Res.string.pending_requests))
                Spacer(Modifier.size(10.dp))
                TextField(
                    Res.string.code,
                    value = viewModel.state.twoFactorCode,
                    state = viewModel.inputsStates[RegisterBusinessViewModel.UIState::twoFactorCode.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(twoFactorCode = it) }
                )
                viewModel.pending.forEach { biz ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(biz, modifier = Modifier.weight(1f))
                        Button(
                            label = stringResource(Res.string.approve),
                            loading = viewModel.loading,
                            enabled = !viewModel.loading,
                            onClick = {
                                logger.info { "Aprobando negocio $biz" }
                                callService(
                                    coroutineScope = coroutine,
                                    snackbarHostState = snackbarHostState,
                                    setLoading = { viewModel.loading = it },
                                    serviceCall = { viewModel.approve(biz) },
                                    onSuccess = { coroutine.launch { viewModel.loadPending() } }
                                )
                            }
                        )
                        Spacer(Modifier.size(4.dp))
                        Button(
                            label = stringResource(Res.string.reject),
                            loading = viewModel.loading,
                            enabled = !viewModel.loading,
                            onClick = {
                                logger.warning { "Rechazando negocio $biz" }
                                callService(
                                    coroutineScope = coroutine,
                                    snackbarHostState = snackbarHostState,
                                    setLoading = { viewModel.loading = it },
                                    serviceCall = { viewModel.reject(biz) },
                                    onSuccess = { coroutine.launch { viewModel.loadPending() } }
                                )
                            }
                        )
                    }
                    Spacer(Modifier.size(8.dp))
                }
            }
        }
    }
}
