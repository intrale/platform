package ui.sc.business

import androidx.compose.foundation.layout.Arrangement
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
import ui.cp.buttons.Button
import ui.cp.inputs.TextField
import ui.rs.Res
import ui.rs.business
import ui.rs.request_join_business
import ui.rs.request_join_business_sent
import ui.th.spacing
import ui.sc.shared.Screen
import ui.sc.shared.callService
import ui.util.RES_ERROR_PREFIX
import ui.util.fb
import ui.util.resString

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
        val requestSent = resString(
            composeId = Res.string.request_join_business_sent,
            fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Solicitud enviada"),
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
                    Res.string.business,
                    value = viewModel.state.business,
                    state = viewModel.inputsStates[RequestJoinBusinessViewModel.UIState::business.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(business = it) }
                )
                Spacer(Modifier.size(MaterialTheme.spacing.x1_5))
                Button(
                    label = resString(
                        composeId = Res.string.request_join_business,
                        fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Solicitar union"),
                    ),
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
                Spacer(Modifier.size(MaterialTheme.spacing.x1_5))
            }
        }
    }
}
