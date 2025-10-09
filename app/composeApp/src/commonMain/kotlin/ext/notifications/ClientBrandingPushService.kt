package ext.notifications

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

class ClientBrandingPushService {
    private val _events = MutableSharedFlow<String>(extraBufferCapacity = 1)
    val events: SharedFlow<String> = _events.asSharedFlow()

    suspend fun register(token: String): Result<Unit> {
        _events.tryEmit("registered:$token")
        return Result.success(Unit)
    }

    suspend fun unregister(token: String): Result<Unit> {
        _events.tryEmit("unregistered:$token")
        return Result.success(Unit)
    }

    suspend fun acknowledge(eventId: String): Result<Unit> = Result.success(Unit)

    fun notifyBrandingUpdate() {
        _events.tryEmit("branding-update")
    }
}
