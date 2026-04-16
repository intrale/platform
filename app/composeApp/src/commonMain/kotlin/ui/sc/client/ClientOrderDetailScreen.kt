package ui.sc.client

import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.shared.client.SkipReason
import asdo.client.ClientOrderDetail
import asdo.client.ClientOrderItem
import asdo.client.ClientOrderStatusEvent
import asdo.client.PriceChange
import asdo.client.RepeatOrderResult
import asdo.client.SkippedItem
import kotlinx.coroutines.launch
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.Screen
import ui.th.spacing
import ui.util.formatPrice

class ClientOrderDetailScreen : Screen(CLIENT_ORDER_DETAIL_PATH) {

    override val messageTitle: MessageKey = MessageKey.client_orders_detail_title

    @Composable
    override fun screen() {
        val logger = remember { LoggerFactory.default.newLogger<ClientOrderDetailScreen>() }
        val viewModel: ClientOrdersViewModel = viewModel { ClientOrdersViewModel() }
        val state = viewModel.state
        val snackbarHostState = remember { SnackbarHostState() }
        val coroutineScope = rememberCoroutineScope()
        val selectedOrderId by ClientOrderSelectionStore.selectedOrderId.collectAsState()

        val detailTitle = Txt(MessageKey.client_orders_detail_title)
        val itemsTitle = Txt(MessageKey.client_orders_detail_items_title)
        val addressTitle = Txt(MessageKey.client_orders_detail_address_title)
        val errorMessage = Txt(MessageKey.client_orders_error)
        val retryLabel = Txt(MessageKey.client_orders_retry)
        val dateLabel = Txt(MessageKey.client_orders_order_date)
        val backLabel = Txt(MessageKey.client_orders_detail_back)
        val paymentTitle = Txt(MessageKey.client_orders_detail_payment_title)
        val paymentMethod = Txt(MessageKey.client_orders_detail_payment_method)
        val statusTitle = Txt(MessageKey.client_orders_detail_status_title)
        val businessMessageTitle = Txt(MessageKey.client_orders_detail_business_message_title)
        val businessContactTitle = Txt(MessageKey.client_orders_detail_business_contact_title)
        val businessContactButton = Txt(MessageKey.client_orders_detail_business_contact_button)
        val noContactAvailable = Txt(MessageKey.client_orders_detail_no_contact_available)
        val repeatButton = Txt(MessageKey.client_orders_detail_repeat_button)
        val repeatSuccess = Txt(MessageKey.client_orders_detail_repeat_success)
        val repeatPartial = Txt(MessageKey.client_orders_detail_repeat_partial)
        val repeatNoItems = Txt(MessageKey.client_orders_detail_repeat_no_items)
        val repeatTitle = Txt(MessageKey.client_orders_detail_repeat_title)
        val repeatPriceChanged = Txt(MessageKey.client_orders_detail_repeat_price_changed)
        val repeatPriceBefore = Txt(MessageKey.client_orders_detail_repeat_price_before)
        val repeatPriceNow = Txt(MessageKey.client_orders_detail_repeat_price_now)
        val repeatItemsUnavailable = Txt(MessageKey.client_orders_detail_repeat_items_unavailable)
        val repeatViewCart = Txt(MessageKey.client_orders_detail_repeat_view_cart)
        val repeatAddedSection = Txt(MessageKey.client_orders_repeat_added_section)
        val repeatCloseLabel = Txt(MessageKey.client_orders_repeat_close)
        val reasonOutOfStock = Txt(MessageKey.client_orders_repeat_reason_out_of_stock)
        val reasonDiscontinued = Txt(MessageKey.client_orders_repeat_reason_discontinued)
        val reasonUnavailable = Txt(MessageKey.client_orders_repeat_reason_unavailable)
        val reasonUnknown = Txt(MessageKey.client_orders_repeat_reason_unknown)

        var showRepeatDialog by remember { mutableStateOf<RepeatOrderResult?>(null) }

        val statusLabels = remember {
            emptyMap<asdo.client.ClientOrderStatus, String>()
        }

        val statusPending = Txt(MessageKey.client_orders_status_pending)
        val statusConfirmed = Txt(MessageKey.client_orders_status_confirmed)
        val statusPreparing = Txt(MessageKey.client_orders_status_preparing)
        val statusReady = Txt(MessageKey.client_orders_status_ready)
        val statusDelivering = Txt(MessageKey.client_orders_status_delivering)
        val statusDelivered = Txt(MessageKey.client_orders_status_delivered)
        val statusCancelled = Txt(MessageKey.client_orders_status_cancelled)

        val resolvedStatusLabels = remember(
            statusPending, statusConfirmed, statusPreparing, statusReady,
            statusDelivering, statusDelivered, statusCancelled
        ) {
            mapOf(
                asdo.client.ClientOrderStatus.PENDING to statusPending,
                asdo.client.ClientOrderStatus.CONFIRMED to statusConfirmed,
                asdo.client.ClientOrderStatus.PREPARING to statusPreparing,
                asdo.client.ClientOrderStatus.READY to statusReady,
                asdo.client.ClientOrderStatus.DELIVERING to statusDelivering,
                asdo.client.ClientOrderStatus.DELIVERED to statusDelivered,
                asdo.client.ClientOrderStatus.CANCELLED to statusCancelled,
                asdo.client.ClientOrderStatus.UNKNOWN to statusPending
            )
        }

        LaunchedEffect(selectedOrderId) {
            selectedOrderId?.let { orderId ->
                logger.info { "Cargando detalle del pedido $orderId" }
                viewModel.loadOrderDetail(orderId)
            }
        }

        LaunchedEffect(state.detailError) {
            state.detailError?.let {
                snackbarHostState.showSnackbar(it)
            }
        }

        LaunchedEffect(state.repeatOrderResult) {
            state.repeatOrderResult?.let { result ->
                val hasChanges = result.skippedItems.isNotEmpty() || result.priceChangedItems.isNotEmpty()
                if (result.addedItems.isEmpty()) {
                    // Sin items agregados: snackbar directo
                    snackbarHostState.showSnackbar(repeatNoItems)
                    viewModel.clearRepeatOrderResult()
                } else if (hasChanges) {
                    // Hay cambios de precio o items excluidos: mostrar diálogo (CA-4, CA-5)
                    showRepeatDialog = result
                } else {
                    // Happy path: todo OK, snackbar y navegar al carrito
                    snackbarHostState.showSnackbar(repeatSuccess)
                    viewModel.clearRepeatOrderResult()
                    navigate(CLIENT_CART_PATH)
                }
            }
        }

        LaunchedEffect(state.repeatOrderError) {
            state.repeatOrderError?.let {
                snackbarHostState.showSnackbar(it)
                viewModel.clearRepeatOrderResult()
            }
        }

        // Diálogo de resultado de repetición con cambios de precio / items excluidos
        showRepeatDialog?.let { result ->
            RepeatOrderResultDialog(
                result = result,
                title = repeatTitle,
                priceChangedLabel = repeatPriceChanged,
                priceBeforeLabel = repeatPriceBefore,
                priceNowLabel = repeatPriceNow,
                itemsUnavailableLabel = repeatItemsUnavailable,
                addedLabel = repeatAddedSection,
                viewCartLabel = repeatViewCart,
                closeLabel = repeatCloseLabel,
                reasonOutOfStock = reasonOutOfStock,
                reasonDiscontinued = reasonDiscontinued,
                reasonUnavailable = reasonUnavailable,
                reasonUnknown = reasonUnknown,
                onViewCart = {
                    showRepeatDialog = null
                    viewModel.clearRepeatOrderResult()
                    navigate(CLIENT_CART_PATH)
                },
                onDismiss = {
                    showRepeatDialog = null
                    viewModel.clearRepeatOrderResult()
                }
            )
        }

        Scaffold(
            snackbarHost = { SnackbarHost(snackbarHostState) }
        ) { padding ->
            if (state.loadingDetail) {
                Box(
                    modifier = Modifier.fillMaxSize().padding(padding),
                    contentAlignment = Alignment.Center
                ) {
                    CircularProgressIndicator()
                }
            } else if (state.detailError != null && state.selectedOrder == null) {
                Box(
                    modifier = Modifier.fillMaxSize().padding(padding),
                    contentAlignment = Alignment.Center
                ) {
                    Card(
                        modifier = Modifier.fillMaxWidth().padding(MaterialTheme.spacing.x4),
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.errorContainer
                        )
                    ) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(MaterialTheme.spacing.x4),
                            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2),
                            horizontalAlignment = Alignment.CenterHorizontally
                        ) {
                            Text(
                                text = errorMessage,
                                textAlign = TextAlign.Center,
                                color = MaterialTheme.colorScheme.onErrorContainer
                            )
                            TextButton(onClick = {
                                coroutineScope.launch {
                                    selectedOrderId?.let { viewModel.loadOrderDetail(it) }
                                }
                            }) {
                                Text(retryLabel)
                            }
                            TextButton(onClick = { goBack() }) {
                                Text(backLabel)
                            }
                        }
                    }
                }
            } else {
                val detail = state.selectedOrder
                if (detail != null) {
                    OrderDetailContent(
                        detail = detail,
                        detailTitle = detailTitle,
                        dateLabel = dateLabel,
                        itemsTitle = itemsTitle,
                        addressTitle = addressTitle,
                        backLabel = backLabel,
                        statusLabel = resolvedStatusLabels[detail.status] ?: detail.status.name,
                        paymentTitle = paymentTitle,
                        paymentMethod = paymentMethod,
                        statusTitle = statusTitle,
                        businessMessageTitle = businessMessageTitle,
                        businessContactTitle = businessContactTitle,
                        businessContactButton = businessContactButton,
                        noContactAvailable = noContactAvailable,
                        repeatButton = repeatButton,
                        statusLabels = resolvedStatusLabels,
                        padding = padding,
                        repeatOrderLoading = state.repeatOrderLoading,
                        onBackClick = { goBack() },
                        onRepeatOrder = {
                            coroutineScope.launch {
                                viewModel.repeatOrderFromDetail(detail)
                            }
                        }
                    )
                }
            }
        }
    }
}

@Composable
private fun OrderDetailContent(
    detail: ClientOrderDetail,
    detailTitle: String,
    dateLabel: String,
    itemsTitle: String,
    addressTitle: String,
    backLabel: String,
    statusLabel: String,
    paymentTitle: String,
    paymentMethod: String,
    statusTitle: String,
    businessMessageTitle: String,
    businessContactTitle: String,
    businessContactButton: String,
    noContactAvailable: String,
    repeatButton: String,
    statusLabels: Map<asdo.client.ClientOrderStatus, String>,
    padding: PaddingValues,
    repeatOrderLoading: Boolean,
    onBackClick: () -> Unit,
    onRepeatOrder: () -> Unit
) {
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(padding)
            .padding(horizontal = MaterialTheme.spacing.x4),
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3),
        contentPadding = PaddingValues(vertical = MaterialTheme.spacing.x4)
    ) {
        item {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
            ) {
                IconButton(onClick = onBackClick) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                        contentDescription = backLabel
                    )
                }
                Text(
                    text = detailTitle,
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold
                )
            }
        }

        item {
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant
                )
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(MaterialTheme.spacing.x4),
                    verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = "#${detail.shortCode}",
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold
                        )
                        OrderStatusBadge(
                            label = statusLabel,
                            textColor = detail.status.toColor(),
                            backgroundColor = detail.status.toBackgroundColor()
                        )
                    }
                    Text(
                        text = detail.businessName,
                        style = MaterialTheme.typography.bodyLarge
                    )
                    Text(
                        text = "$dateLabel: ${detail.createdAt}",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    detail.promisedAt?.let { promised ->
                        Text(
                            text = "Entrega estimada: $promised",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    HorizontalDivider()
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            text = "Total",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            text = formatPrice(detail.total),
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.primary
                        )
                    }
                }
            }
        }

        item {
            Text(
                text = itemsTitle,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold
            )
        }

        items(detail.items, key = { it.id ?: it.name }) { item ->
            OrderItemRow(item = item)
        }

        if (detail.address != null) {
            item {
                Text(
                    text = addressTitle,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold
                )
            }
            item {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant
                    )
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(MaterialTheme.spacing.x4),
                        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
                    ) {
                        Text(
                            text = detail.address.label,
                            style = MaterialTheme.typography.bodyLarge,
                            fontWeight = FontWeight.SemiBold
                        )
                        Text(
                            text = "${detail.address.street} ${detail.address.number}",
                            style = MaterialTheme.typography.bodyMedium
                        )
                        Text(
                            text = detail.address.city,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        detail.address.reference?.let { ref ->
                            Text(
                                text = ref,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                }
            }
        }

        detail.paymentMethod?.let { method ->
            item {
                Text(
                    text = paymentTitle,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold
                )
            }
            item {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant
                    )
                ) {
                    Text(
                        text = method,
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.padding(MaterialTheme.spacing.x4)
                    )
                }
            }
        }

        if (detail.statusHistory.isNotEmpty()) {
            item {
                Text(
                    text = statusTitle,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold
                )
            }
            items(detail.statusHistory, key = { it.timestamp }) { event ->
                OrderStatusEventRow(event = event, statusLabels = statusLabels)
            }
        }

        detail.businessMessage?.let { message ->
            item {
                Text(
                    text = businessMessageTitle,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold
                )
            }
            item {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.tertiaryContainer
                    )
                ) {
                    Text(
                        text = message,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(MaterialTheme.spacing.x4),
                        color = MaterialTheme.colorScheme.onTertiaryContainer
                    )
                }
            }
        }

        detail.businessPhone?.let { phone ->
            item {
                Text(
                    text = businessContactTitle,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold
                )
            }
            item {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.primaryContainer
                    )
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(MaterialTheme.spacing.x4),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(
                            modifier = Modifier.weight(1f),
                            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x0_5)
                        ) {
                            Text(
                                text = phone,
                                style = MaterialTheme.typography.bodyLarge,
                                fontWeight = FontWeight.Medium
                            )
                        }
                        TextButton(onClick = { /* TODO: handle phone call */ }) {
                            Text(businessContactButton)
                        }
                    }
                }
            }
        } ?: run {
            if (detail.statusHistory.isNotEmpty() || detail.businessMessage != null) {
                item {
                    Text(
                        text = noContactAvailable,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(MaterialTheme.spacing.x4)
                    )
                }
            }
        }

        if (detail.status == asdo.client.ClientOrderStatus.DELIVERED) {
            item {
                Button(
                    onClick = onRepeatOrder,
                    enabled = !repeatOrderLoading,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    if (repeatOrderLoading) {
                        CircularProgressIndicator(
                            modifier = Modifier.padding(end = MaterialTheme.spacing.x2),
                            strokeWidth = MaterialTheme.spacing.x0_5
                        )
                    }
                    Text(text = repeatButton)
                }
            }
        }
    }
}

@Composable
private fun OrderStatusEventRow(
    event: ClientOrderStatusEvent,
    statusLabels: Map<asdo.client.ClientOrderStatus, String>
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        )
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = statusLabels[event.status] ?: event.status.name,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Medium,
                    color = MaterialTheme.colorScheme.primary
                )
                Text(
                    text = event.timestamp,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            event.message?.let { msg ->
                Text(
                    text = msg,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

@Composable
private fun OrderItemRow(item: ClientOrderItem) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x0_5)
            ) {
                Text(
                    text = item.name,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Medium
                )
                Text(
                    text = "${item.quantity} x ${formatPrice(item.unitPrice)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Text(
                text = formatPrice(item.subtotal),
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.primary
            )
        }
    }
}

/**
 * Diálogo informativo que muestra el resultado de repetir un pedido
 * cuando hay cambios de precio y/o items no disponibles.
 *
 * Cumple criterios de aceptación de #2062:
 * - CA-2: Lista de productos agregados con nombre y cantidad.
 * - CA-3: Lista de productos excluidos con motivo individual (SkipReason).
 * - CA-4: Fallback "No disponible" si el motivo es desconocido.
 * - CA-7: Botón "Ir al carrito" sólo si hay items agregados.
 * - CA-9: Accesibilidad — contentDescription por item.
 * - CA-10: Nombres largos truncados con ellipsis.
 * - CA-11: Contador "(N)" sólo cuando hay más de 1 item.
 */
@Composable
private fun RepeatOrderResultDialog(
    result: RepeatOrderResult,
    title: String,
    priceChangedLabel: String,
    priceBeforeLabel: String,
    priceNowLabel: String,
    itemsUnavailableLabel: String,
    addedLabel: String,
    viewCartLabel: String,
    closeLabel: String,
    reasonOutOfStock: String,
    reasonDiscontinued: String,
    reasonUnavailable: String,
    reasonUnknown: String,
    onViewCart: () -> Unit,
    onDismiss: () -> Unit
) {
    val hasAdded = result.addedItems.isNotEmpty()

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )
        },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 400.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
            ) {
                // Sección: items agregados (CA-2)
                if (hasAdded) {
                    AddedItemsSection(
                        items = result.addedItems,
                        sectionLabel = addedLabel
                    )
                }

                // Sección: cambios de precio
                if (result.priceChangedItems.isNotEmpty()) {
                    HorizontalDivider()
                    Text(
                        text = priceChangedLabel,
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    result.priceChangedItems.forEach { priceChange ->
                        PriceChangeRow(
                            priceChange = priceChange,
                            beforeLabel = priceBeforeLabel,
                            nowLabel = priceNowLabel
                        )
                    }
                }

                // Sección: items no disponibles (CA-3, CA-4)
                if (result.skippedItems.isNotEmpty()) {
                    HorizontalDivider()
                    ExcludedItemsSection(
                        items = result.skippedItems,
                        sectionLabel = itemsUnavailableLabel,
                        reasonOutOfStock = reasonOutOfStock,
                        reasonDiscontinued = reasonDiscontinued,
                        reasonUnavailable = reasonUnavailable,
                        reasonUnknown = reasonUnknown
                    )
                }
            }
        },
        confirmButton = {
            // CA-7: botón "Ir al carrito" sólo si hay items agregados
            if (hasAdded) {
                Button(onClick = onViewCart) {
                    Text(viewCartLabel)
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(closeLabel)
            }
        }
    )
}

/**
 * Sección "Agregados al carrito" con lista de productos (nombre + cantidad).
 */
@Composable
private fun AddedItemsSection(
    items: List<ClientOrderItem>,
    sectionLabel: String
) {
    // CA-11: contador sólo cuando hay más de 1 item
    val sectionTitle = if (items.size > 1) "$sectionLabel (${items.size})" else sectionLabel
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
    ) {
        Icon(
            imageVector = Icons.Filled.CheckCircle,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.height(20.dp)
        )
        Text(
            text = sectionTitle,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.primary
        )
    }
    items.forEach { item ->
        // CA-9: accesibilidad con contentDescription
        val description = "${item.name} x${item.quantity}"
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = MaterialTheme.spacing.x4)
                .semantics { contentDescription = description },
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = item.name,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 2, // CA-10: nombres largos
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(end = MaterialTheme.spacing.x2)
            )
            Text(
                text = "x${item.quantity}",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

/**
 * Sección "No disponibles" con lista de productos excluidos y motivo (SkipReason).
 */
@Composable
private fun ExcludedItemsSection(
    items: List<SkippedItem>,
    sectionLabel: String,
    reasonOutOfStock: String,
    reasonDiscontinued: String,
    reasonUnavailable: String,
    reasonUnknown: String
) {
    // CA-11: contador sólo cuando hay más de 1 item
    val sectionTitle = if (items.size > 1) "$sectionLabel (${items.size})" else sectionLabel
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
    ) {
        Icon(
            imageVector = Icons.Filled.Warning,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.error,
            modifier = Modifier.height(20.dp)
        )
        Text(
            text = sectionTitle,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.error
        )
    }
    items.forEach { skipped ->
        val reasonText = when (skipped.reason) {
            SkipReason.OUT_OF_STOCK -> reasonOutOfStock
            SkipReason.DISCONTINUED -> reasonDiscontinued
            SkipReason.UNAVAILABLE -> reasonUnavailable
            SkipReason.UNKNOWN_PRODUCT -> reasonUnknown
        }.ifBlank { reasonUnavailable } // CA-4: fallback si motivo vacío
        val description = "${skipped.item.name} x${skipped.item.quantity} - $reasonText"
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = MaterialTheme.spacing.x4)
                .semantics { contentDescription = description }
        ) {
            Text(
                text = skipped.item.name,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 2, // CA-10: nombres largos
                overflow = TextOverflow.Ellipsis
            )
            Text(
                text = reasonText,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

/**
 * Fila individual de un producto con cambio de precio.
 */
@Composable
private fun PriceChangeRow(
    priceChange: PriceChange,
    beforeLabel: String,
    nowLabel: String
) {
    val isIncrease = priceChange.difference > 0
    val changeColor = if (isIncrease) {
        MaterialTheme.colorScheme.error
    } else {
        MaterialTheme.colorScheme.tertiary
    }
    val changePrefix = if (isIncrease) "+" else ""

    Surface(
        modifier = Modifier.fillMaxWidth(),
        tonalElevation = 1.dp,
        shape = MaterialTheme.shapes.small
    ) {
        Column(
            modifier = Modifier.padding(MaterialTheme.spacing.x3),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
        ) {
            Text(
                text = priceChange.item.name,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column {
                    Text(
                        text = "$beforeLabel: ${formatPrice(priceChange.item.unitPrice)}",
                        style = MaterialTheme.typography.bodySmall,
                        textDecoration = TextDecoration.LineThrough,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Text(
                        text = "$nowLabel: ${formatPrice(priceChange.currentPrice)}",
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Bold
                    )
                }
                Text(
                    text = "$changePrefix${formatPrice(priceChange.difference)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = changeColor,
                    fontWeight = FontWeight.Bold
                )
            }
        }
    }
}
