package ui.sc.client

import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import androidx.compose.foundation.clickable
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
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.lifecycle.viewmodel.compose.viewModel
import asdo.client.ClientOrder
import kotlinx.coroutines.launch
import ui.sc.shared.Screen
import ui.th.spacing

const val CLIENT_ORDERS_PATH = "/client/orders"

class ClientOrdersScreen : Screen(CLIENT_ORDERS_PATH) {

    override val messageTitle: MessageKey = MessageKey.client_orders_title

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
            when (state.status) {
                ClientOrdersStatus.Idle, ClientOrdersStatus.Loading -> {
                    Box(
                        modifier = Modifier.fillMaxSize().padding(padding),
                        contentAlignment = Alignment.Center
                    ) {
                        CircularProgressIndicator()
                    }
                }

                ClientOrdersStatus.Loaded -> {
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
                        items(state.orders, key = { it.id }) { order ->
                            OrderCard(
                                order = order,
                                dateLabel = dateLabel,
                                itemsLabel = itemsLabel,
                                onClick = {
                                    coroutineScope.launch { viewModel.loadOrderDetail(order.id) }
                                }
                            )
                        }
                    }
                }

                ClientOrdersStatus.Empty -> {
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
                    }
                }

                ClientOrdersStatus.Error -> {
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
}

@Composable
private fun OrderCard(
    order: ClientOrder,
    dateLabel: String,
    itemsLabel: String,
    onClick: () -> Unit
) {
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
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(
                    text = "#${order.shortCode}",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold
                )
                Text(
                    text = order.status.name,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary
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
                text = "$${order.total}",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.primary
            )
        }
    }
}
