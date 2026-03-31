@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package ui.sc.business

import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
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
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
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
import asdo.business.BusinessOrder
import asdo.business.BusinessOrderDateFilter
import asdo.business.BusinessOrderStatus
import asdo.business.DeliveryPersonSummary
import kotlinx.coroutines.launch
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import ui.cp.OrderSoundAlertBanner
import ui.sc.shared.Screen
import ui.th.spacing

const val BUSINESS_ORDERS_PATH = "/business/orders"

class BusinessOrdersScreen : Screen(BUSINESS_ORDERS_PATH) {

    override val messageTitle: MessageKey = MessageKey.business_orders_title

    private val logger = LoggerFactory.default.newLogger<BusinessOrdersScreen>()

    @Composable
    override fun screen() {
        logger.info { "Renderizando pantalla de pedidos del negocio" }
        ScreenContent()
    }

    @OptIn(ExperimentalLayoutApi::class)
    @Composable
    private fun ScreenContent(viewModel: BusinessOrdersViewModel = viewModel { BusinessOrdersViewModel() }) {
        val state = viewModel.state
        val coroutineScope = rememberCoroutineScope()
        val snackbarHostState = remember { SnackbarHostState() }

        LaunchedEffect(Unit) {
            coroutineScope.launch { viewModel.loadOrders() }
            coroutineScope.launch { viewModel.loadDeliveryPeople() }
        }

        val assignSuccessMsg = Txt(MessageKey.business_orders_assign_success)
        val assignErrorMsg = Txt(MessageKey.business_orders_assign_error)
        LaunchedEffect(state.assignSuccess) {
            if (state.assignSuccess != null) {
                snackbarHostState.showSnackbar(assignSuccessMsg)
                viewModel.clearAssignMessages()
            }
        }
        LaunchedEffect(state.assignError) {
            if (state.assignError != null) {
                snackbarHostState.showSnackbar(assignErrorMsg)
                viewModel.clearAssignMessages()
            }
        }

        Scaffold(
            snackbarHost = { SnackbarHost(snackbarHostState) }
        ) { padding ->
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(horizontal = MaterialTheme.spacing.x4),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3),
                contentPadding = PaddingValues(vertical = MaterialTheme.spacing.x4)
            ) {
                // Banner de alertas sonoras de pedidos nuevos
                item {
                    OrderSoundAlertBanner(
                        onOrderClick = { orderId ->
                            BusinessOrderSelectionStore.select(orderId)
                            navigate(BUSINESS_ORDER_DETAIL_PATH)
                        }
                    )
                }

                item {
                    Text(
                        text = Txt(MessageKey.business_orders_title),
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold
                    )
                }

                // Filtros de estado
                item {
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                    ) {
                        FilterChip(
                            selected = state.statusFilter == null,
                            onClick = { viewModel.selectStatusFilter(null) },
                            label = { Text(Txt(MessageKey.business_orders_filter_all)) }
                        )
                        BusinessOrderStatus.entries
                            .filter { it != BusinessOrderStatus.UNKNOWN }
                            .forEach { status ->
                                FilterChip(
                                    selected = state.statusFilter == status,
                                    onClick = { viewModel.selectStatusFilter(status) },
                                    label = { Text(status.toLabel()) }
                                )
                            }
                    }
                }

                // Filtros de fecha
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)) {
                        FilterChip(
                            selected = state.dateFilter == BusinessOrderDateFilter.ALL,
                            onClick = { viewModel.selectDateFilter(BusinessOrderDateFilter.ALL) },
                            label = { Text(Txt(MessageKey.business_orders_filter_all)) }
                        )
                        FilterChip(
                            selected = state.dateFilter == BusinessOrderDateFilter.TODAY,
                            onClick = { viewModel.selectDateFilter(BusinessOrderDateFilter.TODAY) },
                            label = { Text(Txt(MessageKey.business_orders_filter_today)) }
                        )
                        FilterChip(
                            selected = state.dateFilter == BusinessOrderDateFilter.LAST_7_DAYS,
                            onClick = { viewModel.selectDateFilter(BusinessOrderDateFilter.LAST_7_DAYS) },
                            label = { Text(Txt(MessageKey.business_orders_filter_last_7_days)) }
                        )
                    }
                }

                when {
                    state.isLoading -> item {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = MaterialTheme.spacing.x6),
                            contentAlignment = Alignment.Center
                        ) {
                            CircularProgressIndicator()
                        }
                    }

                    state.error != null -> item {
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
                                    text = Txt(MessageKey.business_orders_error),
                                    textAlign = TextAlign.Center,
                                    color = MaterialTheme.colorScheme.onErrorContainer
                                )
                                TextButton(onClick = {
                                    coroutineScope.launch { viewModel.loadOrders() }
                                }) {
                                    Text(Txt(MessageKey.business_orders_retry))
                                }
                            }
                        }
                    }

                    state.filteredOrders.isEmpty() -> item {
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
                                    text = Txt(MessageKey.business_orders_empty),
                                    textAlign = TextAlign.Center,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                    }

                    else -> items(state.filteredOrders, key = { it.id }) { order ->
                        BusinessOrderCard(
                            order = order,
                            deliveryPeople = state.deliveryPeople,
                            isLoadingDeliveryPeople = state.isLoadingDeliveryPeople,
                            isAssigning = state.assigningOrderId == order.id,
                            isExpanded = state.selectedOrderId == order.id,
                            onToggleAssignment = {
                                if (state.selectedOrderId == order.id) {
                                    viewModel.selectOrderForAssignment(null)
                                } else {
                                    viewModel.selectOrderForAssignment(order.id)
                                }
                            },
                            onAssign = { email ->
                                coroutineScope.launch {
                                    viewModel.assignDeliveryPerson(order.id, email)
                                }
                            }
                        )
                        BusinessOrderCard(order = order, onClick = { BusinessOrderSelectionStore.select(order.id); navigate(BUSINESS_ORDER_DETAIL_PATH) })
                    }
                }
            }
        }
    }
}

@Composable
private fun BusinessOrderCard(
    order: BusinessOrder,
    onClick: () -> Unit = {},
    deliveryPeople: List<DeliveryPersonSummary> = emptyList(),
    isLoadingDeliveryPeople: Boolean = false,
    isAssigning: Boolean = false,
    isExpanded: Boolean = false,
    onToggleAssignment: () -> Unit = {},
    onAssign: (String?) -> Unit = {}
) {
    Card(onClick = onClick,
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
                    text = order.status.toLabel(),
                    style = MaterialTheme.typography.labelMedium,
                    color = order.status.toColor()
                )
            }
            Text(
                text = order.clientEmail,
                style = MaterialTheme.typography.bodyMedium
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(
                    text = order.createdAt.formatDate(),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    text = "$${order.total}",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.primary
                )
            }

            Spacer(modifier = Modifier.height(MaterialTheme.spacing.x2))

            DeliveryPersonAssignmentSection(
                assignedEmail = order.assignedDeliveryPersonEmail,
                deliveryPeople = deliveryPeople,
                isLoadingDeliveryPeople = isLoadingDeliveryPeople,
                isAssigning = isAssigning,
                isExpanded = isExpanded,
                onToggle = onToggleAssignment,
                onAssign = onAssign
            )
        }
    }
}

@Composable
private fun DeliveryPersonAssignmentSection(
    assignedEmail: String?,
    deliveryPeople: List<DeliveryPersonSummary>,
    isLoadingDeliveryPeople: Boolean,
    isAssigning: Boolean,
    isExpanded: Boolean,
    onToggle: () -> Unit,
    onAssign: (String?) -> Unit
) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
    ) {
        Text(
            text = Txt(MessageKey.business_orders_assign_title),
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )

        val displayName = if (assignedEmail != null) {
            val person = deliveryPeople.find { it.email == assignedEmail }
            if (person != null && person.fullName.isNotBlank()) {
                Txt(MessageKey.business_orders_assigned_to, mapOf("name" to person.fullName))
            } else {
                Txt(MessageKey.business_orders_assigned_to, mapOf("name" to assignedEmail))
            }
        } else {
            Txt(MessageKey.business_orders_assign_unassigned)
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = displayName,
                style = MaterialTheme.typography.bodyMedium,
                color = if (assignedEmail != null)
                    MaterialTheme.colorScheme.primary
                else
                    MaterialTheme.colorScheme.onSurfaceVariant
            )

            if (isAssigning) {
                CircularProgressIndicator(
                    modifier = Modifier.padding(MaterialTheme.spacing.x1)
                )
            } else {
                Box {
                    OutlinedButton(onClick = onToggle) {
                        Text(Txt(MessageKey.business_orders_assign_select))
                    }
                    var dropdownExpanded by remember { mutableStateOf(false) }
                    LaunchedEffect(isExpanded) { dropdownExpanded = isExpanded }

                    DropdownMenu(
                        expanded = dropdownExpanded,
                        onDismissRequest = { onToggle() }
                    ) {
                        DropdownMenuItem(
                            text = {
                                Text(
                                    text = Txt(MessageKey.business_orders_assign_unassigned),
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            },
                            onClick = { onAssign(null) }
                        )

                        if (isLoadingDeliveryPeople) {
                            DropdownMenuItem(
                                text = { Text(text = Txt(MessageKey.business_orders_assign_loading), style = MaterialTheme.typography.bodySmall) },
                                onClick = { },
                                enabled = false
                            )
                        } else if (deliveryPeople.isEmpty()) {
                            DropdownMenuItem(
                                text = { Text(text = Txt(MessageKey.business_orders_delivery_people_empty), style = MaterialTheme.typography.bodySmall) },
                                onClick = { },
                                enabled = false
                            )
                        } else {
                            deliveryPeople.forEach { person ->
                                DropdownMenuItem(
                                    text = {
                                        Column {
                                            Text(
                                                text = person.fullName.ifBlank { person.email },
                                                style = MaterialTheme.typography.bodyMedium,
                                                fontWeight = if (person.email == assignedEmail) FontWeight.Bold else FontWeight.Normal
                                            )
                                            if (person.fullName.isNotBlank()) {
                                                Text(text = person.email, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                            }
                                        }
                                    },
                                    onClick = { onAssign(person.email) }
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun BusinessOrderStatus.toLabel(): String = when (this) {
    BusinessOrderStatus.PENDING -> Txt(MessageKey.business_orders_status_pending)
    BusinessOrderStatus.CONFIRMED -> Txt(MessageKey.business_orders_status_confirmed)
    BusinessOrderStatus.PREPARING -> Txt(MessageKey.business_orders_status_preparing)
    BusinessOrderStatus.READY -> Txt(MessageKey.business_orders_status_ready)
    BusinessOrderStatus.DELIVERING -> Txt(MessageKey.business_orders_status_delivering)
    BusinessOrderStatus.DELIVERED -> Txt(MessageKey.business_orders_status_delivered)
    BusinessOrderStatus.CANCELLED -> Txt(MessageKey.business_orders_status_cancelled)
    BusinessOrderStatus.UNKNOWN -> Txt(MessageKey.business_orders_status_pending)
}

@Composable
private fun BusinessOrderStatus.toColor() = when (this) {
    BusinessOrderStatus.DELIVERED -> androidx.compose.ui.graphics.Color(0xFF4CAF50)
    BusinessOrderStatus.CANCELLED -> MaterialTheme.colorScheme.error
    BusinessOrderStatus.PREPARING, BusinessOrderStatus.READY -> androidx.compose.ui.graphics.Color(0xFFFFC107)
    else -> MaterialTheme.colorScheme.primary
}

@Suppress("MagicNumber")
private fun String.formatDate(): String {
    if (isBlank()) return ""
    return try {
        val parts = substringBefore("T").split("-")
        if (parts.size == 3) "${parts[2]}/${parts[1]} ${substringAfter("T").take(5)}"
        else this
    } catch (_: Exception) {
        this
    }
}
