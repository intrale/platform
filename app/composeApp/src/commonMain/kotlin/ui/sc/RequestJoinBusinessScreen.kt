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
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.jetbrains.compose.resources.stringResource
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.Button
import ui.cp.TextField
import ui.rs.Res
import ui.rs.business
import ui.rs.request_join_business
import ui.rs.request_join_business_sent

const val REQUEST_JOIN_BUSINESS_PATH = "/requestJoinBusiness"

class RequestJoinBusinessScreen : Screen(REQUEST_JOIN_BUSINESS_PATH, Res.string.request_join_business) {
    private val logger = LoggerFactory.default.newLogger<RequestJoinBusinessScreen>()

    @Composable
    override fun screen() { screenImpl() }

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun screenImpl(viewModel: RequestJoinBusinessViewModel = viewModel { RequestJoinBusinessViewModel() }) {
        val coroutine = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }
        val requestSent = stringResource(Res.string.request_join_business_sent)

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Spacer(Modifier.size(10.dp))
                TextField(
                    Res.string.business,
                    value = viewModel.state.business,
                    state = viewModel.inputsStates[RequestJoinBusinessViewModel.UIState::business.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(business = it) }
                )
                Spacer(Modifier.size(10.dp))
                Button(
                    label = stringResource(Res.string.request_join_business),
                    loading = viewModel.loading,
                    enabled = !viewModel.loading,
                    onClick = {
                        if (viewModel.isValid()) {
                            logger.info { "Solicitud de unión a negocio" }
                            callService(
                                coroutineScope = coroutine,
                                snackbarHostState = snackbarHostState,
                                setLoading = { viewModel.loading = it },
                                serviceCall = { viewModel.request() },
                                onSuccess = {
                                    coroutine.launch { snackbarHostState.showSnackbar(requestSent) }
                                    viewModel.state = RequestJoinBusinessViewModel.UIState()
                                    viewModel.initInputState()
                                }
                            )
                        }
                    }
                )
                Spacer(Modifier.size(10.dp))
            }
        }
    }
}
