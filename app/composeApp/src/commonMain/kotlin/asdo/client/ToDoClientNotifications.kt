package asdo.client

interface ToDoGetNotifications {
    suspend fun execute(): Result<List<ClientNotification>>
}

interface ToDoMarkNotificationRead {
    suspend fun execute(notificationId: String): Result<Unit>
}

interface ToDoMarkAllNotificationsRead {
    suspend fun execute(): Result<Unit>
}

interface ToDoGetPushPreferences {
    suspend fun execute(): Result<ClientPreferences>
}

interface ToDoUpdatePushPreferences {
    suspend fun execute(preferences: ClientPreferences): Result<ClientPreferences>
}
