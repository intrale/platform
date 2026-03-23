package ext.client

import asdo.client.NotificationItem

/**
 * Implementación local de notificaciones basada en NotificationsStore.
 * Placeholder hasta integración con backend de notificaciones push.
 */
class NotificationsService : CommNotificationsService {

    override suspend fun getNotifications(): Result<List<NotificationItem>> =
        Result.success(NotificationsStore.notifications.value)

    override suspend fun markAsRead(notificationId: String): Result<Unit> = runCatching {
        NotificationsStore.markAsRead(notificationId)
    }

    override suspend fun markAllAsRead(): Result<Unit> = runCatching {
        NotificationsStore.markAllAsRead()
    }
}
