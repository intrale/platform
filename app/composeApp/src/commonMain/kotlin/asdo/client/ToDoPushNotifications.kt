package asdo.client

/**
 * Registra el token push del dispositivo en el backend.
 */
interface ToDoRegisterPushToken {
    suspend fun execute(registration: PushTokenRegistration): Result<PushTokenResult>
}

/**
 * Desregistra el token push del dispositivo (logout, desactivar push).
 */
interface ToDoUnregisterPushToken {
    suspend fun execute(token: String): Result<Unit>
}

/**
 * Procesa una notificacion push entrante, filtrando por preferencias
 * y alimentando el store de notificaciones.
 */
interface ToDoPushNotificationHandler {
    suspend fun execute(notification: IncomingPushNotification): Result<Boolean>
}
