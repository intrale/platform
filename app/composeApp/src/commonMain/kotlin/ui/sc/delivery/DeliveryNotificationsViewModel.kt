package ui.sc.delivery

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.delivery.DeliveryNotification
import asdo.delivery.ToDoGetDeliveryNotifications
import asdo.delivery.ToDoMarkAllDeliveryNotificationsRead
import asdo.delivery.ToDoMarkDeliveryNotificationRead
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

enum class DeliveryNotificationsStatus { Idle, Loading, Loaded, Empty }

data class DeliveryNotificationsUiState(
    val status: DeliveryNotificationsStatus = DeliveryNotificationsStatus.Idle,
    val notifications: List<DeliveryNotification> = emptyList(),
    val unreadCount: Int = 0,
    val errorMessage: String? = null
)

class DeliveryNotificationsViewModel(
    private val getNotifications: ToDoGetDeliveryNotifications = DIManager.di.direct.instance(),
    private val markRead: ToDoMarkDeliveryNotificationRead = DIManager.di.direct.instance(),
    private val markAllRead: ToDoMarkAllDeliveryNotificationsRead = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<DeliveryNotificationsViewModel>()

    var state by mutableStateOf(DeliveryNotificationsUiState())
        private set

    override fun getState(): Any = state

    override fun initInputState() {
        // Sin formularios en pantalla de notificaciones
    }

    suspend fun loadNotifications() {
        state = state.copy(status = DeliveryNotificationsStatus.Loading, errorMessage = null)
        getNotifications.execute()
            .onSuccess { notifications ->
                val unread = notifications.count { !it.isRead }
                state = if (notifications.isEmpty()) {
                    state.copy(
                        status = DeliveryNotificationsStatus.Empty,
                        notifications = emptyList(),
                        unreadCount = 0
                    )
                } else {
                    state.copy(
                        status = DeliveryNotificationsStatus.Loaded,
                        notifications = notifications,
                        unreadCount = unread
                    )
                }
            }
            .onFailure { throwable ->
                logger.error(throwable) { "Error al cargar notificaciones" }
                state = state.copy(
                    status = DeliveryNotificationsStatus.Empty,
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
