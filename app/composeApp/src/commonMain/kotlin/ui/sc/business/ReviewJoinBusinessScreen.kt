package ui.sc.business

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
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
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.Button
import ui.cp.inputs.TextField
import ui.th.spacing
import ui.sc.shared.Screen
import ui.sc.shared.callService

const val REVIEW_JOIN_BUSINESS_PATH = "/reviewJoinBusiness"

class ReviewJoinBusinessScreen : Screen(REVIEW_JOIN_BUSINESS_PATH) {
    override val messageTitle: MessageKey = MessageKey.review_join_business
    private val logger = LoggerFactory.default.newLogger<ReviewJoinBusinessScreen>()

    @Composable
    override fun screen() { screenImpl() }

    @Composable
    private fun screenImpl(viewModel: ReviewJoinBusinessViewModel = viewModel { ReviewJoinBusinessViewModel() }) {
        val coroutine = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }
        val approvedMsg = Txt(MessageKey.review_join_business_feedback_approved)
        val rejectedMsg = Txt(MessageKey.review_join_business_feedback_rejected)

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
                    label = MessageKey.email,
                    value = viewModel.state.email,
                    state = viewModel.inputsStates[ReviewJoinBusinessViewModel.UIState::email.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(email = it) }
                )
                Spacer(Modifier.size(MaterialTheme.spacing.x1_5))
                Row(
                    horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1_5)
                ) {
                    Button(
                        label = Txt(MessageKey.review_join_business_action_approve),
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
                    Button(
                        label = Txt(MessageKey.review_join_business_action_reject),
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
                Spacer(Modifier.size(MaterialTheme.spacing.x1_5))
            }
        }
    }
}
