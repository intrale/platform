package ui.sc.client

import DIManager
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import asdo.client.NotificationItem
import asdo.client.NotificationType
import asdo.client.ToDoGetNotifications
import asdo.client.ToDoMarkAllNotificationsRead
import asdo.client.ToDoMarkNotificationRead
import kotlinx.coroutines.launch
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.Screen
import ui.sc.shared.ViewModel
import ui.th.spacing

const val CLIENT_NOTIFICATIONS_PATH = "/client/notifications"

// ─── UI State ──────────────────────────────────────────────────────────────

enum class NotificationsStatus { Idle, Loading, Loaded, Empty, Error }

data class NotificationsUiState(
    val status: NotificationsStatus = NotificationsStatus.Idle,
    val notifications: List<NotificationItem> = emptyList(),
    val errorMessage: String? = null
)

// ─── ViewModel ─────────────────────────────────────────────────────────────

class NotificationsViewModel(
    private val getNotifications: ToDoGetNotifications =
        DIManager.di.direct.instance(),
    private val markRead: ToDoMarkNotificationRead =
        DIManager.di.direct.instance(),
    private val markAllRead: ToDoMarkAllNotificationsRead =
        DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<NotificationsViewModel>()

    var state by mutableStateOf(NotificationsUiState())
        private set

    override fun getState(): Any = state

    override fun initInputState() { /* Sin formularios */ }

    suspend fun loadNotifications() {
        state = state.copy(status = NotificationsStatus.Loading, errorMessage = null)
        getNotifications.execute()
            .onSuccess { items ->
                state = if (items.isEmpty()) {
                    state.copy(status = NotificationsStatus.Empty, notifications = emptyList())
                } else {
                    state.copy(status = NotificationsStatus.Loaded, notifications = items)
                }
            }
            .onFailure { throwable ->
                logger.error(throwable) { "Error al cargar notificaciones" }
                state = state.copy(
                    status = NotificationsStatus.Error,
                    errorMessage = throwable.message ?: "Error al cargar notificaciones"
                )
            }
    }

    suspend fun markAsRead(notificationId: String) {
        markRead.execute(notificationId)
            .onSuccess {
                state = state.copy(
                    notifications = state.notifications.map {
                        if (it.id == notificationId) it.copy(isRead = true) else it
                    }
                )
            }
            .onFailure { throwable ->
                logger.error(throwable) { "Error al marcar notificacion $notificationId como leida" }
            }
    }

    suspend fun markAllAsRead() {
        markAllRead.execute()
            .onSuccess {
                state = state.copy(
                    notifications = state.notifications.map { it.copy(isRead = true) }
                )
            }
            .onFailure { throwable ->
                logger.error(throwable) { "Error al marcar todas las notificaciones como leidas" }
            }
    }

    fun clearError() {
        state = state.copy(errorMessage = null)
    }
}

// ─── Screen ────────────────────────────────────────────────────────────────

class NotificationsScreen : Screen(CLIENT_NOTIFICATIONS_PATH) {

    override val messageTitle: MessageKey = MessageKey.client_notifications_title

    @Composable
    override fun screen() {
        val viewModel: NotificationsViewModel = viewModel { NotificationsViewModel() }
        val uiState = viewModel.state
        val coroutineScope = rememberCoroutineScope()

        val title = Txt(MessageKey.client_notifications_title)
        val emptyMessage = Txt(MessageKey.client_notifications_empty)
        val errorMessage = Txt(MessageKey.client_notifications_error)
        val retryLabel = Txt(MessageKey.client_notifications_retry)
        val markAllReadLabel = Txt(MessageKey.client_notifications_mark_all_read)

        LaunchedEffect(Unit) {
            viewModel.loadNotifications()
        }

        Scaffold(
            bottomBar = {
                ClientBottomBar(
                    activeTab = ClientTab.NOTIFICATIONS,
                    onHomeClick = { navigate(CLIENT_HOME_PATH) },
                    onOrdersClick = { navigate(CLIENT_ORDERS_PATH) },
                    onNotificationsClick = { /* ya estamos aqui */ },
                    onProfileClick = { navigate(CLIENT_PROFILE_PATH) }
                )
            }
        ) { padding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
            ) {
                // Encabezado con botón "Marcar todas como leídas"
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(
                            horizontal = MaterialTheme.spacing.x4,
                            vertical = MaterialTheme.spacing.x2
                        ),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = title,
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold
                    )
                    val hasUnread = uiState.notifications.any { !it.isRead }
                    if (hasUnread) {
                        TextButton(onClick = {
                            coroutineScope.launch { viewModel.markAllAsRead() }
                        }) {
                            Text(text = markAllReadLabel)
                        }
                    }
                }

                when (uiState.status) {
                    NotificationsStatus.Loading -> {
                        Box(
                            modifier = Modifier.fillMaxSize(),
                            contentAlignment = Alignment.Center
                        ) {
                            CircularProgressIndicator()
                        }
                    }

                    NotificationsStatus.Empty -> {
                        NotificationsEmptyState(emptyMessage = emptyMessage)
                    }

                    NotificationsStatus.Error -> {
                        NotificationsErrorState(
                            errorMessage = uiState.errorMessage ?: errorMessage,
                            retryLabel = retryLabel,
                            onRetry = {
                                coroutineScope.launch { viewModel.loadNotifications() }
                            }
                        )
                    }

                    NotificationsStatus.Loaded -> {
                        LazyColumn(
                            modifier = Modifier.fillMaxSize(),
                            contentPadding = PaddingValues(
                                horizontal = MaterialTheme.spacing.x4,
                                vertical = MaterialTheme.spacing.x2
                            ),
                            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                        ) {
                            items(uiState.notifications, key = { it.id }) { notification ->
                                NotificationCard(
                                    notification = notification,
                                    onMarkRead = {
                                        coroutineScope.launch {
                                            viewModel.markAsRead(notification.id)
                                        }
                                    }
                                )
                            }
                        }
                    }

                    NotificationsStatus.Idle -> Unit
                }
            }
        }
    }
}

// ─── Componentes ───────────────────────────────────────────────────────────

@Composable
private fun NotificationCard(
    notification: NotificationItem,
    onMarkRead: () -> Unit
) {
    val containerColor = if (notification.isRead) {
        MaterialTheme.colorScheme.surface
    } else {
        MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.4f)
    }

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = !notification.isRead, onClick = onMarkRead),
        colors = CardDefaults.cardColors(containerColor = containerColor)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
        ) {
            NotificationTypeIcon(type = notification.type, isRead = notification.isRead)

            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x0_5)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = notification.title,
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = if (notification.isRead) FontWeight.Normal else FontWeight.SemiBold,
                        modifier = Modifier.weight(1f)
                    )
                    if (!notification.isRead) {
                        Box(
                            modifier = Modifier
                                .size(8.dp)
                                .background(
                                    color = MaterialTheme.colorScheme.primary,
                                    shape = CircleShape
                                )
                        )
                    }
                }
                Text(
                    text = notification.message,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    text = notification.businessName,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.outline
                )
            }
        }
    }
}

@Composable
private fun NotificationTypeIcon(type: NotificationType, isRead: Boolean) {
    val tint = if (isRead) {
        MaterialTheme.colorScheme.onSurfaceVariant
    } else {
        MaterialTheme.colorScheme.primary
    }
    Icon(
        imageVector = Icons.Default.Notifications,
        contentDescription = null,
        tint = tint,
        modifier = Modifier.size(24.dp)
    )
}

@Composable
private fun NotificationsEmptyState(emptyMessage: String) {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Icon(
                imageVector = Icons.Default.Notifications,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(64.dp)
            )
            Text(
                text = emptyMessage,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(horizontal = 32.dp)
            )
        }
    }
}

@Composable
private fun NotificationsErrorState(
    errorMessage: String,
    retryLabel: String,
    onRetry: () -> Unit
) {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Text(
                text = errorMessage,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.error,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(horizontal = 32.dp)
            )
            TextButton(onClick = onRetry) {
                Text(text = retryLabel)
            }
        }
    }
}
