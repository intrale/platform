package ui.sc.client

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
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import asdo.client.ClientNotification
import asdo.client.NotificationType
import ext.client.ClientNotificationsLocalStore
import kotlinx.coroutines.launch
import DIManager
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.client.ToDoGetClientNotifications
import asdo.client.ToDoMarkAllNotificationsRead
import asdo.client.ToDoMarkNotificationRead
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
    val errorMessage: String? = null
) {
    val unreadCount: Int get() = notifications.count { !it.isRead }
}

class ClientNotificationsScreen : Screen(CLIENT_NOTIFICATIONS_PATH) {

    override val messageTitle: MessageKey = MessageKey.client_notifications_title

    @Composable
    override fun screen() {
        val viewModel: ClientNotificationsViewModel = viewModel { ClientNotificationsViewModel() }
        val state = viewModel.state
        val coroutineScope = rememberCoroutineScope()

        val title = Txt(MessageKey.client_notifications_title)
        val emptyMessage = Txt(MessageKey.client_notifications_empty)
        val loadingMessage = Txt(MessageKey.client_notifications_loading)
        val errorLabel = Txt(MessageKey.client_notifications_error)
        val retryLabel = Txt(MessageKey.client_notifications_retry)
        val markAllReadLabel = Txt(MessageKey.client_notifications_mark_all_read)

        val storeNotifications by ClientNotificationsLocalStore.notifications.collectAsState()

        LaunchedEffect(Unit) {
            viewModel.loadNotifications()
        }

        LaunchedEffect(storeNotifications) {
            viewModel.loadNotifications()
        }

        Scaffold { padding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(
                            horizontal = MaterialTheme.spacing.x4,
                            vertical = MaterialTheme.spacing.x3
                        ),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = title,
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold
                    )
                    if (state.unreadCount > 0) {
                        TextButton(onClick = { coroutineScope.launch { viewModel.markAllNotificationsAsRead() } }) {
                            Text(text = markAllReadLabel)
                        }
                    }
                }

                HorizontalDivider()

                when (state.status) {
                    ClientNotificationsStatus.Idle,
                    ClientNotificationsStatus.Loading -> {
                        Box(
                            modifier = Modifier.fillMaxSize(),
                            contentAlignment = Alignment.Center
                        ) {
                            Column(
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                            ) {
                                CircularProgressIndicator()
                                Text(text = loadingMessage)
                            }
                        }
                    }

                    ClientNotificationsStatus.Error -> {
                        Box(
                            modifier = Modifier.fillMaxSize(),
                            contentAlignment = Alignment.Center
                        ) {
                            Column(
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2),
                                modifier = Modifier.padding(MaterialTheme.spacing.x4)
                            ) {
                                Text(
                                    text = state.errorMessage ?: errorLabel,
                                    style = MaterialTheme.typography.bodyLarge,
                                    color = MaterialTheme.colorScheme.error
                                )
                                TextButton(onClick = { coroutineScope.launch { viewModel.loadNotifications() } }) {
                                    Text(text = retryLabel)
                                }
                            }
                        }
                    }

                    ClientNotificationsStatus.Empty -> {
                        Box(
                            modifier = Modifier.fillMaxSize(),
                            contentAlignment = Alignment.Center
                        ) {
                            Column(
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
                            ) {
                                Icon(
                                    imageVector = Icons.Default.Notifications,
                                    contentDescription = null,
                                    modifier = Modifier.size(56.dp),
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                                Text(
                                    text = emptyMessage,
                                    style = MaterialTheme.typography.bodyLarge,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                    }

                    ClientNotificationsStatus.Loaded -> {
                        LazyColumn(
                            modifier = Modifier.fillMaxSize(),
                            contentPadding = PaddingValues(
                                horizontal = MaterialTheme.spacing.x4,
                                vertical = MaterialTheme.spacing.x2
                            ),
                            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                        ) {
                            items(state.notifications, key = { it.id }) { notification ->
                                ClientNotificationItem(
                                    notification = notification,
                                    onClick = {
                                        coroutineScope.launch {
                                            viewModel.markNotificationAsRead(notification.id)
                                        }
                                    }
                                )
                            }
                            item { Spacer(modifier = Modifier.height(MaterialTheme.spacing.x8)) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ClientNotificationItem(
    notification: ClientNotification,
    onClick: () -> Unit
) {
    val typeLabel = when (notification.type) {
        NotificationType.ORDER_CREATED -> Txt(MessageKey.client_notifications_type_order_created)
        NotificationType.ORDER_STATUS_CHANGED -> Txt(MessageKey.client_notifications_type_order_status)
        NotificationType.ORDER_CANCELLED -> Txt(MessageKey.client_notifications_type_order_cancelled)
        NotificationType.BUSINESS_MESSAGE -> Txt(MessageKey.client_notifications_type_business_message)
        NotificationType.UNKNOWN -> Txt(MessageKey.client_notifications_type_unknown)
    }

    val containerColor = if (!notification.isRead) {
        MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.3f)
    } else {
        MaterialTheme.colorScheme.surface
    }

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = containerColor)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3),
            verticalAlignment = Alignment.Top
        ) {
            if (!notification.isRead) {
                Box(
                    modifier = Modifier
                        .padding(top = MaterialTheme.spacing.x1)
                        .size(10.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.primary)
                )
            } else {
                Spacer(modifier = Modifier.size(10.dp))
            }

            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = notification.title,
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = if (!notification.isRead) FontWeight.SemiBold else FontWeight.Normal
                    )
                    Text(
                        text = typeLabel,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary
                    )
                }
                Text(
                    text = notification.message,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

class ClientNotificationsViewModel(
    private val toDoGetClientNotifications: ToDoGetClientNotifications = DIManager.di.direct.instance(),
    private val toDoMarkNotificationRead: ToDoMarkNotificationRead = DIManager.di.direct.instance(),
    private val toDoMarkAllNotificationsRead: ToDoMarkAllNotificationsRead = DIManager.di.direct.instance()
) : ViewModel() {

    private val logger = LoggerFactory.default.newLogger<ClientNotificationsViewModel>()

    var state by mutableStateOf(ClientNotificationsUiState())
        private set

    override fun getState(): Any = state

    override fun initInputState() { /* Sin inputs */ }

    suspend fun loadNotifications() {
        state = state.copy(status = ClientNotificationsStatus.Loading, errorMessage = null)
        state = toDoGetClientNotifications.execute()
            .fold(
                onSuccess = { notifications ->
                    if (notifications.isEmpty()) {
                        state.copy(status = ClientNotificationsStatus.Empty, notifications = emptyList())
                    } else {
                        state.copy(status = ClientNotificationsStatus.Loaded, notifications = notifications)
                    }
                },
                onFailure = { error ->
                    logger.error(error) { "Error al cargar notificaciones" }
                    state.copy(
                        status = ClientNotificationsStatus.Error,
                        errorMessage = error.message ?: "Error inesperado"
                    )
                }
            )
    }

    suspend fun markNotificationAsRead(notificationId: String) {
        toDoMarkNotificationRead.execute(notificationId)
            .onSuccess {
                state = state.copy(
                    notifications = state.notifications.map { n ->
                        if (n.id == notificationId) n.copy(isRead = true) else n
                    }
                )
            }
            .onFailure { error ->
                logger.error(error) { "Error al marcar notificacion $notificationId como leida" }
            }
    }

    suspend fun markAllNotificationsAsRead() {
        toDoMarkAllNotificationsRead.execute()
            .onSuccess {
                state = state.copy(
                    notifications = state.notifications.map { it.copy(isRead = true) }
                )
            }
            .onFailure { error ->
                logger.error(error) { "Error al marcar todas las notificaciones como leidas" }
            }
    }
}
