package ext.client

import asdo.client.ClientNotification

interface CommNotificationService {
    suspend fun listNotifications(): Result<List<ClientNotification>>
    suspend fun markAsRead(notificationId: String): Result<Unit>
    suspend fun markAllAsRead(): Result<Unit>
}
