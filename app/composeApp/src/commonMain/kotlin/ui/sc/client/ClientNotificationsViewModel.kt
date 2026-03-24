package ui.sc.client

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.client.ClientNotification
import asdo.client.ToDoGetNotifications
import asdo.client.ToDoMarkAllNotificationsRead
import asdo.client.ToDoMarkNotificationRead
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

enum class NotificationsStatus { Idle, Loading, Loaded, Empty }

data class ClientNotificationsUiState(
    val status: NotificationsStatus = NotificationsStatus.Idle,
    val notifications: List<ClientNotification> = emptyList(),
    val unreadCount: Int = 0,
    val errorMessage: String? = null
)

class ClientNotificationsViewModel(
    private val getNotifications: ToDoGetNotifications = DIManager.di.direct.instance(),
    private val markRead: ToDoMarkNotificationRead = DIManager.di.direct.instance(),
    private val markAllRead: ToDoMarkAllNotificationsRead = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<ClientNotificationsViewModel>()

    var state by mutableStateOf(ClientNotificationsUiState())
        private set

    override fun getState(): Any = state

    override fun initInputState() {
        // Sin formularios en pantalla de notificaciones
    }

    suspend fun loadNotifications() {
        state = state.copy(status = NotificationsStatus.Loading, errorMessage = null)
        getNotifications.execute()
            .onSuccess { notifications ->
                val unread = notifications.count { !it.isRead }
                state = if (notifications.isEmpty()) {
                    state.copy(
                        status = NotificationsStatus.Empty,
                        notifications = emptyList(),
                        unreadCount = 0
                    )
                } else {
                    state.copy(
                        status = NotificationsStatus.Loaded,
                        notifications = notifications,
                        unreadCount = unread
                    )
                }
            }
            .onFailure { throwable ->
                logger.error(throwable) { "Error al cargar notificaciones" }
                state = state.copy(
                    status = NotificationsStatus.Empty,
                    errorMessage = throwable.message
                )
            }
    }

    suspend fun markNotificationAsRead(notificationId: String) {
        markRead.execute(notificationId)
            .onSuccess { loadNotifications() }
            .onFailure { throwable ->
                logger.error(throwable) { "Error al marcar notificacion $notificationId como leida" }
            }
    }

    suspend fun markAllNotificationsAsRead() {
        markAllRead.execute()
            .onSuccess { loadNotifications() }
            .onFailure { throwable ->
                logger.error(throwable) { "Error al marcar todas las notificaciones como leidas" }
            }
    }

    fun clearError() {
        state = state.copy(errorMessage = null)
    }
}
