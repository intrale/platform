package ui.sc.delivery

import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import asdo.delivery.DeliveryNotification
import asdo.delivery.DeliveryNotificationEventType
import kotlinx.coroutines.launch
import ui.sc.shared.Screen
import ui.th.spacing

const val DELIVERY_NOTIFICATIONS_PATH = "/delivery/notifications"

class DeliveryNotificationsScreen : Screen(DELIVERY_NOTIFICATIONS_PATH) {

    override val messageTitle: MessageKey = MessageKey.delivery_notifications_title

    @Composable
    override fun screen() {
        val viewModel: DeliveryNotificationsViewModel = viewModel { DeliveryNotificationsViewModel() }
        val state = viewModel.state
        val coroutineScope = rememberCoroutineScope()

        val title = Txt(MessageKey.delivery_notifications_title)
        val emptyMessage = Txt(MessageKey.delivery_notifications_empty)
        val markAllLabel = Txt(MessageKey.delivery_notifications_mark_all_read)
        val pushPlaceholder = Txt(MessageKey.delivery_notifications_push_placeholder)

        LaunchedEffect(Unit) {
            viewModel.loadNotifications()
        }

        Scaffold(
            bottomBar = {
                DeliveryBottomBar(
                    activeTab = DeliveryTab.NOTIFICATIONS,
                    onHomeClick = { navigate(DELIVERY_HOME_PATH) },
                    onOrdersClick = { navigate(DELIVERY_DASHBOARD_PATH) },
                    onNotificationsClick = {},
                    onProfileClick = { navigate(DELIVERY_PROFILE_PATH) }
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
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = title,
                            style = MaterialTheme.typography.headlineSmall,
                            fontWeight = FontWeight.Bold
                        )
                        if (state.unreadCount > 0) {
                            TextButton(onClick = {
                                coroutineScope.launch { viewModel.markAllNotificationsAsRead() }
                            }) {
                                Text(markAllLabel)
                            }
                        }
                    }
                }

                item {
                    Text(
                        text = pushPlaceholder,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }

                when (state.status) {
                    DeliveryNotificationsStatus.Loading -> item {
                        Box(
                            modifier = Modifier.fillMaxWidth().padding(MaterialTheme.spacing.x4),
                            contentAlignment = Alignment.Center
                        ) {
                            CircularProgressIndicator()
                        }
                    }

                    DeliveryNotificationsStatus.Empty -> item {
                        Column(
                            modifier = Modifier.fillMaxWidth().padding(MaterialTheme.spacing.x4),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                        ) {
                            Icon(
                                imageVector = Icons.Default.Notifications,
                                contentDescription = null,
                                modifier = Modifier.size(48.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            Text(
                                text = emptyMessage,
                                textAlign = TextAlign.Center,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }

                    DeliveryNotificationsStatus.Loaded -> {
                        items(state.notifications, key = { it.id }) { notification ->
                            DeliveryNotificationCard(
                                notification = notification,
                                onMarkRead = {
                                    coroutineScope.launch {
                                        viewModel.markNotificationAsRead(notification.id)
                                    }
                                },
                                onNavigateToOrder = {
                                    DeliveryOrderSelectionStore.select(notification.orderId)
                                    navigate(DELIVERY_ORDER_DETAIL_PATH)
                                }
                            )
                        }
                    }

                    DeliveryNotificationsStatus.Idle -> {}
                }
            }
        }
    }
}

@Composable
private fun DeliveryNotificationCard(
    notification: DeliveryNotification,
    onMarkRead: () -> Unit,
    onNavigateToOrder: () -> Unit
) {
    val markReadLabel = Txt(MessageKey.delivery_notifications_mark_read)

    val containerColor = if (notification.isRead) {
        MaterialTheme.colorScheme.surfaceVariant
    } else {
        MaterialTheme.colorScheme.primaryContainer
    }

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onNavigateToOrder() },
        colors = CardDefaults.cardColors(containerColor = containerColor)
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
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                ) {
                    DeliveryNotificationIcon(eventType = notification.eventType)
                    Column {
                        Text(
                            text = notification.buildDisplayTitle(),
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = if (!notification.isRead) FontWeight.SemiBold else FontWeight.Normal
                        )
                        Text(
                            text = "${notification.label} - ${notification.businessName}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
                if (!notification.isRead) {
                    Box(
                        modifier = Modifier
                            .size(8.dp)
                            .clip(CircleShape)
                            .background(MaterialTheme.colorScheme.primary)
                    )
                }
            }
            if (!notification.isRead) {
                OutlinedButton(
                    onClick = onMarkRead,
                    modifier = Modifier
                        .align(Alignment.End)
                        .heightIn(min = 48.dp)
                ) {
                    Text(
                        text = markReadLabel,
                        style = MaterialTheme.typography.labelMedium
                    )
                }
            }
        }
    }
}

@Composable
private fun DeliveryNotificationIcon(eventType: DeliveryNotificationEventType) {
    val eventTypeDescription = when (eventType) {
        DeliveryNotificationEventType.ORDER_AVAILABLE -> "Pedido disponible"
        DeliveryNotificationEventType.ORDER_ASSIGNED -> "Pedido asignado"
        DeliveryNotificationEventType.ORDER_DELIVERED -> "Pedido entregado"
        DeliveryNotificationEventType.ORDER_NOT_DELIVERED -> "Pedido no entregado"
    }

    val (emoji, bgColor) = when (eventType) {
        DeliveryNotificationEventType.ORDER_AVAILABLE -> "\uD83D\uDCE6" to MaterialTheme.colorScheme.primaryContainer
        DeliveryNotificationEventType.ORDER_ASSIGNED -> "\uD83D\uDEB4" to MaterialTheme.colorScheme.secondaryContainer
        DeliveryNotificationEventType.ORDER_DELIVERED -> "\u2705" to MaterialTheme.colorScheme.tertiaryContainer
        DeliveryNotificationEventType.ORDER_NOT_DELIVERED -> "\u274C" to MaterialTheme.colorScheme.errorContainer
    }
    Box(
        modifier = Modifier
            .size(36.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(bgColor)
            .semantics { contentDescription = eventTypeDescription },
        contentAlignment = Alignment.Center
    ) {
        Text(text = emoji, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun DeliveryNotification.buildDisplayTitle(): String {
    val available = Txt(MessageKey.delivery_notifications_event_new_order)
    val assigned = Txt(MessageKey.delivery_notifications_event_assigned)
    val delivered = Txt(MessageKey.delivery_notifications_event_delivered)
    val notDelivered = Txt(MessageKey.delivery_notifications_event_not_delivered)

    return when (eventType) {
        DeliveryNotificationEventType.ORDER_AVAILABLE -> available
        DeliveryNotificationEventType.ORDER_ASSIGNED -> assigned
        DeliveryNotificationEventType.ORDER_DELIVERED -> delivered
        DeliveryNotificationEventType.ORDER_NOT_DELIVERED -> notDelivered
    }
}
