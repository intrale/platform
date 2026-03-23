package asdo.client

import ext.client.CommNotificationService
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

private val sampleNotification = ClientNotification(
    id = "notif-1",
    type = NotificationType.ORDER_CREATED,
    title = "Pedido creado",
    body = "Tu pedido #123 fue recibido",
    isRead = false,
    timestamp = "2026-03-23T10:00:00"
)

private class FakeNotificationService(
    private val notifications: List<ClientNotification> = listOf(sampleNotification),
    private val shouldFail: Boolean = false
) : CommNotificationService {
    val markedReadIds = mutableListOf<String>()
    var markedAllRead = false

    override suspend fun listNotifications(): Result<List<ClientNotification>> =
        if (shouldFail) Result.failure(RuntimeException("Error de red"))
        else Result.success(notifications)

    override suspend fun markAsRead(notificationId: String): Result<Unit> {
        if (shouldFail) return Result.failure(RuntimeException("Error"))
        markedReadIds.add(notificationId)
        return Result.success(Unit)
    }

    override suspend fun markAllAsRead(): Result<Unit> {
        if (shouldFail) return Result.failure(RuntimeException("Error"))
        markedAllRead = true
        return Result.success(Unit)
    }

    override suspend fun addNotification(notification: ClientNotification): Result<Unit> {
        if (shouldFail) return Result.failure(RuntimeException("Error"))
        return Result.success(Unit)
    }
}

class DoGetNotificationsTest {

    @Test
    fun `execute devuelve lista de notificaciones exitosamente`() = runTest {
        val service = FakeNotificationService()
        val action = DoGetNotifications(service)

        val result = action.execute()

        assertTrue(result.isSuccess)
        assertEquals(1, result.getOrThrow().size)
        assertEquals("notif-1", result.getOrThrow().first().id)
    }

    @Test
    fun `execute devuelve lista vacia cuando no hay notificaciones`() = runTest {
        val service = FakeNotificationService(notifications = emptyList())
        val action = DoGetNotifications(service)

        val result = action.execute()

        assertTrue(result.isSuccess)
        assertTrue(result.getOrThrow().isEmpty())
    }

    @Test
    fun `execute propaga error del servicio`() = runTest {
        val service = FakeNotificationService(shouldFail = true)
        val action = DoGetNotifications(service)

        val result = action.execute()

        assertTrue(result.isFailure)
    }
}

class DoMarkNotificationAsReadTest {

    @Test
    fun `execute marca notificacion como leida correctamente`() = runTest {
        val service = FakeNotificationService()
        val action = DoMarkNotificationAsRead(service)

        val result = action.execute("notif-1")

        assertTrue(result.isSuccess)
        assertTrue(service.markedReadIds.contains("notif-1"))
    }

    @Test
    fun `execute propaga error del servicio`() = runTest {
        val service = FakeNotificationService(shouldFail = true)
        val action = DoMarkNotificationAsRead(service)

        val result = action.execute("notif-1")

        assertTrue(result.isFailure)
    }
}

class DoMarkAllNotificationsAsReadTest {

    @Test
    fun `execute marca todas las notificaciones como leidas`() = runTest {
        val service = FakeNotificationService()
        val action = DoMarkAllNotificationsAsRead(service)

        val result = action.execute()

        assertTrue(result.isSuccess)
        assertTrue(service.markedAllRead)
    }

    @Test
    fun `execute propaga error del servicio`() = runTest {
        val service = FakeNotificationService(shouldFail = true)
        val action = DoMarkAllNotificationsAsRead(service)

        val result = action.execute()

        assertTrue(result.isFailure)
    }
}
