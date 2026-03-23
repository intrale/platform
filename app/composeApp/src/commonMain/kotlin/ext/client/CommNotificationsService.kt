package ext.client

import asdo.client.NotificationItem

interface CommNotificationsService {
    suspend fun getNotifications(): Result<List<NotificationItem>>
    suspend fun markAsRead(notificationId: String): Result<Unit>
    suspend fun markAllAsRead(): Result<Unit>
}
