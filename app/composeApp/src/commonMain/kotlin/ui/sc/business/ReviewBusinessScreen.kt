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
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.ExperimentalResourceApi
import ui.cp.buttons.Button
import ui.cp.inputs.TextField
import ui.rs.Res
import ui.rs.approve
import ui.rs.approve_selected
import ui.rs.auto_accept_deliveries
import ui.rs.code
import ui.rs.description
import ui.rs.email_admin
import ui.rs.pending_requests
import ui.rs.reject
import ui.rs.reject_selected
import ui.rs.select_all
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.th.spacing
import ui.sc.shared.Screen
import ui.sc.shared.callService
import ui.util.RES_ERROR_PREFIX
import ui.util.fb
import ui.util.resString

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
                Text(
                    resString(
                        composeId = Res.string.pending_requests,
                        fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Solicitudes pendientes"),
                    )
                )
                Spacer(Modifier.size(MaterialTheme.spacing.x1_5))
                TextField(
                    Res.string.code,
                    value = viewModel.state.twoFactorCode,
                    state = viewModel.inputsStates[ReviewBusinessViewModel.UIState::twoFactorCode.name]!!,
                    onValueChange = { viewModel.state = viewModel.state.copy(twoFactorCode = it) }
                )
                Spacer(Modifier.size(MaterialTheme.spacing.x1_5))
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
                ) {
                    Checkbox(
                        checked = viewModel.selected.size == viewModel.pending.size && viewModel.pending.isNotEmpty(),
                        onCheckedChange = { checked ->
                            if (checked) viewModel.selectAll() else viewModel.clearSelection()
                        }
                    )
                    Text(
                        resString(
                            composeId = Res.string.select_all,
                            fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Seleccionar todo"),
                        )
                    )
                }
                Spacer(Modifier.size(MaterialTheme.spacing.x1_5))
                viewModel.pending.forEach { biz ->
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(MaterialTheme.spacing.x1),
                        colors = CardDefaults.cardColors()
                    ) {
                        Row(
                            Modifier.padding(MaterialTheme.spacing.x1),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Checkbox(
                                checked = viewModel.selected.contains(biz.publicId),
                                onCheckedChange = { viewModel.toggleSelection(biz.publicId) }
                            )
                            Column(modifier = Modifier.weight(1f)) {
                                Text(biz.name)
                                val descriptionLabel = resString(
                                    composeId = Res.string.description,
                                    fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Descripcion"),
                                )
                                val emailLabel = resString(
                                    composeId = Res.string.email_admin,
                                    fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Correo administrador"),
                                )
                                val autoAcceptLabel = resString(
                                    composeId = Res.string.auto_accept_deliveries,
                                    fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Auto aceptar entregas"),
                                )
                                Text("$descriptionLabel: ${biz.description}")
                                Text("$emailLabel: ${biz.emailAdmin}")
                                Text("$autoAcceptLabel: ${biz.autoAcceptDeliveries}")
                            }
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                val approveLabel = resString(
                                    composeId = Res.string.approve,
                                    fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Aprobar"),
                                )
                                Button(
                                    label = approveLabel,
                                    loading = viewModel.loading,
                                    enabled = !viewModel.loading,
                                    onClick = {
                                        logger.info { "Aprobando negocio ${biz.publicId}" }
                                        callService(
                                            coroutineScope = coroutine,
                                            snackbarHostState = snackbarHostState,
                                            setLoading = { viewModel.loading = it },
                                            serviceCall = { viewModel.approve(biz.publicId) },
                                            onSuccess = { coroutine.launch { viewModel.loadPending() } }
                                        )
                                    }
                                )
                                Spacer(Modifier.size(MaterialTheme.spacing.x0_5))
                                val rejectLabel = resString(
                                    composeId = Res.string.reject,
                                    fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Rechazar"),
                                )
                                Button(
                                    label = rejectLabel,
                                    loading = viewModel.loading,
                                    enabled = !viewModel.loading,
                                    onClick = {
                                        logger.warning { "Rechazando negocio ${biz.publicId}" }
                                        callService(
                                            coroutineScope = coroutine,
                                            snackbarHostState = snackbarHostState,
                                            setLoading = { viewModel.loading = it },
                                            serviceCall = { viewModel.reject(biz.publicId) },
                                            onSuccess = { coroutine.launch { viewModel.loadPending() } }
                                        )
                                    }
                                )
                            }
                        }
                    }
                }
                Spacer(Modifier.size(MaterialTheme.spacing.x1_5))
                Row(
                    horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
                ) {
                    val approveSelectedLabel = resString(
                        composeId = Res.string.approve_selected,
                        fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Aprobar seleccionados"),
                    )
                    Button(
                        label = approveSelectedLabel,
                        loading = viewModel.loading,
                        enabled = !viewModel.loading && viewModel.selected.isNotEmpty(),
                        onClick = {
                            logger.info { "Aprobando seleccionados" }
                            callService(
                                coroutineScope = coroutine,
                                snackbarHostState = snackbarHostState,
                                setLoading = { viewModel.loading = it },
                                serviceCall = {
                                    try {
                                        viewModel.approveSelected()
                                        Result.success(Unit)
                                    } catch (e: Throwable) {
                                        Result.failure(e)
                                    }},
                                onSuccess = { coroutine.launch { viewModel.loadPending() } }
                            )
                        }
                    )
                    val rejectSelectedLabel = resString(
                        composeId = Res.string.reject_selected,
                        fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Rechazar seleccionados"),
                    )
                    Button(
                        label = rejectSelectedLabel,
                        loading = viewModel.loading,
                        enabled = !viewModel.loading && viewModel.selected.isNotEmpty(),
                        onClick = {
                            logger.warning { "Rechazando seleccionados" }
                            callService(
                                coroutineScope = coroutine,
                                snackbarHostState = snackbarHostState,
                                setLoading = { viewModel.loading = it },
                                serviceCall = {
                                    try {
                                    viewModel.rejectSelected()
                                        Result.success(Unit)
                                    } catch (e: Throwable) {
                                        Result.failure(e)
                                    }},
                                onSuccess = { coroutine.launch { viewModel.loadPending() } }
                            )
                        }
                    )
                }
            }
        }
    }
}
