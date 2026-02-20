package ui.sc.delivery

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import kotlinx.coroutines.launch
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.Screen
import ui.th.spacing

const val DELIVERY_DASHBOARD_PATH = "/delivery/dashboard"

class DeliveryDashboardScreen : Screen(DELIVERY_DASHBOARD_PATH) {

    override val messageTitle: MessageKey = MessageKey.delivery_dashboard_title

    private val logger = LoggerFactory.default.newLogger<DeliveryDashboardScreen>()

    @Composable
    override fun screen() {
        val viewModel: DeliveryOrdersViewModel = viewModel { DeliveryOrdersViewModel() }
        val state = viewModel.state
        val coroutineScope = rememberCoroutineScope()

        LaunchedEffect(Unit) {
            logger.info { "[Delivery] Cargando listado de pedidos asignados" }
            viewModel.loadOrders()
        }

        val title = Txt(MessageKey.delivery_orders_title)
        val subtitle = Txt(MessageKey.delivery_orders_subtitle)
        val emptyMessage = Txt(MessageKey.delivery_orders_empty)
        val errorMessage = Txt(MessageKey.delivery_orders_error)
        val retryLabel = Txt(MessageKey.delivery_orders_retry)

        Scaffold(
            bottomBar = {
                DeliveryBottomBar(
                    activeTab = DeliveryTab.ORDERS,
                    onHomeClick = { navigate(DELIVERY_HOME_PATH) },
                    onOrdersClick = { coroutineScope.launch { viewModel.loadOrders() } },
                    onProfileClick = { navigate(DELIVERY_PROFILE_PATH) }
                )
            }
        ) { padding ->
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
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
                                onOpen = { /* TODO: navegar al detalle del pedido */ }
                            )
                        }
                    }
                }

                item {
                    Spacer(modifier = Modifier.height(MaterialTheme.spacing.x6))
                }
            }
        }
    }
}
