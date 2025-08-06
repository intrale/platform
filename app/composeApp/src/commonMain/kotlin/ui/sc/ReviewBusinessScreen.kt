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
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.jetbrains.compose.resources.stringResource
import ui.cp.Button
import ui.cp.TextField
import ui.rs.Res
import ui.rs.pending_requests
import ui.rs.approve
import ui.rs.reject
import ui.rs.code
import ui.rs.select_all
import ui.rs.approve_selected
import ui.rs.reject_selected
import ui.rs.description
import ui.rs.email_admin
import ui.rs.auto_accept_deliveries
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

const val REVIEW_BUSINESS_PATH = "/reviewBusiness"

class ReviewBusinessScreen : Screen(REVIEW_BUSINESS_PATH, Res.string.pending_requests) {
    private val logger = LoggerFactory.default.newLogger<ReviewBusinessScreen>()
    @Composable
    override fun screen() { screenImpl() }

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun screenImpl(viewModel: ReviewBusinessViewModel = viewModel { ReviewBusinessViewModel() }) {
        val coroutine = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }

        LaunchedEffect(true) {
            logger.debug { "Cargando solicitudes pendientes" }
            viewModel.loadPending()
        }

        // TODO: restringir acceso solo a administradores
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
                    state = viewModel.inputsStates[ReviewBusinessViewModel.UIState::twoFactorCode.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(twoFactorCode = it) }
                )
                Spacer(Modifier.size(10.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(
                        checked = viewModel.selected.size == viewModel.pending.size && viewModel.pending.isNotEmpty(),
                        onCheckedChange = { checked ->
                            if (checked) viewModel.selectAll() else viewModel.clearSelection()
                        }
                    )
                    Text(stringResource(Res.string.select_all))
                }
                Spacer(Modifier.size(10.dp))
                viewModel.pending.forEach { biz ->
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(8.dp),
                        colors = CardDefaults.cardColors()
                    ) {
                        Row(
                            Modifier.padding(8.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Checkbox(
                                checked = viewModel.selected.contains(biz.id),
                                onCheckedChange = { viewModel.toggleSelection(biz.id) }
                            )
                            Column(modifier = Modifier.weight(1f)) {
                                Text(biz.name)
                                Text("${stringResource(Res.string.description)}: ${biz.description}")
                                Text("${stringResource(Res.string.email_admin)}: ${biz.emailAdmin}")
                                Text("${stringResource(Res.string.auto_accept_deliveries)}: ${biz.autoAcceptDeliveries}")
                            }
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Button(
                                    label = stringResource(Res.string.approve),
                                    loading = viewModel.loading,
                                    enabled = !viewModel.loading,
                                    onClick = {
                                        logger.info { "Aprobando negocio ${biz.id}" }
                                        callService(
                                            coroutineScope = coroutine,
                                            snackbarHostState = snackbarHostState,
                                            setLoading = { viewModel.loading = it },
                                            serviceCall = { viewModel.approve(biz.id) },
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
                                        logger.warning { "Rechazando negocio ${biz.id}" }
                                        callService(
                                            coroutineScope = coroutine,
                                            snackbarHostState = snackbarHostState,
                                            setLoading = { viewModel.loading = it },
                                            serviceCall = { viewModel.reject(biz.id) },
                                            onSuccess = { coroutine.launch { viewModel.loadPending() } }
                                        )
                                    }
                                )
                            }
                        }
                    }
                }
                Spacer(Modifier.size(10.dp))
                Row {
                    Button(
                        label = stringResource(Res.string.approve_selected),
                        loading = viewModel.loading,
                        enabled = !viewModel.loading && viewModel.selected.isNotEmpty(),
                        onClick = {
                            logger.info { "Aprobando seleccionados" }
                            callService(
                                coroutineScope = coroutine,
                                snackbarHostState = snackbarHostState,
                                setLoading = { viewModel.loading = it },
                                serviceCall = { viewModel.approveSelected() },
                                onSuccess = { coroutine.launch { viewModel.loadPending() } }
                            )
                        }
                    )
                    Spacer(Modifier.size(4.dp))
                    Button(
                        label = stringResource(Res.string.reject_selected),
                        loading = viewModel.loading,
                        enabled = !viewModel.loading && viewModel.selected.isNotEmpty(),
                        onClick = {
                            logger.warning { "Rechazando seleccionados" }
                            callService(
                                coroutineScope = coroutine,
                                snackbarHostState = snackbarHostState,
                                setLoading = { viewModel.loading = it },
                                serviceCall = { viewModel.rejectSelected() },
                                onSuccess = { coroutine.launch { viewModel.loadPending() } }
                            )
                        }
                    )
                }
            }
        }
    }
}
