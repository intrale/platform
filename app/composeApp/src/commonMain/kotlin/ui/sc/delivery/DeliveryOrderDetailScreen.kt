package ui.sc.delivery

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Place
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import ui.util.rememberOpenExternalMap
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import asdo.delivery.DeliveryOrderDetail
import asdo.delivery.DeliveryOrderItem
import asdo.delivery.DeliveryOrderStatus
import kotlinx.coroutines.launch
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.shared.Screen
import ui.th.elevations
import ui.th.spacing

const val DELIVERY_ORDER_DETAIL_PATH = "/delivery/order/detail"

class DeliveryOrderDetailScreen : Screen(DELIVERY_ORDER_DETAIL_PATH) {

    override val messageTitle: MessageKey = MessageKey.delivery_order_detail_title

    private val logger = LoggerFactory.default.newLogger<DeliveryOrderDetailScreen>()

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    override fun screen() {
        val viewModel: DeliveryOrderDetailViewModel = viewModel { DeliveryOrderDetailViewModel() }
        val state = viewModel.state
        val scrollState = rememberScrollState()
        val coroutineScope = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }

        LaunchedEffect(Unit) {
            logger.info { "[Delivery] Cargando detalle del pedido" }
            viewModel.loadDetail()
        }

        val successMessage = Txt(MessageKey.delivery_order_status_updated)
        val notDeliveredSuccessMessage = Txt(MessageKey.delivery_order_not_delivered_success)

        LaunchedEffect(state.statusUpdateSuccess) {
            if (state.statusUpdateSuccess) {
                snackbarHostState.showSnackbar(successMessage)
                viewModel.clearStatusFeedback()
            }
        }

        LaunchedEffect(state.notDeliveredSuccess) {
            if (state.notDeliveredSuccess) {
                snackbarHostState.showSnackbar(notDeliveredSuccessMessage)
                viewModel.clearStatusFeedback()
            }
        }

        LaunchedEffect(state.statusUpdateError) {
            state.statusUpdateError?.let {
                snackbarHostState.showSnackbar(it)
                viewModel.clearStatusFeedback()
            }
        }

        val titleText = Txt(MessageKey.delivery_order_detail_title)
        val backLabel = Txt(MessageKey.delivery_order_detail_back)
        val errorText = Txt(MessageKey.delivery_order_detail_error)
        val retryText = Txt(MessageKey.delivery_order_detail_retry)
        val noMapAppMessage = Txt(MessageKey.delivery_order_detail_location_no_address)

        if (state.showDeliveredConfirmDialog) {
            DeliveredConfirmDialog(
                orderLabel = state.detail?.label ?: "",
                onConfirm = { coroutineScope.launch { viewModel.confirmDelivered() } },
                onDismiss = { viewModel.dismissDeliveredConfirm() }
            )
        }

        if (state.showNotDeliveredSheet) {
            NotDeliveredBottomSheet(
                state = state,
                onReasonSelected = { viewModel.selectNotDeliveredReason(it) },
                onOtherTextChanged = { viewModel.updateNotDeliveredOtherText(it) },
                onConfirm = { coroutineScope.launch { viewModel.confirmNotDelivered() } },
                onDismiss = { viewModel.dismissNotDeliveredSheet() }
            )
        }

        Scaffold(
            topBar = {
                TopAppBar(
                    title = {
                        Text(
                            text = state.detail?.let { "${titleText} ${it.label}" } ?: titleText
                        )
                    },
                    navigationIcon = {
                        IconButton(onClick = { goBack() }) {
                            Icon(
                                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = backLabel
                            )
                        }
                    }
                )
            },
            snackbarHost = { SnackbarHost(snackbarHostState) }
        ) { padding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .verticalScroll(scrollState)
                    .padding(horizontal = MaterialTheme.spacing.x4, vertical = MaterialTheme.spacing.x3),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
            ) {
                when (state.status) {
                    DeliveryOrderDetailStatus.Idle,
                    DeliveryOrderDetailStatus.Loading -> {
                        DeliveryLoading()
                    }

                    DeliveryOrderDetailStatus.Error -> {
                        DeliveryStateCard(
                            message = state.errorMessage ?: errorText,
                            actionLabel = retryText,
                            onAction = { coroutineScope.launch { viewModel.loadDetail() } }
                        )
                    }

                    DeliveryOrderDetailStatus.Loaded -> {
                        state.detail?.let { detail ->
                            OrderStatusSection(
                                detail = detail,
                                isUpdating = state.updatingStatus,
                                onStartDelivery = {
                                    coroutineScope.launch {
                                        viewModel.updateStatus(DeliveryOrderStatus.IN_PROGRESS)
                                    }
                                },
                                onConfirmDelivered = { viewModel.showDeliveredConfirm() },
                                onNotDelivered = { viewModel.showNotDeliveredSheet() }
                            )
                            LocationSection(detail) {
                                coroutineScope.launch {
                                    snackbarHostState.showSnackbar(noMapAppMessage)
                                }
                            }
                            BusinessSection(detail)
                            CustomerSection(detail)
                            ItemsSection(detail.items)
                            PaymentSection(detail)
                            detail.notes?.let { notes ->
                                NotesSection(notes)
                            }
                        }
                    }
                }

                Spacer(modifier = Modifier.height(MaterialTheme.spacing.x6))
            }
        }
    }
}

@Composable
private fun OrderStatusSection(
    detail: DeliveryOrderDetail,
    isUpdating: Boolean,
    onStartDelivery: () -> Unit,
    onConfirmDelivered: () -> Unit,
    onNotDelivered: () -> Unit
) {
    val sectionTitle = Txt(MessageKey.delivery_order_detail_section_status)

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
        elevation = CardDefaults.cardElevation(defaultElevation = MaterialTheme.elevations.level1)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
        ) {
            Text(
                text = sectionTitle,
                style = MaterialTheme.typography.titleMedium
            )
            Text(
                text = orderStatusLabel(detail.status),
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onPrimaryContainer
            )

            detail.eta?.let { eta ->
                Text(
                    text = Txt(MessageKey.delivery_order_detail_eta, mapOf("eta" to eta)),
                    style = MaterialTheme.typography.bodyMedium
                )
            }
            detail.distance?.let { distance ->
                Text(
                    text = Txt(MessageKey.delivery_order_detail_distance, mapOf("distance" to distance)),
                    style = MaterialTheme.typography.bodyMedium
                )
            }

            if (isUpdating) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.Center
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(24.dp))
                }
            } else {
                when (detail.status) {
                    DeliveryOrderStatus.PENDING -> {
                        IntralePrimaryButton(
                            text = Txt(MessageKey.delivery_order_action_start),
                            onClick = onStartDelivery,
                            modifier = Modifier.fillMaxWidth()
                        )
                    }
                    DeliveryOrderStatus.IN_PROGRESS -> {
                        IntralePrimaryButton(
                            text = Txt(MessageKey.delivery_order_action_deliver),
                            onClick = onConfirmDelivered,
                            modifier = Modifier.fillMaxWidth()
                        )
                        OutlinedButton(
                            onClick = onNotDelivered,
                            modifier = Modifier.fillMaxWidth(),
                            colors = ButtonDefaults.outlinedButtonColors(
                                contentColor = MaterialTheme.colorScheme.error
                            ),
                            border = BorderStroke(
                                width = 1.dp,
                                color = MaterialTheme.colorScheme.error
                            )
                        ) {
                            Text(text = Txt(MessageKey.delivery_order_action_not_delivered))
                        }
                    }
                    else -> { /* Sin acciones para DELIVERED, NOT_DELIVERED y UNKNOWN */ }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DeliveredConfirmDialog(
    orderLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(text = Txt(MessageKey.delivery_order_confirm_title))
        },
        text = {
            Text(
                text = Txt(
                    MessageKey.delivery_order_confirm_message,
                    mapOf("label" to orderLabel)
                )
            )
        },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(
                    text = Txt(MessageKey.delivery_order_confirm_yes),
                    color = MaterialTheme.colorScheme.primary
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(text = Txt(MessageKey.delivery_order_confirm_cancel))
            }
        }
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NotDeliveredBottomSheet(
    state: DeliveryOrderDetailUiState,
    onReasonSelected: (NotDeliveredReason) -> Unit,
    onOtherTextChanged: (String) -> Unit,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = MaterialTheme.spacing.x4)
                .padding(bottom = MaterialTheme.spacing.x6),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
        ) {
            Text(
                text = Txt(MessageKey.delivery_order_not_delivered_sheet_title),
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold
            )

            if (state.notDeliveredReasonError) {
                Text(
                    text = Txt(MessageKey.delivery_order_not_delivered_reason_required),
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall
                )
            }

            val reasons = listOf(
                NotDeliveredReason.ABSENT to Txt(MessageKey.delivery_order_not_delivered_reason_absent),
                NotDeliveredReason.WRONG_ADDRESS to Txt(MessageKey.delivery_order_not_delivered_reason_wrong_address),
                NotDeliveredReason.REJECTED to Txt(MessageKey.delivery_order_not_delivered_reason_rejected),
                NotDeliveredReason.PAYMENT to Txt(MessageKey.delivery_order_not_delivered_reason_payment),
                NotDeliveredReason.OTHER to Txt(MessageKey.delivery_order_not_delivered_reason_other)
            )

            reasons.forEach { (reason, label) ->
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    RadioButton(
                        selected = state.selectedNotDeliveredReason == reason,
                        onClick = { onReasonSelected(reason) }
                    )
                    Text(
                        text = label,
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.weight(1f)
                    )
                }
            }

            if (state.selectedNotDeliveredReason == NotDeliveredReason.OTHER) {
                OutlinedTextField(
                    value = state.notDeliveredOtherText,
                    onValueChange = onOtherTextChanged,
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text(text = Txt(MessageKey.delivery_order_not_delivered_other_hint)) },
                    isError = state.notDeliveredOtherError,
                    supportingText = if (state.notDeliveredOtherError) {
                        { Text(text = Txt(MessageKey.delivery_order_not_delivered_other_required)) }
                    } else null,
                    maxLines = 3
                )
            }

            Spacer(modifier = Modifier.height(MaterialTheme.spacing.x2))

            IntralePrimaryButton(
                text = Txt(MessageKey.delivery_order_confirm_yes),
                onClick = onConfirm,
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
}

@Composable
private fun LocationSection(detail: DeliveryOrderDetail, onOpenMapFailed: () -> Unit) {
    val sectionTitle = Txt(MessageKey.delivery_order_detail_section_location)
    val originLabel = Txt(MessageKey.delivery_order_detail_location_origin)
    val destinationLabel = Txt(MessageKey.delivery_order_detail_location_destination)
    val openMapLabel = Txt(MessageKey.delivery_order_detail_location_open_map)
    val noAddressLabel = Txt(MessageKey.delivery_order_detail_location_no_address)
    val mapPlaceholderLabel = Txt(MessageKey.delivery_order_detail_location_map_placeholder)

    val openExternalMap = rememberOpenExternalMap()

    SectionCard(title = sectionTitle) {
        // Placeholder de mapa
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(120.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant)
                .semantics { contentDescription = mapPlaceholderLabel },
            contentAlignment = Alignment.Center
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
            ) {
                Icon(
                    imageVector = Icons.Default.Place,
                    contentDescription = null,
                    modifier = Modifier.size(32.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    text = mapPlaceholderLabel,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }

        HorizontalDivider(modifier = Modifier.padding(vertical = MaterialTheme.spacing.x1))

        // Origen (comercio)
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1),
            verticalAlignment = Alignment.Top
        ) {
            Icon(
                imageVector = Icons.Default.LocationOn,
                contentDescription = null,
                modifier = Modifier.size(20.dp),
                tint = MaterialTheme.colorScheme.primary
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = originLabel,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    text = detail.businessName,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium
                )
                Text(
                    text = detail.neighborhood,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }

        // Destino (cliente)
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1),
            verticalAlignment = Alignment.Top
        ) {
            Icon(
                imageVector = Icons.Default.Place,
                contentDescription = null,
                modifier = Modifier.size(20.dp),
                tint = MaterialTheme.colorScheme.error
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = destinationLabel,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                if (detail.address != null) {
                    Text(
                        text = detail.address,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium
                    )
                    detail.distance?.let { distance ->
                        Text(
                            text = distance,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                } else {
                    Text(
                        text = noAddressLabel,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }

        // Botón "Abrir en mapa"
        if (detail.address != null) {
            IntralePrimaryButton(
                text = openMapLabel,
                onClick = {
                    val opened = openExternalMap(detail.address)
                    if (!opened) {
                        onOpenMapFailed()
                    }
                },
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
}

@Composable
private fun BusinessSection(detail: DeliveryOrderDetail) {
    val sectionTitle = Txt(MessageKey.delivery_order_detail_section_business)
    val addressLabel = Txt(MessageKey.delivery_order_detail_address)
    val notesLabel = Txt(MessageKey.delivery_order_detail_address_notes)

    SectionCard(title = sectionTitle) {
        Text(
            text = detail.businessName,
            style = MaterialTheme.typography.titleSmall
        )
        Text(
            text = detail.neighborhood,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        detail.address?.let { address ->
            LabeledField(label = addressLabel, value = address)
        }
        detail.addressNotes?.let { notes ->
            LabeledField(label = notesLabel, value = notes)
        }
    }
}

@Composable
private fun CustomerSection(detail: DeliveryOrderDetail) {
    val sectionTitle = Txt(MessageKey.delivery_order_detail_section_customer)
    val nameLabel = Txt(MessageKey.delivery_order_detail_customer_name)
    val phoneLabel = Txt(MessageKey.delivery_order_detail_customer_phone)
    val addressLabel = Txt(MessageKey.delivery_order_detail_address)
    val notesLabel = Txt(MessageKey.delivery_order_detail_address_notes)

    SectionCard(title = sectionTitle) {
        detail.customerName?.let { name ->
            LabeledField(label = nameLabel, value = name)
        }
        detail.customerPhone?.let { phone ->
            LabeledField(label = phoneLabel, value = phone)
        }
        detail.address?.let { address ->
            LabeledField(label = addressLabel, value = address)
        }
        detail.addressNotes?.let { notes ->
            LabeledField(label = notesLabel, value = notes)
        }
    }
}

@Composable
private fun ItemsSection(items: List<DeliveryOrderItem>) {
    val sectionTitle = Txt(MessageKey.delivery_order_detail_section_items)
    val itemsCount = Txt(MessageKey.delivery_order_detail_items_count, mapOf("count" to items.size.toString()))

    SectionCard(title = sectionTitle) {
        Text(
            text = itemsCount,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        items.forEachIndexed { index, item ->
            if (index > 0) {
                HorizontalDivider(modifier = Modifier.padding(vertical = MaterialTheme.spacing.x1))
            }
            OrderItemRow(item)
        }
    }
}

@Composable
private fun OrderItemRow(item: DeliveryOrderItem) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x0_5)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = item.name,
                style = MaterialTheme.typography.bodyLarge,
                modifier = Modifier.weight(1f)
            )
            Text(
                text = Txt(MessageKey.delivery_order_detail_item_quantity, mapOf("quantity" to item.quantity.toString())),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.primary
            )
        }
        item.notes?.let { notes ->
            Text(
                text = Txt(MessageKey.delivery_order_detail_item_notes, mapOf("notes" to notes)),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun PaymentSection(detail: DeliveryOrderDetail) {
    val sectionTitle = Txt(MessageKey.delivery_order_detail_section_payment)
    val methodLabel = Txt(MessageKey.delivery_order_detail_payment_method)
    val collectLabel = Txt(MessageKey.delivery_order_detail_collect_on_delivery)
    val collectYes = Txt(MessageKey.delivery_order_detail_collect_on_delivery_yes)
    val collectNo = Txt(MessageKey.delivery_order_detail_collect_on_delivery_no)

    if (detail.paymentMethod == null && detail.collectOnDelivery == null) return

    SectionCard(title = sectionTitle) {
        detail.paymentMethod?.let { method ->
            LabeledField(label = methodLabel, value = method)
        }
        detail.collectOnDelivery?.let { collect ->
            LabeledField(
                label = collectLabel,
                value = if (collect) collectYes else collectNo
            )
        }
    }
}

@Composable
private fun NotesSection(notes: String) {
    val sectionTitle = Txt(MessageKey.delivery_order_detail_notes)

    SectionCard(title = sectionTitle) {
        Text(
            text = notes,
            style = MaterialTheme.typography.bodyMedium
        )
    }
}

@Composable
private fun SectionCard(
    title: String,
    content: @Composable () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = MaterialTheme.elevations.level1)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.primary
            )
            content()
        }
    }
}

@Composable
private fun LabeledField(label: String, value: String) {
    Column(
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x0_5)
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium
        )
    }
}
