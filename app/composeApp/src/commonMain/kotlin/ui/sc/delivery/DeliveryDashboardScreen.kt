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
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
        val coroutineScope = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }
        var selectedTabIndex by rememberSaveable { mutableStateOf(0) }

        val tabMine = Txt(MessageKey.delivery_orders_tab_mine)
        val tabAvailable = Txt(MessageKey.delivery_available_orders_tab)

        Scaffold(
            snackbarHost = { SnackbarHost(snackbarHostState) },
            bottomBar = {
                DeliveryBottomBar(
                    activeTab = DeliveryTab.ORDERS,
                    onHomeClick = { navigate(DELIVERY_HOME_PATH) },
                    onOrdersClick = { coroutineScope.launch { viewModel.loadOrders() } },
                    onNotificationsClick = { navigate(DELIVERY_NOTIFICATIONS_PATH) },
                    onProfileClick = { navigate(DELIVERY_PROFILE_PATH) }
                )
            }
        ) { padding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
            ) {
                TabRow(selectedTabIndex = selectedTabIndex) {
                    Tab(
                        selected = selectedTabIndex == 0,
                        onClick = { selectedTabIndex = 0 },
                        text = { Text(tabMine) }
                    )
                    Tab(
                        selected = selectedTabIndex == 1,
                        onClick = { selectedTabIndex = 1 },
                        text = { Text(tabAvailable) }
                    )
                }

                when (selectedTabIndex) {
                    0 -> MyOrdersTab(
                        coroutineScope = coroutineScope,
                        snackbarHostState = snackbarHostState,
                        onNavigate = { route -> navigate(route) }
                    )
                    1 -> AvailableOrdersTab(
                        coroutineScope = coroutineScope,
                        snackbarHostState = snackbarHostState
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MyOrdersTab(
    coroutineScope: kotlinx.coroutines.CoroutineScope,
    snackbarHostState: SnackbarHostState,
    onNavigate: (String) -> Unit
) {
    val logger = LoggerFactory.default.newLogger<DeliveryDashboardScreen>()
    val viewModel: DeliveryOrdersViewModel = viewModel { DeliveryOrdersViewModel() }
    val state = viewModel.state

    LaunchedEffect(Unit) {
        logger.info { "[Delivery] Cargando listado de pedidos asignados" }
        viewModel.loadOrders()
    }

    val successMessage = Txt(MessageKey.delivery_order_status_updated)

    LaunchedEffect(state.statusUpdateSuccess) {
        if (state.statusUpdateSuccess) {
            snackbarHostState.showSnackbar(successMessage)
            viewModel.clearStatusFeedback()
        }
    }

    LaunchedEffect(state.statusUpdateError) {
        state.statusUpdateError?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.clearStatusFeedback()
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

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = MaterialTheme.spacing.x4, vertical = MaterialTheme.spacing.x3),
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
    ) {
        item {
            Column(
                modifier = Modifier.fillMaxWidth(),
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
                    selected = state.selectedFilter == DeliveryOrderStatus.PENDING,
                    onClick = { viewModel.selectFilter(DeliveryOrderStatus.PENDING) },
                    label = { Text(filterPending) }
                )
                FilterChip(
                    selected = state.selectedFilter == DeliveryOrderStatus.IN_PROGRESS,
                    onClick = { viewModel.selectFilter(DeliveryOrderStatus.IN_PROGRESS) },
                    label = { Text(filterInProgress) }
                )
                FilterChip(
                    selected = state.selectedFilter == DeliveryOrderStatus.DELIVERED,
                    onClick = { viewModel.selectFilter(DeliveryOrderStatus.DELIVERED) },
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
                    onAction = { coroutineScope.launch { viewModel.loadOrders() } }
                )
            }

            DeliveryOrdersStatus.Error -> item {
                DeliveryStateCard(
                    message = state.errorMessage ?: errorMessage,
                    actionLabel = retryLabel,
                    onAction = { coroutineScope.launch { viewModel.loadOrders() } }
                )
            }

            DeliveryOrdersStatus.Loaded -> {
                items(state.orders, key = { it.id }) { order ->
                    DeliveryOrderCard(
                        order = order,
                        onOpen = {
                            DeliveryOrderSelectionStore.select(order.id)
                            onNavigate(DELIVERY_ORDER_DETAIL_PATH)
                        },
                        onStartDelivery = {
                            coroutineScope.launch {
                                viewModel.updateStatus(order.id, DeliveryOrderStatus.IN_PROGRESS)
                            }
                        },
                        onMarkDelivered = {
                            coroutineScope.launch {
                                viewModel.updateStatus(order.id, DeliveryOrderStatus.DELIVERED)
                            }
                        },
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
private fun AvailableOrdersTab(
    coroutineScope: kotlinx.coroutines.CoroutineScope,
    snackbarHostState: SnackbarHostState
) {
    val logger = LoggerFactory.default.newLogger<AvailableOrdersViewModel>()
    val viewModel: AvailableOrdersViewModel = viewModel { AvailableOrdersViewModel() }
    val state = viewModel.state

    LaunchedEffect(Unit) {
        logger.info { "[Delivery] Cargando pedidos disponibles" }
        viewModel.loadAvailableOrders()
    }

    val takeSuccessMessage = Txt(MessageKey.delivery_order_take_success)
    val alreadyTakenMessage = Txt(MessageKey.delivery_order_take_already_taken)

    LaunchedEffect(state.takeSuccess) {
        if (state.takeSuccess) {
            snackbarHostState.showSnackbar(takeSuccessMessage)
            viewModel.clearFeedback()
        }
    }

    LaunchedEffect(state.alreadyTakenOrderId) {
        if (state.alreadyTakenOrderId != null) {
            snackbarHostState.showSnackbar(alreadyTakenMessage)
            viewModel.clearFeedback()
        }
    }

    LaunchedEffect(state.takeError) {
        state.takeError?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.clearFeedback()
        }
    }

    val title = Txt(MessageKey.delivery_available_orders_title)
    val subtitle = Txt(MessageKey.delivery_available_orders_subtitle)
    val emptyMessage = Txt(MessageKey.delivery_available_orders_empty)
    val errorMessage = Txt(MessageKey.delivery_available_orders_error)
    val retryLabel = Txt(MessageKey.delivery_available_orders_retry)

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = MaterialTheme.spacing.x4, vertical = MaterialTheme.spacing.x3),
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
    ) {
        item {
            Column(
                modifier = Modifier.fillMaxWidth(),
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
        }

        when (state.status) {
            AvailableOrdersStatus.Idle,
            AvailableOrdersStatus.Loading -> item {
                DeliveryLoading()
            }

            AvailableOrdersStatus.Empty -> item {
                DeliveryStateCard(
                    message = emptyMessage,
                    actionLabel = retryLabel,
                    onAction = { coroutineScope.launch { viewModel.loadAvailableOrders() } }
                )
            }

            AvailableOrdersStatus.Error -> item {
                DeliveryStateCard(
                    message = state.errorMessage ?: errorMessage,
                    actionLabel = retryLabel,
                    onAction = { coroutineScope.launch { viewModel.loadAvailableOrders() } }
                )
            }

            AvailableOrdersStatus.Loaded -> {
                items(state.orders, key = { it.id }) { order ->
                    AvailableOrderCard(
                        order = order,
                        isTaking = state.takingOrderId == order.id,
                        onTake = {
                            coroutineScope.launch {
                                viewModel.takeOrder(order.id)
                            }
                        }
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
private fun AvailableOrderCard(
    order: DeliveryOrder,
    isTaking: Boolean,
    onTake: () -> Unit
) {
    val takeLabel = Txt(MessageKey.delivery_order_take_action)
    val distancePlaceholder = Txt(MessageKey.delivery_order_distance_placeholder)

    androidx.compose.material3.Card(
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x0_5)
                ) {
                    Text(
                        text = order.businessName,
                        style = MaterialTheme.typography.titleMedium
                    )
                    Text(
                        text = order.neighborhood,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Column(
                    horizontalAlignment = Alignment.End,
                    verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x0_5)
                ) {
                    Text(
                        text = distancePlaceholder,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    order.eta?.let { eta ->
                        Text(
                            text = eta,
                            style = MaterialTheme.typography.bodySmall
                        )
                    }
                }
            }

            Button(
                onClick = onTake,
                enabled = !isTaking,
                modifier = Modifier.fillMaxWidth()
            ) {
                if (isTaking) {
                    CircularProgressIndicator(
                        modifier = Modifier.height(20.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary
                    )
                } else {
                    Text(takeLabel)
                }
            }
        }
    }
}
