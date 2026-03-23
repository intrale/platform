package ui.sc.client

import DIManager
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Notifications
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import asdo.client.ClientNotification
import asdo.client.NotificationType
import asdo.client.ToDoGetNotifications
import asdo.client.ToDoMarkAllNotificationsAsRead
import asdo.client.ToDoMarkNotificationAsRead
import kotlinx.coroutines.launch
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.Screen
import ui.sc.shared.ViewModel
import ui.th.spacing

const val CLIENT_NOTIFICATIONS_PATH = "/client/notifications"

enum class ClientNotificationsStatus { Idle, Loading, Loaded, Empty, Error }

data class ClientNotificationsUiState(
    val status: ClientNotificationsStatus = ClientNotificationsStatus.Idle,
    val notifications: List<ClientNotification> = emptyList(),
    val errorMessage: String? = null,
    val markingAllRead: Boolean = false
)

class ClientNotificationsViewModel(
    private val getNotifications: ToDoGetNotifications = DIManager.di.direct.instance(),
    private val markAsRead: ToDoMarkNotificationAsRead = DIManager.di.direct.instance(),
    private val markAllAsRead: ToDoMarkAllNotificationsAsRead = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<ClientNotificationsViewModel>()

    var state by mutableStateOf(ClientNotificationsUiState())
        private set

    override fun getState(): Any = state

    override fun initInputState() {}

    suspend fun loadNotifications() {
        state = state.copy(status = ClientNotificationsStatus.Loading, errorMessage = null)
        getNotifications.execute()
            .onSuccess { notifications ->
                state = if (notifications.isEmpty()) {
                    state.copy(status = ClientNotificationsStatus.Empty, notifications = emptyList())
                } else {
                    state.copy(status = ClientNotificationsStatus.Loaded, notifications = notifications)
                }
            }
            .onFailure { throwable ->
                logger.error(throwable) { "Error al cargar notificaciones" }
                state = state.copy(
                    status = ClientNotificationsStatus.Error,
                    errorMessage = throwable.message ?: "Error al cargar notificaciones"
                )
            }
    }

    suspend fun markNotificationAsRead(notificationId: String) {
        markAsRead.execute(notificationId)
            .onSuccess {
                state = state.copy(
                    notifications = state.notifications.map {
                        if (it.id == notificationId) it.copy(isRead = true) else it
                    }
                )
            }
            .onFailure { throwable ->
                logger.error(throwable) { "Error al marcar notificacion como leida" }
            }
    }

    suspend fun markAllNotificationsAsRead() {
        state = state.copy(markingAllRead = true)
        markAllAsRead.execute()
            .onSuccess {
                state = state.copy(
                    markingAllRead = false,
                    notifications = state.notifications.map { it.copy(isRead = true) }
                )
            }
            .onFailure { throwable ->
                logger.error(throwable) { "Error al marcar todas las notificaciones como leidas" }
                state = state.copy(markingAllRead = false)
            }
    }

    fun clearError() {
        state = state.copy(errorMessage = null)
    }
}

class ClientNotificationsScreen : Screen(CLIENT_NOTIFICATIONS_PATH) {

    @Composable
    override fun screen() {
        val viewModel: ClientNotificationsViewModel = viewModel { ClientNotificationsViewModel() }
        val uiState = viewModel.state
        val coroutineScope = rememberCoroutineScope()

        val title = Txt(MessageKey.client_notifications_title)
        val emptyMessage = Txt(MessageKey.client_notifications_empty)
        val markAllReadLabel = Txt(MessageKey.client_notifications_mark_all_read)
        val pushPlaceholder = Txt(MessageKey.client_notifications_push_placeholder)
        val markReadLabel = Txt(MessageKey.client_notifications_mark_read)

        val unreadCount = uiState.notifications.count { !it.isRead }
        val unreadLabel = if (unreadCount > 0) {
            Txt(MessageKey.client_notifications_unread_count, mapOf("count" to unreadCount.toString()))
        } else null

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
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(horizontal = MaterialTheme.spacing.x4)
            ) {
                Spacer(modifier = Modifier.height(MaterialTheme.spacing.x4))

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column {
                        Text(
                            text = title,
                            style = MaterialTheme.typography.headlineSmall,
                            fontWeight = FontWeight.Bold
                        )
                        if (unreadLabel != null) {
                            Text(
                                text = unreadLabel,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.primary
                            )
                        }
                    }
                    if (uiState.notifications.any { !it.isRead }) {
                        TextButton(
                            onClick = {
                                coroutineScope.launch { viewModel.markAllNotificationsAsRead() }
                            },
                            enabled = !uiState.markingAllRead
                        ) {
                            Text(text = markAllReadLabel)
                        }
                    }
                }

                Spacer(modifier = Modifier.height(MaterialTheme.spacing.x2))

                when (uiState.status) {
                    ClientNotificationsStatus.Loading -> {
                        Box(
                            modifier = Modifier.fillMaxSize(),
                            contentAlignment = Alignment.Center
                        ) {
                            CircularProgressIndicator()
                        }
                    }

                    ClientNotificationsStatus.Empty -> {
                        Box(
                            modifier = Modifier.fillMaxSize(),
                            contentAlignment = Alignment.Center
                        ) {
                            Column(
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                            ) {
                                Icon(
                                    imageVector = Icons.Default.Notifications,
                                    contentDescription = null,
                                    modifier = Modifier.size(48.dp),
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)
                                )
                                Text(
                                    text = emptyMessage,
                                    style = MaterialTheme.typography.bodyLarge,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    textAlign = TextAlign.Center
                                )
                                Text(
                                    text = pushPlaceholder,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                                    textAlign = TextAlign.Center
                                )
                            }
                        }
                    }

                    ClientNotificationsStatus.Loaded -> {
                        LazyColumn(
                            modifier = Modifier.fillMaxSize(),
                            contentPadding = PaddingValues(vertical = MaterialTheme.spacing.x2),
                            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                        ) {
                            items(uiState.notifications, key = { it.id }) { notification ->
                                NotificationCard(
                                    notification = notification,
                                    markReadLabel = markReadLabel,
                                    onMarkRead = {
                                        if (!notification.isRead) {
                                            coroutineScope.launch {
                                                viewModel.markNotificationAsRead(notification.id)
                                            }
                                        }
                                    }
                                )
                            }
                        }
                    }

                    ClientNotificationsStatus.Error -> {
                        Box(
                            modifier = Modifier.fillMaxSize(),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                text = uiState.errorMessage ?: "Error al cargar notificaciones",
                                style = MaterialTheme.typography.bodyLarge,
                                color = MaterialTheme.colorScheme.error
                            )
                        }
                    }

                    ClientNotificationsStatus.Idle -> Unit
                }
            }
        }
    }
}

@Composable
private fun NotificationCard(
    notification: ClientNotification,
    markReadLabel: String,
    onMarkRead: () -> Unit
) {
    val typeLabel = when (notification.type) {
        NotificationType.ORDER_CREATED -> Txt(MessageKey.client_notifications_type_order_created)
        NotificationType.ORDER_STATUS_CHANGED -> Txt(MessageKey.client_notifications_type_status_changed)
        NotificationType.ORDER_CANCELLED -> Txt(MessageKey.client_notifications_type_cancelled)
        NotificationType.BUSINESS_MESSAGE -> Txt(MessageKey.client_notifications_type_business_message)
    }

    val backgroundColor = if (notification.isRead) {
        MaterialTheme.colorScheme.surface
    } else {
        MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.3f)
    }

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onMarkRead),
        colors = CardDefaults.cardColors(containerColor = backgroundColor)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2),
            verticalAlignment = Alignment.Top
        ) {
            if (!notification.isRead) {
                Box(
                    modifier = Modifier
                        .padding(top = MaterialTheme.spacing.x1)
                        .size(8.dp)
                        .background(
                            color = MaterialTheme.colorScheme.primary,
                            shape = CircleShape
                        )
                )
            } else {
                Box(modifier = Modifier.size(8.dp))
            }

            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x0_5)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(
                        text = typeLabel,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary
                    )
                    Text(
                        text = notification.timestamp,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Text(
                    text = notification.title,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = if (notification.isRead) FontWeight.Normal else FontWeight.SemiBold
                )
                Text(
                    text = notification.body,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}
