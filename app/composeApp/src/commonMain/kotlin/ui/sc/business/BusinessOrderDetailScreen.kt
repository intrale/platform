@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package ui.sc.business
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import asdo.business.BusinessOrderDetail
import asdo.business.BusinessOrderItem
import asdo.business.BusinessOrderStatus
import asdo.business.BusinessOrderStatusEvent
import asdo.business.validTransitions
import kotlinx.coroutines.launch
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.shared.Screen
import ui.th.elevations
import ui.th.spacing
import ui.util.formatPrice

const val BUSINESS_ORDER_DETAIL_PATH = "/business/orders/detail"

class BusinessOrderDetailScreen : Screen(BUSINESS_ORDER_DETAIL_PATH) {
    override val messageTitle: MessageKey = MessageKey.business_order_detail_title
    private val logger = LoggerFactory.default.newLogger<BusinessOrderDetailScreen>()

    @Composable
    override fun screen() {
        val viewModel: BusinessOrderDetailViewModel = viewModel { BusinessOrderDetailViewModel() }
        val state = viewModel.state
        val scrollState = rememberScrollState()
        val coroutineScope = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }
        LaunchedEffect(Unit) { logger.info { "Cargando detalle del pedido de negocio" }; viewModel.loadDetail() }
        val successMessage = Txt(MessageKey.business_order_detail_status_updated)
        LaunchedEffect(state.statusUpdateSuccess) { if (state.statusUpdateSuccess) { snackbarHostState.showSnackbar(successMessage); viewModel.clearStatusFeedback() } }
        LaunchedEffect(state.statusUpdateError) { state.statusUpdateError?.let { snackbarHostState.showSnackbar(it); viewModel.clearStatusFeedback() } }
        val titleText = Txt(MessageKey.business_order_detail_title)
        val backLabel = Txt(MessageKey.business_order_detail_back)
        val errorText = Txt(MessageKey.business_order_detail_error)
        val retryText = Txt(MessageKey.business_order_detail_retry)
        if (state.showCancelDialog) { CancelOrderDialog(reason = state.cancelReason, reasonError = state.cancelReasonError, onReasonChanged = { viewModel.updateCancelReason(it) }, onConfirm = { coroutineScope.launch { viewModel.confirmCancel() } }, onDismiss = { viewModel.dismissCancelDialog() }) }
        Scaffold(topBar = { TopAppBar(title = { Text(text = state.detail?.let { titleText + " #" + it.shortCode } ?: titleText) }, navigationIcon = { IconButton(onClick = { goBack() }) { Icon(imageVector = Icons.AutoMirrored.Filled.ArrowBack, contentDescription = backLabel) } }) }, snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
            Column(modifier = Modifier.fillMaxSize().padding(padding).verticalScroll(scrollState).padding(horizontal = MaterialTheme.spacing.x4, vertical = MaterialTheme.spacing.x3), verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)) {
                when (state.screenStatus) {
                    BusinessOrderDetailStatus.Idle, BusinessOrderDetailStatus.Loading -> { Box(modifier = Modifier.fillMaxWidth().padding(vertical = MaterialTheme.spacing.x6), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
                    BusinessOrderDetailStatus.Error -> { Card(modifier = Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) { Column(modifier = Modifier.fillMaxWidth().padding(MaterialTheme.spacing.x4), verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2), horizontalAlignment = Alignment.CenterHorizontally) { Text(text = state.errorMessage ?: errorText, color = MaterialTheme.colorScheme.onErrorContainer); TextButton(onClick = { coroutineScope.launch { viewModel.loadDetail() } }) { Text(retryText) }; TextButton(onClick = { goBack() }) { Text(backLabel) } } } }
                    BusinessOrderDetailStatus.Loaded -> { state.detail?.let { detail -> StatusActionSection(detail = detail, isUpdating = state.updatingStatus, onAdvance = { newStatus -> if (newStatus == BusinessOrderStatus.CANCELLED) viewModel.showCancelDialog() else coroutineScope.launch { viewModel.advanceStatus(newStatus) } }); ClientInfoSection(detail); if (detail.deliveryAddress != null) DeliveryAddressSection(detail); ItemsSection(detail.items, detail.total); if (detail.statusHistory.isNotEmpty()) StatusHistorySection(detail.statusHistory) } }
                }
                Spacer(modifier = Modifier.height(MaterialTheme.spacing.x6))
            }
        }
    }
}

@Composable private fun StatusActionSection(detail: BusinessOrderDetail, isUpdating: Boolean, onAdvance: (BusinessOrderStatus) -> Unit) { Card(modifier = Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer), elevation = CardDefaults.cardElevation(defaultElevation = MaterialTheme.elevations.level1)) { Column(modifier = Modifier.fillMaxWidth().padding(MaterialTheme.spacing.x3), verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)) { Text(text = Txt(MessageKey.business_order_detail_section_status), style = MaterialTheme.typography.titleMedium); Text(text = statusLabel(detail.status), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onPrimaryContainer); if (isUpdating) { Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) { CircularProgressIndicator(modifier = Modifier.size(24.dp)) } } else { detail.status.validTransitions().forEach { nextStatus -> if (nextStatus == BusinessOrderStatus.CANCELLED) { OutlinedButton(onClick = { onAdvance(nextStatus) }, modifier = Modifier.fillMaxWidth(), colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error), border = BorderStroke(width = 1.dp, color = MaterialTheme.colorScheme.error)) { Text(text = Txt(MessageKey.business_order_detail_action_cancel)) } } else { IntralePrimaryButton(text = actionLabel(nextStatus), onClick = { onAdvance(nextStatus) }, modifier = Modifier.fillMaxWidth()) } } } } } }
@Composable private fun ClientInfoSection(detail: BusinessOrderDetail) { SectionCard(title = Txt(MessageKey.business_order_detail_section_client)) { LabeledField(label = Txt(MessageKey.business_order_detail_client_email), value = detail.clientEmail); detail.clientName?.let { name -> LabeledField(label = Txt(MessageKey.business_order_detail_client_name), value = name) }; LabeledField(label = Txt(MessageKey.business_order_detail_date), value = detail.createdAt.formatDateTime()) } }
@Composable private fun DeliveryAddressSection(detail: BusinessOrderDetail) { SectionCard(title = Txt(MessageKey.business_order_detail_section_address)) { detail.deliveryAddress?.let { Text(text = it, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold) }; detail.deliveryCity?.let { Text(text = it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }; detail.deliveryReference?.let { Text(text = it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } } }
@Composable private fun ItemsSection(items: List<BusinessOrderItem>, total: Double) { SectionCard(title = Txt(MessageKey.business_order_detail_section_items)) { items.forEachIndexed { index, item -> if (index > 0) HorizontalDivider(modifier = Modifier.padding(vertical = MaterialTheme.spacing.x1)); OrderItemRow(item) }; HorizontalDivider(modifier = Modifier.padding(vertical = MaterialTheme.spacing.x2)); Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(text = Txt(MessageKey.business_order_detail_total), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold); Text(text = formatPrice(total), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary) } } }
@Composable private fun OrderItemRow(item: BusinessOrderItem) { Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x0_5)) { Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) { Text(text = item.name, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f)); Text(text = formatPrice(item.subtotal), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.primary) }; Text(text = item.quantity.toString() + " x " + formatPrice(item.unitPrice), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
@Composable private fun StatusHistorySection(history: List<BusinessOrderStatusEvent>) { SectionCard(title = Txt(MessageKey.business_order_detail_section_history)) { history.forEachIndexed { index, event -> if (index > 0) HorizontalDivider(modifier = Modifier.padding(vertical = MaterialTheme.spacing.x1)); Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) { Text(text = statusLabel(event.status), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.primary); Text(text = event.timestamp.formatDateTime(), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }; event.message?.let { msg -> Text(text = msg, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } } } }
@Composable private fun CancelOrderDialog(reason: String, reasonError: Boolean, onReasonChanged: (String) -> Unit, onConfirm: () -> Unit, onDismiss: () -> Unit) { AlertDialog(onDismissRequest = onDismiss, title = { Text(text = Txt(MessageKey.business_order_detail_cancel_title)) }, text = { Column(verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)) { Text(text = Txt(MessageKey.business_order_detail_cancel_message)); OutlinedTextField(value = reason, onValueChange = onReasonChanged, modifier = Modifier.fillMaxWidth(), placeholder = { Text(text = Txt(MessageKey.business_order_detail_cancel_reason_hint)) }, isError = reasonError, supportingText = if (reasonError) { { Text(text = Txt(MessageKey.business_order_detail_cancel_reason_required)) } } else null, maxLines = 3) } }, confirmButton = { TextButton(onClick = onConfirm) { Text(text = Txt(MessageKey.business_order_detail_cancel_confirm), color = MaterialTheme.colorScheme.error) } }, dismissButton = { TextButton(onClick = onDismiss) { Text(text = Txt(MessageKey.business_order_detail_cancel_dismiss)) } }) }
@Composable private fun SectionCard(title: String, content: @Composable () -> Unit) { Card(modifier = Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface), elevation = CardDefaults.cardElevation(defaultElevation = MaterialTheme.elevations.level1)) { Column(modifier = Modifier.fillMaxWidth().padding(MaterialTheme.spacing.x3), verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)) { Text(text = title, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary); content() } } }
@Composable private fun LabeledField(label: String, value: String) { Column(verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x0_5)) { Text(text = label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant); Text(text = value, style = MaterialTheme.typography.bodyMedium) } }
@Composable private fun statusLabel(status: BusinessOrderStatus): String = when (status) { BusinessOrderStatus.PENDING -> Txt(MessageKey.business_orders_status_pending); BusinessOrderStatus.CONFIRMED -> Txt(MessageKey.business_orders_status_confirmed); BusinessOrderStatus.PREPARING -> Txt(MessageKey.business_orders_status_preparing); BusinessOrderStatus.READY -> Txt(MessageKey.business_orders_status_ready); BusinessOrderStatus.DELIVERING -> Txt(MessageKey.business_orders_status_delivering); BusinessOrderStatus.DELIVERED -> Txt(MessageKey.business_orders_status_delivered); BusinessOrderStatus.CANCELLED -> Txt(MessageKey.business_orders_status_cancelled); BusinessOrderStatus.FLAGGED -> Txt(MessageKey.business_orders_status_flagged); BusinessOrderStatus.UNKNOWN -> Txt(MessageKey.business_orders_status_pending) }
@Composable private fun actionLabel(status: BusinessOrderStatus): String = when (status) { BusinessOrderStatus.PREPARING -> Txt(MessageKey.business_order_detail_action_prepare); BusinessOrderStatus.DELIVERING -> Txt(MessageKey.business_order_detail_action_send); BusinessOrderStatus.DELIVERED -> Txt(MessageKey.business_order_detail_action_deliver); BusinessOrderStatus.PENDING -> Txt(MessageKey.business_order_detail_action_approve_flagged); else -> status.name }
@Suppress("MagicNumber") private fun String.formatDateTime(): String { if (isBlank()) return ""; return try { val d = substringBefore("T"); val t = substringAfter("T").take(5); val p = d.split("-"); if (p.size == 3) p[2] + "/" + p[1] + "/" + p[0] + " " + t else this } catch (_: Exception) { this } }
