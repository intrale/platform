package asdo.client

import ext.client.CommNotificationsService
import ext.client.ClientExceptionResponse
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private val sampleNotifications = listOf(
    NotificationItem(
        id = "notif-1",
        type = NotificationType.ORDER_CREATED,
        title = "Pedido creado",
        message = "Tu pedido #SC001 fue creado correctamente",
        orderId = "ord-1",
        shortCode = "SC001",
        businessName = "La Parrilla",
        createdAt = "2026-03-20T10:00:00",
        isRead = false
    ),
    NotificationItem(
        id = "notif-2",
        type = NotificationType.STATUS_CHANGED,
        title = "Estado actualizado",
        message = "Tu pedido #SC001 esta en preparacion",
        orderId = "ord-1",
        shortCode = "SC001",
        businessName = "La Parrilla",
        createdAt = "2026-03-20T10:30:00",
        isRead = false
    )
)

private class FakeNotificationsService(
    private val getResult: Result<List<NotificationItem>> = Result.success(sampleNotifications),
    private val markResult: Result<Unit> = Result.success(Unit),
    private val markAllResult: Result<Unit> = Result.success(Unit)
) : CommNotificationsService {
    override suspend fun getNotifications(): Result<List<NotificationItem>> = getResult
    override suspend fun markAsRead(notificationId: String): Result<Unit> = markResult
    override suspend fun markAllAsRead(): Result<Unit> = markAllResult
}

// region DoGetNotifications

class DoGetNotificationsTest {

    @Test
    fun `obtener notificaciones exitoso retorna lista de notificaciones`() = runTest {
        val sut = DoGetNotifications(FakeNotificationsService())

        val result = sut.execute()

        assertTrue(result.isSuccess)
        val notifications = result.getOrThrow()
        assertEquals(2, notifications.size)
        assertEquals("notif-1", notifications[0].id)
        assertEquals(NotificationType.ORDER_CREATED, notifications[0].type)
        assertEquals("La Parrilla", notifications[0].businessName)
    }

    @Test
    fun `obtener notificaciones con lista vacia retorna lista vacia`() = runTest {
        val sut = DoGetNotifications(
            FakeNotificationsService(getResult = Result.success(emptyList()))
        )

        val result = sut.execute()

        assertTrue(result.isSuccess)
        assertTrue(result.getOrThrow().isEmpty())
    }

    @Test
    fun `obtener notificaciones fallido retorna ClientExceptionResponse`() = runTest {
        val sut = DoGetNotifications(
            FakeNotificationsService(getResult = Result.failure(RuntimeException("Error de red")))
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
    fun `marcar notificacion como leida exitoso retorna Result success`() = runTest {
        val sut = DoMarkNotificationRead(FakeNotificationsService())

        val result = sut.execute("notif-1")

        assertTrue(result.isSuccess)
    }

    @Test
    fun `marcar notificacion como leida fallido retorna ClientExceptionResponse`() = runTest {
        val sut = DoMarkNotificationRead(
            FakeNotificationsService(markResult = Result.failure(RuntimeException("Error")))
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
    fun `marcar todas como leidas exitoso retorna Result success`() = runTest {
        val sut = DoMarkAllNotificationsRead(FakeNotificationsService())

        val result = sut.execute()

        assertTrue(result.isSuccess)
    }

    @Test
    fun `marcar todas como leidas fallido retorna ClientExceptionResponse`() = runTest {
        val sut = DoMarkAllNotificationsRead(
            FakeNotificationsService(markAllResult = Result.failure(RuntimeException("Error")))
        )

        val result = sut.execute()

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is ClientExceptionResponse)
    }
}

// endregion
