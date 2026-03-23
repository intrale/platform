package asdo.client

interface ToDoGetNotifications {
    suspend fun execute(): Result<List<ClientNotification>>
}

interface ToDoMarkNotificationAsRead {
    suspend fun execute(notificationId: String): Result<Unit>
}

interface ToDoMarkAllNotificationsAsRead {
    suspend fun execute(): Result<Unit>
}
