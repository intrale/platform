package asdo.delivery

interface ToDoGetDeliveryNotifications {
    suspend fun execute(): Result<List<DeliveryNotification>>
}

interface ToDoMarkDeliveryNotificationRead {
    suspend fun execute(notificationId: String): Result<Unit>
}

interface ToDoMarkAllDeliveryNotificationsRead {
    suspend fun execute(): Result<Unit>
}
