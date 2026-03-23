package ui.sc.client

import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
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
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.lifecycle.viewmodel.compose.viewModel
import asdo.client.ClientOrderDetail
import asdo.client.ClientOrderItem
import asdo.client.ClientOrderStatusEvent
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
                val message = when {
                    result.addedItems.isEmpty() -> repeatNoItems
                    result.skippedItems.isNotEmpty() -> repeatPartial
                    else -> repeatSuccess
                }
                snackbarHostState.showSnackbar(message)
                viewModel.clearRepeatOrderResult()
                if (result.addedItems.isNotEmpty()) {
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
