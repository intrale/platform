package ui.sc.client

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
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
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
import asdo.client.ClientNotification
import asdo.client.NotificationEventType
import kotlinx.coroutines.launch
import ui.sc.shared.Screen
import ui.th.spacing

const val CLIENT_NOTIFICATIONS_PATH = "/client/notifications"

class ClientNotificationsScreen : Screen(CLIENT_NOTIFICATIONS_PATH) {

    override val messageTitle: MessageKey = MessageKey.client_notifications_title

    @Composable
    override fun screen() {
        val viewModel: ClientNotificationsViewModel = viewModel { ClientNotificationsViewModel() }
        val state = viewModel.state
        val coroutineScope = rememberCoroutineScope()

        val title = Txt(MessageKey.client_notifications_title)
        val emptyMessage = Txt(MessageKey.client_notifications_empty)
        val markAllLabel = Txt(MessageKey.client_notifications_mark_all_read)
        val pushActiveLabel = Txt(MessageKey.client_push_status_active)
        val pushInactiveLabel = Txt(MessageKey.client_push_status_inactive)
        val pushPrefs = ClientPushPreferencesStore.preferences.collectAsState()
        val pushStatusText = if (pushPrefs.value.enabled) pushActiveLabel else pushInactiveLabel

        LaunchedEffect(Unit) {
            viewModel.loadNotifications()
        }

        Scaffold(
            bottomBar = {
                ClientBottomBar(
                    activeTab = ClientTab.NOTIFICATIONS,
                    onHomeClick = { navigate(CLIENT_HOME_PATH) },
                    onOrdersClick = { navigate(CLIENT_ORDERS_PATH) },
                    onNotificationsClick = {},
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
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                    ) {
                        Box(
                            modifier = Modifier
                                .size(8.dp)
                                .clip(CircleShape)
                                .background(
                                    if (pushPrefs.value.enabled)
                                        MaterialTheme.colorScheme.primary
                                    else
                                        MaterialTheme.colorScheme.outline
                                )
                        )
                        Text(
                            text = pushStatusText,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }

                when (state.status) {
                    NotificationsStatus.Loading -> item {
                        Box(
                            modifier = Modifier.fillMaxWidth().padding(MaterialTheme.spacing.x4),
                            contentAlignment = Alignment.Center
                        ) {
                            CircularProgressIndicator()
                        }
                    }

                    NotificationsStatus.Empty -> item {
                        Card(
                            modifier = Modifier.fillMaxWidth(),
                            colors = CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.surfaceVariant
                            )
                        ) {
                            Text(
                                text = emptyMessage,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(MaterialTheme.spacing.x4),
                                textAlign = TextAlign.Center,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }

                    NotificationsStatus.Loaded -> {
                        items(state.notifications, key = { it.id }) { notification ->
                            NotificationCard(
                                notification = notification,
                                onMarkRead = {
                                    coroutineScope.launch {
                                        viewModel.markNotificationAsRead(notification.id)
                                    }
                                },
                                onNavigateToOrder = {
                                    ClientOrderSelectionStore.select(notification.orderId)
                                    navigate(CLIENT_ORDER_DETAIL_PATH)
                                }
                            )
                        }
                    }

                    NotificationsStatus.Idle -> {}
                }
            }
        }
    }
}

@Composable
private fun NotificationCard(
    notification: ClientNotification,
    onMarkRead: () -> Unit,
    onNavigateToOrder: () -> Unit
) {
    val markReadLabel = Txt(MessageKey.client_notifications_mark_read)
    val unreadLabel = Txt(MessageKey.client_notifications_unread_badge)

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
                    NotificationIcon(eventType = notification.eventType)
                    Column {
                        Text(
                            text = notification.buildDisplayMessage(),
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = if (!notification.isRead) FontWeight.SemiBold else FontWeight.Normal
                        )
                        Text(
                            text = notification.timestamp,
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
private fun NotificationIcon(eventType: NotificationEventType) {
    val eventTypeDescription = when (eventType) {
        NotificationEventType.ORDER_CREATED -> Txt(MessageKey.client_notifications_icon_order_created)
        NotificationEventType.ORDER_CONFIRMED -> Txt(MessageKey.client_notifications_icon_order_confirmed)
        NotificationEventType.ORDER_PREPARING -> Txt(MessageKey.client_notifications_icon_order_preparing)
        NotificationEventType.ORDER_READY -> Txt(MessageKey.client_notifications_icon_order_ready)
        NotificationEventType.ORDER_DELIVERING -> Txt(MessageKey.client_notifications_icon_order_delivering)
        NotificationEventType.ORDER_DELIVERED -> Txt(MessageKey.client_notifications_icon_order_delivered)
        NotificationEventType.ORDER_CANCELLED -> Txt(MessageKey.client_notifications_icon_order_cancelled)
        NotificationEventType.BUSINESS_MESSAGE -> Txt(MessageKey.client_notifications_icon_business_message)
    }

    val (emoji, bgColor) = when (eventType) {
        NotificationEventType.ORDER_CREATED -> "\uD83D\uDCE6" to MaterialTheme.colorScheme.primaryContainer
        NotificationEventType.ORDER_CONFIRMED -> "\u2705" to MaterialTheme.colorScheme.primaryContainer
        NotificationEventType.ORDER_PREPARING -> "\uD83D\uDD73\uFE0F" to MaterialTheme.colorScheme.secondaryContainer
        NotificationEventType.ORDER_READY -> "\uD83D\uDECE\uFE0F" to MaterialTheme.colorScheme.secondaryContainer
        NotificationEventType.ORDER_DELIVERING -> "\uD83D\uDEB4" to MaterialTheme.colorScheme.tertiaryContainer
        NotificationEventType.ORDER_DELIVERED -> "\uD83C\uDF89" to MaterialTheme.colorScheme.tertiaryContainer
        NotificationEventType.ORDER_CANCELLED -> "\u274C" to MaterialTheme.colorScheme.errorContainer
        NotificationEventType.BUSINESS_MESSAGE -> "\uD83D\uDCAC" to MaterialTheme.colorScheme.secondaryContainer
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

private fun ClientNotification.buildDisplayMessage(): String {
    return when (eventType) {
        NotificationEventType.BUSINESS_MESSAGE ->
            if (message.isNotBlank()) "${businessName}: $message" else businessName
        else -> "#$shortCode - $businessName"
    }
}
