package asdo.client

import ext.client.ClientExceptionResponse
import ext.client.CommClientNotificationsService
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private val sampleNotifications = listOf(
    ClientNotification(
        id = "notif-1",
        type = NotificationType.ORDER_CREATED,
        title = "Pedido creado",
        message = "Tu pedido #001 fue registrado.",
        isRead = false,
        createdAt = "2025-01-01T10:00:00Z",
        orderId = "ord-1"
    ),
    ClientNotification(
        id = "notif-2",
        type = NotificationType.ORDER_STATUS_CHANGED,
        title = "Estado actualizado",
        message = "Tu pedido #001 esta en preparacion.",
        isRead = true,
        createdAt = "2025-01-01T11:00:00Z",
        orderId = "ord-1"
    )
)

private class FakeCommNotificationsService(
    private val listResult: Result<List<ClientNotification>> = Result.success(sampleNotifications),
    private val markReadResult: Result<Unit> = Result.success(Unit),
    private val markAllReadResult: Result<Unit> = Result.success(Unit)
) : CommClientNotificationsService {
    override suspend fun listNotifications(): Result<List<ClientNotification>> = listResult
    override suspend fun markAsRead(notificationId: String): Result<Unit> = markReadResult
    override suspend fun markAllAsRead(): Result<Unit> = markAllReadResult
}

// region DoGetClientNotifications

class DoGetClientNotificationsTest {

    @Test
    fun `obtener notificaciones exitoso retorna lista de notificaciones`() = runTest {
        val sut = DoGetClientNotifications(FakeCommNotificationsService())

        val result = sut.execute()

        assertTrue(result.isSuccess)
        val notifications = result.getOrThrow()
        assertEquals(2, notifications.size)
        assertEquals("notif-1", notifications[0].id)
        assertEquals(NotificationType.ORDER_CREATED, notifications[0].type)
        assertEquals(false, notifications[0].isRead)
    }

    @Test
    fun `obtener notificaciones con lista vacia retorna lista vacia`() = runTest {
        val sut = DoGetClientNotifications(
            FakeCommNotificationsService(listResult = Result.success(emptyList()))
        )

        val result = sut.execute()

        assertTrue(result.isSuccess)
        assertTrue(result.getOrThrow().isEmpty())
    }

    @Test
    fun `obtener notificaciones fallido retorna ClientExceptionResponse`() = runTest {
        val sut = DoGetClientNotifications(
            FakeCommNotificationsService(listResult = Result.failure(RuntimeException("Error de red")))
        )

        val result = sut.execute()

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is ClientExceptionResponse)
    }
}

// endregion

// region DoMarkNotificationRead

class DoMarkNotificationReadTest {

    @Test
    fun `marcar notificacion como leida exitoso retorna Unit`() = runTest {
        val sut = DoMarkNotificationRead(FakeCommNotificationsService())

        val result = sut.execute("notif-1")

        assertTrue(result.isSuccess)
    }

    @Test
    fun `marcar notificacion como leida fallido retorna ClientExceptionResponse`() = runTest {
        val sut = DoMarkNotificationRead(
            FakeCommNotificationsService(markReadResult = Result.failure(RuntimeException("Error")))
        )

        val result = sut.execute("notif-1")

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is ClientExceptionResponse)
    }
}

// endregion

// region DoMarkAllNotificationsRead

class DoMarkAllNotificationsReadTest {

    @Test
    fun `marcar todas las notificaciones como leidas exitoso retorna Unit`() = runTest {
        val sut = DoMarkAllNotificationsRead(FakeCommNotificationsService())

        val result = sut.execute()

        assertTrue(result.isSuccess)
    }

    @Test
    fun `marcar todas fallido retorna ClientExceptionResponse`() = runTest {
        val sut = DoMarkAllNotificationsRead(
            FakeCommNotificationsService(markAllReadResult = Result.failure(RuntimeException("Error")))
        )

        val result = sut.execute()

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is ClientExceptionResponse)
    }
}

// endregion
