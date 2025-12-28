package ui.sc.delivery

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowForward
import androidx.compose.material.icons.filled.DirectionsBike
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import ext.delivery.DeliveryOrdersSummaryDTO
import kotlinx.coroutines.launch
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.shared.Screen
import ui.session.SessionStore
import ui.th.elevations
import ui.th.spacing
import androidx.compose.ui.Alignment

const val DELIVERY_HOME_PATH = "/delivery/home"

class DeliveryHomeScreen : Screen(DELIVERY_HOME_PATH) {

    override val messageTitle: MessageKey = MessageKey.delivery_home_title

    @Composable
    override fun screen() {
        val viewModel: DeliveryHomeViewModel = viewModel { DeliveryHomeViewModel() }
        val state = viewModel.state
        val scrollState = rememberScrollState()
        val coroutineScope = rememberCoroutineScope()
        val sessionState by SessionStore.sessionState.collectAsState()

        LaunchedEffect(Unit) {
            viewModel.loadData()
        }

        val greeting = Txt(MessageKey.delivery_home_greeting)
        val todayLabel = Txt(MessageKey.delivery_home_today, mapOf("date" to state.today))
        val summaryTitle = Txt(MessageKey.delivery_home_summary_title)
        val activeTitle = Txt(MessageKey.delivery_home_active_title)
        val viewAllAssigned = Txt(MessageKey.delivery_home_view_all_assigned)
        val viewAvailable = Txt(MessageKey.delivery_home_view_available)
        val retryLabel = Txt(MessageKey.delivery_home_retry)
        val quickActionsLabel = Txt(MessageKey.delivery_home_quick_actions)

        Scaffold(
            bottomBar = {
                DeliveryBottomBar(
                    activeTab = DeliveryTab.HOME,
                    onHomeClick = { coroutineScope.launch { scrollState.animateScrollTo(0) } },
                    onOrdersClick = { navigate(DELIVERY_DASHBOARD_PATH) },
                    onProfileClick = { navigate(DELIVERY_PROFILE_PATH) }
                )
            }
        ) { padding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .verticalScroll(scrollState)
                    .padding(horizontal = MaterialTheme.spacing.x4, vertical = MaterialTheme.spacing.x3),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
            ) {
                DeliveryHomeHeader(
                    greeting = greeting,
                    dateLabel = todayLabel,
                    userName = sessionState.role?.rawValue ?: ""
                )

                Text(
                    text = summaryTitle,
                    style = MaterialTheme.typography.titleMedium
                )
                when (val summaryState = state.summaryState) {
                    DeliverySummaryState.Loading -> DeliveryLoading()
                    is DeliverySummaryState.Error -> DeliveryStateCard(
                        message = summaryState.message,
                        actionLabel = retryLabel,
                        onAction = { coroutineScope.launch { viewModel.refreshSummary() } }
                    )

                    is DeliverySummaryState.Loaded -> DeliverySummaryRow(summaryState.summary)
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = activeTitle,
                        style = MaterialTheme.typography.titleMedium
                    )
                    TextButton(onClick = { navigate(DELIVERY_DASHBOARD_PATH) }) {
                        Text(viewAllAssigned)
                    }
                }

                when (val ordersState = state.activeOrdersState) {
                    DeliveryActiveOrdersState.Loading -> DeliveryLoading()
                    DeliveryActiveOrdersState.Empty -> DeliveryStateCard(
                        message = Txt(MessageKey.delivery_home_active_empty),
                        actionLabel = retryLabel,
                        onAction = { coroutineScope.launch { viewModel.refreshActive() } }
                    )

                    is DeliveryActiveOrdersState.Error -> DeliveryStateCard(
                        message = ordersState.message,
                        actionLabel = retryLabel,
                        onAction = { coroutineScope.launch { viewModel.refreshActive() } }
                    )

                    is DeliveryActiveOrdersState.Loaded -> {
                        ordersState.orders.forEach { order ->
                            DeliveryOrderCard(
                                order = order,
                                onOpen = { navigate(DELIVERY_DASHBOARD_PATH) }
                            )
                        }
                    }
                }

                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                    elevation = CardDefaults.cardElevation(defaultElevation = MaterialTheme.elevations.level1)
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(MaterialTheme.spacing.x3),
                        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                    ) {
                        Text(
                            text = quickActionsLabel,
                            style = MaterialTheme.typography.bodyLarge
                        )
                        IntralePrimaryButton(
                            text = viewAllAssigned,
                            onClick = { navigate(DELIVERY_DASHBOARD_PATH) },
                            leadingIcon = Icons.Default.Schedule,
                            iconContentDescription = viewAllAssigned,
                            modifier = Modifier.fillMaxWidth()
                        )
                        IntralePrimaryButton(
                            text = viewAvailable,
                            onClick = { navigate(DELIVERY_DASHBOARD_PATH) },
                            leadingIcon = Icons.Default.DirectionsBike,
                            iconContentDescription = viewAvailable,
                            modifier = Modifier.fillMaxWidth()
                        )
                    }
                }

                Spacer(modifier = Modifier.height(MaterialTheme.spacing.x6))
            }
        }
    }
}

@Composable
private fun DeliveryHomeHeader(greeting: String, dateLabel: String, userName: String) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
    ) {
        Text(
            text = greeting,
            style = MaterialTheme.typography.titleLarge
        )
        Text(
            text = userName,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Text(
            text = dateLabel,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

@Composable
private fun DeliverySummaryRow(summary: DeliveryOrdersSummaryDTO) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
    ) {
        DeliverySummaryCard(
            title = Txt(MessageKey.delivery_home_pending),
            value = summary.pending
        )
        DeliverySummaryCard(
            title = Txt(MessageKey.delivery_home_in_progress),
            value = summary.inProgress
        )
        DeliverySummaryCard(
            title = Txt(MessageKey.delivery_home_delivered),
            value = summary.delivered
        )
    }
}

@Composable
private fun DeliverySummaryCard(title: String, value: Int) {
    Card(
        modifier = Modifier.weight(1f),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = MaterialTheme.elevations.level1)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
        ) {
            Text(text = title, style = MaterialTheme.typography.bodyMedium)
            Text(
                text = value.toString(),
                style = MaterialTheme.typography.headlineSmall
            )
        }
    }
}

@Composable
private fun DeliveryOrderCard(order: DeliveryActiveOrder, onOpen: () -> Unit) {
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
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(
                    text = order.label,
                    style = MaterialTheme.typography.titleMedium
                )
                Text(
                    text = orderStatusLabel(order.status),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.primary
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
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                order.eta?.let {
                    Box(
                        modifier = Modifier
                            .background(
                                color = MaterialTheme.colorScheme.primary.copy(alpha = 0.1f),
                                shape = RoundedCornerShape(MaterialTheme.spacing.x1)
                            )
                            .padding(horizontal = MaterialTheme.spacing.x2, vertical = MaterialTheme.spacing.x1)
                    ) {
                        Text(
                            text = Txt(MessageKey.delivery_home_eta, mapOf("eta" to it)),
                            color = MaterialTheme.colorScheme.primary,
                            style = MaterialTheme.typography.labelMedium
                        )
                    }
                }
                TextButton(onClick = onOpen) {
                    Icon(
                        imageVector = Icons.Default.ArrowForward,
                        contentDescription = Txt(MessageKey.delivery_home_view_order)
                    )
                    Text(
                        text = Txt(MessageKey.delivery_home_view_order),
                        modifier = Modifier.padding(start = MaterialTheme.spacing.x1)
                    )
                }
            }
        }
    }
}

@Composable
private fun DeliveryStateCard(
    message: String,
    actionLabel: String,
    onAction: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
        ) {
            Text(
                text = message,
                style = MaterialTheme.typography.bodyLarge
            )
            IntralePrimaryButton(
                text = actionLabel,
                onClick = onAction,
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
}

@Composable
private fun DeliveryLoading() {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = MaterialTheme.spacing.x3),
        horizontalArrangement = Arrangement.Center
    ) {
        CircularProgressIndicator()
    }
}

private fun orderStatusLabel(status: String): String = when (status.lowercase()) {
    "pending" -> Txt(MessageKey.delivery_order_status_pending)
    "inprogress", "in_progress", "assigned" -> Txt(MessageKey.delivery_order_status_in_progress)
    "delivered" -> Txt(MessageKey.delivery_order_status_delivered)
    else -> status
}
