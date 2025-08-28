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
import ui.rs.email
import ui.rs.review_join_business
import ui.rs.review_join_business_approved
import ui.rs.review_join_business_rejected

const val REVIEW_JOIN_BUSINESS_PATH = "/reviewJoinBusiness"

class ReviewJoinBusinessScreen : Screen(REVIEW_JOIN_BUSINESS_PATH, Res.string.review_join_business) {
    private val logger = LoggerFactory.default.newLogger<ReviewJoinBusinessScreen>()

    @Composable
    override fun screen() { screenImpl() }

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun screenImpl(viewModel: ReviewJoinBusinessViewModel = viewModel { ReviewJoinBusinessViewModel() }) {
        val coroutine = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }
        val approvedMsg = stringResource(Res.string.review_join_business_approved)
        val rejectedMsg = stringResource(Res.string.review_join_business_rejected)

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Spacer(Modifier.size(10.dp))
                TextField(
                    Res.string.email,
                    value = viewModel.state.email,
                    state = viewModel.inputsStates[ReviewJoinBusinessViewModel.UIState::email.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(email = it) }
                )
                Spacer(Modifier.size(10.dp))
                Row {
                    Button(
                        label = stringResource(Res.string.review_join_business_approved),
                        loading = viewModel.loading,
                        enabled = !viewModel.loading,
                        onClick = {
                            if (viewModel.isValid()) {
                                logger.info { "Aprobando unión" }
                                callService(
                                    coroutineScope = coroutine,
                                    snackbarHostState = snackbarHostState,
                                    setLoading = { viewModel.loading = it },
                                    serviceCall = { viewModel.approve() },
                                    onSuccess = {
                                        coroutine.launch { snackbarHostState.showSnackbar(approvedMsg) }
                                        viewModel.state = ReviewJoinBusinessViewModel.UIState()
                                        viewModel.initInputState()
                                    }
                                )
                            }
                        }
                    )
                    Spacer(Modifier.size(10.dp))
                    Button(
                        label = stringResource(Res.string.review_join_business_rejected),
                        loading = viewModel.loading,
                        enabled = !viewModel.loading,
                        onClick = {
                            if (viewModel.isValid()) {
                                logger.info { "Rechazando unión" }
                                callService(
                                    coroutineScope = coroutine,
                                    snackbarHostState = snackbarHostState,
                                    setLoading = { viewModel.loading = it },
                                    serviceCall = { viewModel.reject() },
                                    onSuccess = {
                                        coroutine.launch { snackbarHostState.showSnackbar(rejectedMsg) }
                                        viewModel.state = ReviewJoinBusinessViewModel.UIState()
                                        viewModel.initInputState()
                                    }
                                )
                            }
                        }
                    )
                }
                Spacer(Modifier.size(10.dp))
            }
        }
    }
}
