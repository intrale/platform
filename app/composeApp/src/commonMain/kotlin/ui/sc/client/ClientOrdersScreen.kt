package ui.sc.client

import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.lifecycle.viewmodel.compose.viewModel
import asdo.client.ClientOrder
import asdo.client.ClientOrderStatus
import kotlinx.coroutines.launch
import ui.sc.shared.Screen
import ui.th.spacing
import ui.util.formatPrice

const val CLIENT_ORDERS_PATH = "/client/orders"
const val CLIENT_ORDER_DETAIL_PATH = "/client/orders/detail"

class ClientOrdersScreen : Screen(CLIENT_ORDERS_PATH) {

    override val messageTitle: MessageKey = MessageKey.client_orders_title

    @OptIn(ExperimentalLayoutApi::class)
    @Composable
    override fun screen() {
        val viewModel: ClientOrdersViewModel = viewModel { ClientOrdersViewModel() }
        val state = viewModel.state
        val snackbarHostState = remember { SnackbarHostState() }
        val coroutineScope = rememberCoroutineScope()

        val ordersTitle = Txt(MessageKey.client_orders_title)
        val emptyMessage = Txt(MessageKey.client_orders_empty)
        val viewCatalogLabel = Txt(MessageKey.client_home_view_catalog)
        val errorMessage = Txt(MessageKey.client_orders_error)
        val retryLabel = Txt(MessageKey.client_orders_retry)
        val dateLabel = Txt(MessageKey.client_orders_order_date)
        val itemsLabel = Txt(MessageKey.client_orders_order_items)
        val filterAll = Txt(MessageKey.client_orders_filter_all)
        val filterPending = Txt(MessageKey.client_orders_status_pending)
        val filterConfirmed = Txt(MessageKey.client_orders_status_confirmed)
        val filterPreparing = Txt(MessageKey.client_orders_status_preparing)
        val filterReady = Txt(MessageKey.client_orders_status_ready)
        val filterDelivering = Txt(MessageKey.client_orders_status_delivering)
        val filterDelivered = Txt(MessageKey.client_orders_status_delivered)
        val filterCancelled = Txt(MessageKey.client_orders_status_cancelled)

        val statusLabels = remember(
            filterPending, filterConfirmed, filterPreparing, filterReady,
            filterDelivering, filterDelivered, filterCancelled
        ) {
            mapOf(
                ClientOrderStatus.PENDING to filterPending,
                ClientOrderStatus.CONFIRMED to filterConfirmed,
                ClientOrderStatus.PREPARING to filterPreparing,
                ClientOrderStatus.READY to filterReady,
                ClientOrderStatus.DELIVERING to filterDelivering,
                ClientOrderStatus.DELIVERED to filterDelivered,
                ClientOrderStatus.CANCELLED to filterCancelled,
                ClientOrderStatus.UNKNOWN to filterPending
            )
        }

        LaunchedEffect(Unit) {
            viewModel.loadOrders()
        }

        LaunchedEffect(state.errorMessage) {
            state.errorMessage?.let {
                snackbarHostState.showSnackbar(it)
                viewModel.clearError()
            }
        }

        Scaffold(
            snackbarHost = { SnackbarHost(snackbarHostState) },
            bottomBar = {
                ClientBottomBar(
                    activeTab = ClientTab.ORDERS,
                    onHomeClick = { navigate(CLIENT_HOME_PATH) },
                    onOrdersClick = {},
                    onProfileClick = { navigate(CLIENT_PROFILE_PATH) }
                )
            }
        ) { padding ->
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(horizontal = MaterialTheme.spacing.x4),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3),
                contentPadding = PaddingValues(vertical = MaterialTheme.spacing.x4)
            ) {
                item {
                    Text(
                        text = ordersTitle,
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold
                    )
                }

                item {
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                    ) {
                        FilterChip(
                            selected = state.selectedFilter == null,
                            onClick = { viewModel.selectFilter(null) },
                            label = { Text(filterAll) }
                        )
                        FilterChip(
                            selected = state.selectedFilter == ClientOrderStatus.PENDING,
                            onClick = { viewModel.selectFilter(ClientOrderStatus.PENDING) },
                            label = { Text(filterPending) }
                        )
                        FilterChip(
                            selected = state.selectedFilter == ClientOrderStatus.CONFIRMED,
                            onClick = { viewModel.selectFilter(ClientOrderStatus.CONFIRMED) },
                            label = { Text(filterConfirmed) }
                        )
                        FilterChip(
                            selected = state.selectedFilter == ClientOrderStatus.PREPARING,
                            onClick = { viewModel.selectFilter(ClientOrderStatus.PREPARING) },
                            label = { Text(filterPreparing) }
                        )
                        FilterChip(
                            selected = state.selectedFilter == ClientOrderStatus.READY,
                            onClick = { viewModel.selectFilter(ClientOrderStatus.READY) },
                            label = { Text(filterReady) }
                        )
                        FilterChip(
                            selected = state.selectedFilter == ClientOrderStatus.DELIVERING,
                            onClick = { viewModel.selectFilter(ClientOrderStatus.DELIVERING) },
                            label = { Text(filterDelivering) }
                        )
                        FilterChip(
                            selected = state.selectedFilter == ClientOrderStatus.DELIVERED,
                            onClick = { viewModel.selectFilter(ClientOrderStatus.DELIVERED) },
                            label = { Text(filterDelivered) }
                        )
                        FilterChip(
                            selected = state.selectedFilter == ClientOrderStatus.CANCELLED,
                            onClick = { viewModel.selectFilter(ClientOrderStatus.CANCELLED) },
                            label = { Text(filterCancelled) }
                        )
                    }
                }

                when (state.status) {
                    ClientOrdersStatus.Idle,
                    ClientOrdersStatus.Loading -> item {
                        Box(
                            modifier = Modifier.fillMaxWidth().padding(vertical = MaterialTheme.spacing.x6),
                            contentAlignment = Alignment.Center
                        ) {
                            CircularProgressIndicator()
                        }
                    }

                    ClientOrdersStatus.Loaded -> {
                        items(state.orders, key = { it.id }) { order ->
                            OrderCard(
                                order = order,
                                dateLabel = dateLabel,
                                itemsLabel = itemsLabel,
                                statusLabel = statusLabels[order.status] ?: order.status.name,
                                onClick = {
                                    ClientOrderSelectionStore.select(order.id)
                                    navigate(CLIENT_ORDER_DETAIL_PATH)
                                }
                            )
                        }
                    }

                    ClientOrdersStatus.Empty -> item {
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
                                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2),
                                horizontalAlignment = Alignment.CenterHorizontally
                            ) {
                                Text(
                                    text = emptyMessage,
                                    textAlign = TextAlign.Center,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                                TextButton(onClick = {
                                    coroutineScope.launch { navigate(CLIENT_HOME_PATH) }
                                }) {
                                    Text(viewCatalogLabel)
                                }
                            }
                        }
                    }

                    ClientOrdersStatus.Error -> item {
                        Card(
                            modifier = Modifier.fillMaxWidth(),
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
                                    coroutineScope.launch { viewModel.loadOrders() }
                                }) {
                                    Text(retryLabel)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun OrderCard(
    order: ClientOrder,
    dateLabel: String,
    itemsLabel: String,
    statusLabel: String,
    onClick: () -> Unit
) {
    val statusColor = order.status.toColor()
    val statusBackground = order.status.toBackgroundColor()

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
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
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "#${order.shortCode}",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold
                )
                OrderStatusBadge(
                    label = statusLabel,
                    textColor = statusColor,
                    backgroundColor = statusBackground
                )
            }
            Text(
                text = order.businessName,
                style = MaterialTheme.typography.bodyMedium
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(
                    text = "$dateLabel: ${order.createdAt}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    text = "${order.itemCount} $itemsLabel",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Text(
                text = formatPrice(order.total),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.primary
            )
        }
    }
}

@Composable
internal fun OrderStatusBadge(
    label: String,
    textColor: Color,
    backgroundColor: Color
) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(MaterialTheme.spacing.x1))
            .background(backgroundColor)
            .padding(
                horizontal = MaterialTheme.spacing.x2,
                vertical = MaterialTheme.spacing.x0_5
            )
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
            color = textColor
        )
    }
}

// Colores de estado para pedidos del cliente
internal fun ClientOrderStatus.toColor(): Color = when (this) {
    ClientOrderStatus.PENDING -> Color(0xFFE65100)
    ClientOrderStatus.CONFIRMED -> Color(0xFF1565C0)
    ClientOrderStatus.PREPARING -> Color(0xFF6A1B9A)
    ClientOrderStatus.READY -> Color(0xFF2E7D32)
    ClientOrderStatus.DELIVERING -> Color(0xFF0277BD)
    ClientOrderStatus.DELIVERED -> Color(0xFF1B5E20)
    ClientOrderStatus.CANCELLED -> Color(0xFFC62828)
    ClientOrderStatus.UNKNOWN -> Color(0xFF616161)
}

internal fun ClientOrderStatus.toBackgroundColor(): Color = when (this) {
    ClientOrderStatus.PENDING -> Color(0xFFFFF3E0)
    ClientOrderStatus.CONFIRMED -> Color(0xFFE3F2FD)
    ClientOrderStatus.PREPARING -> Color(0xFFF3E5F5)
    ClientOrderStatus.READY -> Color(0xFFE8F5E9)
    ClientOrderStatus.DELIVERING -> Color(0xFFE1F5FE)
    ClientOrderStatus.DELIVERED -> Color(0xFFC8E6C9)
    ClientOrderStatus.CANCELLED -> Color(0xFFFFEBEE)
    ClientOrderStatus.UNKNOWN -> Color(0xFFF5F5F5)
}
