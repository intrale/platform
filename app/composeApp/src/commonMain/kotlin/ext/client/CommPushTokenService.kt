package ext.client

/**
 * Servicio para gestionar tokens de notificaciones push con el backend.
 */
interface CommPushTokenService {
    suspend fun registerToken(token: String, platform: String, appType: String): Result<Unit>
    suspend fun unregisterToken(token: String): Result<Unit>
}
