package ui.sc.delivery

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import asdo.delivery.DeliveryOrder
import asdo.delivery.DeliveryOrderStatus
import kotlinx.coroutines.launch
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.Screen
import ui.th.spacing

const val DELIVERY_DASHBOARD_PATH = "/delivery/dashboard"

class DeliveryDashboardScreen : Screen(DELIVERY_DASHBOARD_PATH) {

    override val messageTitle: MessageKey = MessageKey.delivery_dashboard_title

    private val logger = LoggerFactory.default.newLogger<DeliveryDashboardScreen>()

    @OptIn(ExperimentalLayoutApi::class)
    @Composable
    override fun screen() {
        val ordersViewModel: DeliveryOrdersViewModel = viewModel { DeliveryOrdersViewModel() }
        val historyViewModel: DeliveryHistoryViewModel = viewModel { DeliveryHistoryViewModel() }
        val ordersState = ordersViewModel.state
        val historyState = historyViewModel.state
        val coroutineScope = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }
        var selectedTab by rememberSaveable { mutableIntStateOf(0) }

        LaunchedEffect(Unit) {
            logger.info { "[Delivery] Cargando listado de pedidos asignados" }
            ordersViewModel.loadOrders()
        }

        LaunchedEffect(selectedTab) {
            if (selectedTab == 1 && historyState.status == DeliveryHistoryStatus.Idle) {
                logger.info { "[Delivery] Cargando historial de pedidos" }
                historyViewModel.loadHistory()
            }
        }

        val successMessage = Txt(MessageKey.delivery_order_status_updated)

        LaunchedEffect(ordersState.statusUpdateSuccess) {
            if (ordersState.statusUpdateSuccess) {
                snackbarHostState.showSnackbar(successMessage)
                ordersViewModel.clearStatusFeedback()
            }
        }

        LaunchedEffect(ordersState.statusUpdateError) {
            ordersState.statusUpdateError?.let {
                snackbarHostState.showSnackbar(it)
                ordersViewModel.clearStatusFeedback()
            }
        }

        val title = Txt(MessageKey.delivery_orders_title)
        val subtitle = Txt(MessageKey.delivery_orders_subtitle)
        val emptyMessage = Txt(MessageKey.delivery_orders_empty)
        val errorMessage = Txt(MessageKey.delivery_orders_error)
        val retryLabel = Txt(MessageKey.delivery_orders_retry)

        val filterAll = Txt(MessageKey.delivery_orders_filter_all)
        val filterPending = Txt(MessageKey.delivery_order_status_pending)
        val filterInProgress = Txt(MessageKey.delivery_order_status_in_progress)
        val filterDelivered = Txt(MessageKey.delivery_order_status_delivered)

        val tabActive = Txt(MessageKey.delivery_history_tab_active)
        val tabHistory = Txt(MessageKey.delivery_history_tab_history)
        val historyEmpty = Txt(MessageKey.delivery_history_empty)
        val historyError = Txt(MessageKey.delivery_history_error)
        val historyRetry = Txt(MessageKey.delivery_history_retry)

        Scaffold(
            snackbarHost = { SnackbarHost(snackbarHostState) },
            bottomBar = {
                DeliveryBottomBar(
                    activeTab = DeliveryTab.ORDERS,
                    onHomeClick = { navigate(DELIVERY_HOME_PATH) },
                    onOrdersClick = {
                        if (selectedTab == 0) {
                            coroutineScope.launch { ordersViewModel.loadOrders() }
                        } else {
                            coroutineScope.launch { historyViewModel.loadHistory() }
                        }
                    },
                    onProfileClick = { navigate(DELIVERY_PROFILE_PATH) }
                )
            }
        ) { padding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = MaterialTheme.spacing.x4, vertical = MaterialTheme.spacing.x3),
                    verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
                ) {
                    Text(
                        text = title,
                        style = MaterialTheme.typography.titleLarge
                    )
                    Text(
                        text = subtitle,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }

                TabRow(selectedTabIndex = selectedTab) {
                    Tab(
                        selected = selectedTab == 0,
                        onClick = { selectedTab = 0 },
                        text = { Text(tabActive) }
                    )
                    Tab(
                        selected = selectedTab == 1,
                        onClick = { selectedTab = 1 },
                        text = { Text(tabHistory) }
                    )
                }

                when (selectedTab) {
                    0 -> ActiveOrdersContent(
                        state = ordersState,
                        emptyMessage = emptyMessage,
                        errorMessage = errorMessage,
                        retryLabel = retryLabel,
                        filterAll = filterAll,
                        filterPending = filterPending,
                        filterInProgress = filterInProgress,
                        filterDelivered = filterDelivered,
                        onSelectFilter = { ordersViewModel.selectFilter(it) },
                        onRetry = { coroutineScope.launch { ordersViewModel.loadOrders() } },
                        onOpenOrder = { orderId ->
                            DeliveryOrderSelectionStore.select(orderId)
                            navigate(DELIVERY_ORDER_DETAIL_PATH)
                        },
                        onStartDelivery = { orderId ->
                            coroutineScope.launch {
                                ordersViewModel.updateStatus(orderId, DeliveryOrderStatus.IN_PROGRESS)
                            }
                        },
                        onMarkDelivered = { orderId ->
                            coroutineScope.launch {
                                ordersViewModel.updateStatus(orderId, DeliveryOrderStatus.DELIVERED)
                            }
                        }
                    )
                    1 -> HistoryContent(
                        state = historyState,
                        emptyMessage = historyEmpty,
                        errorMessage = historyError,
                        retryLabel = historyRetry,
                        onRetry = { coroutineScope.launch { historyViewModel.loadHistory() } },
                        onOpenOrder = { orderId ->
                            DeliveryOrderSelectionStore.select(orderId, readOnly = true)
                            navigate(DELIVERY_ORDER_DETAIL_PATH)
                        }
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ActiveOrdersContent(
    state: DeliveryOrdersUiState,
    emptyMessage: String,
    errorMessage: String,
    retryLabel: String,
    filterAll: String,
    filterPending: String,
    filterInProgress: String,
    filterDelivered: String,
    onSelectFilter: (DeliveryOrderStatus?) -> Unit,
    onRetry: () -> Unit,
    onOpenOrder: (String) -> Unit,
    onStartDelivery: (String) -> Unit,
    onMarkDelivered: (String) -> Unit
) {
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = MaterialTheme.spacing.x4, vertical = MaterialTheme.spacing.x3),
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
    ) {
        item {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
            ) {
                FilterChip(
                    selected = state.selectedFilter == null,
                    onClick = { onSelectFilter(null) },
                    label = { Text(filterAll) }
                )
                FilterChip(
                    selected = state.selectedFilter == DeliveryOrderStatus.PENDING,
                    onClick = { onSelectFilter(DeliveryOrderStatus.PENDING) },
                    label = { Text(filterPending) }
                )
                FilterChip(
                    selected = state.selectedFilter == DeliveryOrderStatus.IN_PROGRESS,
                    onClick = { onSelectFilter(DeliveryOrderStatus.IN_PROGRESS) },
                    label = { Text(filterInProgress) }
                )
                FilterChip(
                    selected = state.selectedFilter == DeliveryOrderStatus.DELIVERED,
                    onClick = { onSelectFilter(DeliveryOrderStatus.DELIVERED) },
                    label = { Text(filterDelivered) }
                )
            }
        }

        when (state.status) {
            DeliveryOrdersStatus.Idle,
            DeliveryOrdersStatus.Loading -> item {
                DeliveryLoading()
            }

            DeliveryOrdersStatus.Empty -> item {
                DeliveryStateCard(
                    message = emptyMessage,
                    actionLabel = retryLabel,
                    onAction = onRetry
                )
            }

            DeliveryOrdersStatus.Error -> item {
                DeliveryStateCard(
                    message = state.errorMessage ?: errorMessage,
                    actionLabel = retryLabel,
                    onAction = onRetry
                )
            }

            DeliveryOrdersStatus.Loaded -> {
                items(state.orders, key = { it.id }) { order ->
                    DeliveryOrderCard(
                        order = order,
                        onOpen = { onOpenOrder(order.id) },
                        onStartDelivery = { onStartDelivery(order.id) },
                        onMarkDelivered = { onMarkDelivered(order.id) },
                        isUpdating = state.updatingOrderId == order.id
                    )
                }
            }
        }

        item {
            Spacer(modifier = Modifier.height(MaterialTheme.spacing.x6))
        }
    }
}

@Composable
private fun HistoryContent(
    state: DeliveryHistoryUiState,
    emptyMessage: String,
    errorMessage: String,
    retryLabel: String,
    onRetry: () -> Unit,
    onOpenOrder: (String) -> Unit
) {
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = MaterialTheme.spacing.x4, vertical = MaterialTheme.spacing.x3),
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
    ) {
        when (state.status) {
            DeliveryHistoryStatus.Idle,
            DeliveryHistoryStatus.Loading -> item {
                DeliveryLoading()
            }

            DeliveryHistoryStatus.Empty -> item {
                DeliveryStateCard(
                    message = emptyMessage,
                    actionLabel = retryLabel,
                    onAction = onRetry
                )
            }

            DeliveryHistoryStatus.Error -> item {
                DeliveryStateCard(
                    message = state.errorMessage ?: errorMessage,
                    actionLabel = retryLabel,
                    onAction = onRetry
                )
            }

            DeliveryHistoryStatus.Loaded -> {
                items(state.orders, key = { it.id }) { order ->
                    HistoryOrderCard(
                        order = order,
                        onOpen = { onOpenOrder(order.id) }
                    )
                }
            }
        }

        item {
            Spacer(modifier = Modifier.height(MaterialTheme.spacing.x6))
        }
    }
}

@Composable
internal fun HistoryOrderCard(
    order: DeliveryOrder,
    onOpen: () -> Unit
) {
    val isDelivered = order.status == DeliveryOrderStatus.DELIVERED
    val statusIcon = if (isDelivered) Icons.Default.CheckCircle else Icons.Default.Cancel
    val statusColor = if (isDelivered) {
        MaterialTheme.colorScheme.primary
    } else {
        MaterialTheme.colorScheme.error
    }
    val statusLabel = orderStatusLabel(order.status)
    val statusDescription = if (isDelivered) "Entregado" else "No entregado"

    OutlinedCard(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.outlinedCardColors(containerColor = MaterialTheme.colorScheme.surface)
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
                Row(
                    horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(
                        imageVector = statusIcon,
                        contentDescription = statusDescription,
                        tint = statusColor,
                        modifier = Modifier
                            .height(20.dp)
                            .semantics { contentDescription = statusDescription }
                    )
                    Text(
                        text = order.label,
                        style = MaterialTheme.typography.titleMedium
                    )
                }
                Text(
                    text = statusLabel,
                    style = MaterialTheme.typography.bodyMedium,
                    color = statusColor
                )
            }
            Text(
                text = order.businessName,
                style = MaterialTheme.typography.bodyLarge
            )
            Text(
                text = order.neighborhood,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            (order.finishedAt ?: order.eta)?.let { date ->
                Text(
                    text = date,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End
            ) {
                TextButton(onClick = onOpen) {
                    Text(
                        text = Txt(MessageKey.delivery_history_view_detail)
                    )
                }
            }
        }
    }
}
