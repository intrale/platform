package ui.sc.client

import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import asdo.client.ClientOrderDetail
import asdo.client.ClientOrderItem
import asdo.client.ClientOrderTrackingStep
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
        val trackingTitle = Txt(MessageKey.client_orders_detail_tracking_title)
        val paymentTitle = Txt(MessageKey.client_orders_detail_payment_title)
        val paymentMethodLabel = Txt(MessageKey.client_orders_detail_payment_method)
        val businessMessageLabel = Txt(MessageKey.client_orders_detail_business_message)
        val contactBusinessLabel = Txt(MessageKey.client_orders_detail_contact_business)

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
                        trackingTitle = trackingTitle,
                        paymentTitle = paymentTitle,
                        paymentMethodLabel = paymentMethodLabel,
                        businessMessageLabel = businessMessageLabel,
                        contactBusinessLabel = contactBusinessLabel,
                        statusLabel = resolvedStatusLabels[detail.status] ?: detail.status.name,
                        padding = padding,
                        onBackClick = { goBack() },
                        onContactClick = {
                            // Placeholder para contactar al negocio
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
    trackingTitle: String,
    paymentTitle: String,
    paymentMethodLabel: String,
    businessMessageLabel: String,
    contactBusinessLabel: String,
    statusLabel: String,
    padding: PaddingValues,
    onBackClick: () -> Unit,
    onContactClick: () -> Unit
) {
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(padding)
            .padding(horizontal = MaterialTheme.spacing.x4),
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3),
        contentPadding = PaddingValues(vertical = MaterialTheme.spacing.x4)
    ) {
        // Header con botón de volver
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

        // Card principal con resumen del pedido
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

        // Seguimiento del pedido (tracking steps)
        if (detail.trackingSteps.isNotEmpty()) {
            item {
                Text(
                    text = trackingTitle,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold
                )
            }
            item {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surface
                    )
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(MaterialTheme.spacing.x4)
                    ) {
                        detail.trackingSteps.forEachIndexed { index, step ->
                            TrackingStepRow(
                                step = step,
                                isLast = index == detail.trackingSteps.lastIndex
                            )
                        }
                    }
                }
            }
        }

        // Mensaje del negocio
        if (!detail.businessMessage.isNullOrBlank()) {
            item {
                Text(
                    text = businessMessageLabel,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold
                )
            }
            item {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.secondaryContainer
                    )
                ) {
                    Text(
                        text = detail.businessMessage,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(MaterialTheme.spacing.x4),
                        color = MaterialTheme.colorScheme.onSecondaryContainer
                    )
                }
            }
        }

        // Productos del pedido
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

        // Forma de pago
        if (!detail.paymentMethod.isNullOrBlank()) {
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
                        containerColor = MaterialTheme.colorScheme.surface
                    )
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(MaterialTheme.spacing.x4),
                        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
                    ) {
                        Text(
                            text = paymentMethodLabel,
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Text(
                            text = detail.paymentMethod,
                            style = MaterialTheme.typography.bodyLarge,
                            fontWeight = FontWeight.Medium
                        )
                    }
                }
            }
        }

        // Dirección de entrega
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

        // Botón para contactar al negocio
        item {
            OutlinedButton(
                onClick = onContactClick,
                modifier = Modifier.fillMaxWidth()
            ) {
                Icon(
                    imageVector = Icons.Filled.Phone,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp)
                )
                Spacer(modifier = Modifier.width(MaterialTheme.spacing.x1))
                Text(text = contactBusinessLabel)
            }
        }
    }
}

@Composable
private fun TrackingStepRow(
    step: ClientOrderTrackingStep,
    isLast: Boolean
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
    ) {
        // Indicador visual de la línea de tiempo
        Column(
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            val dotColor = when {
                step.current -> MaterialTheme.colorScheme.primary
                step.completed -> MaterialTheme.colorScheme.primary
                else -> MaterialTheme.colorScheme.outlineVariant
            }
            Box(
                modifier = Modifier
                    .size(12.dp)
                    .clip(CircleShape)
                    .background(dotColor)
            )
            if (!isLast) {
                Box(
                    modifier = Modifier
                        .width(2.dp)
                        .height(32.dp)
                        .background(
                            if (step.completed) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.outlineVariant
                        )
                )
            }
        }

        // Contenido del paso
        Column(
            modifier = Modifier
                .weight(1f)
                .padding(bottom = if (!isLast) MaterialTheme.spacing.x2 else MaterialTheme.spacing.none),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x0_5)
        ) {
            Text(
                text = step.label,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (step.current) FontWeight.Bold else FontWeight.Normal,
                color = if (step.completed || step.current)
                    MaterialTheme.colorScheme.onSurface
                else
                    MaterialTheme.colorScheme.onSurfaceVariant
            )
            step.timestamp?.let { ts ->
                Text(
                    text = ts,
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
