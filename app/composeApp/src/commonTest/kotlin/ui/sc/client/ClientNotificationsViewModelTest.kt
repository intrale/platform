package ui.sc.client

import asdo.client.ClientNotification
import asdo.client.NotificationType
import asdo.client.ToDoGetClientNotifications
import asdo.client.ToDoMarkAllNotificationsRead
import asdo.client.ToDoMarkNotificationRead
import ext.client.ClientExceptionResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

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

private class FakeGetNotifications(
    private val result: Result<List<ClientNotification>> = Result.success(sampleNotifications)
) : ToDoGetClientNotifications {
    override suspend fun execute(): Result<List<ClientNotification>> = result
}

private class FakeMarkNotificationRead(
    private val result: Result<Unit> = Result.success(Unit)
) : ToDoMarkNotificationRead {
    override suspend fun execute(notificationId: String): Result<Unit> = result
}

private class FakeMarkAllNotificationsRead(
    private val result: Result<Unit> = Result.success(Unit)
) : ToDoMarkAllNotificationsRead {
    override suspend fun execute(): Result<Unit> = result
}

class ClientNotificationsViewModelTest {

    @Test
    fun `loadNotifications exitoso muestra lista de notificaciones`() = runTest {
        val viewModel = ClientNotificationsViewModel(
            toDoGetClientNotifications = FakeGetNotifications(),
            toDoMarkNotificationRead = FakeMarkNotificationRead(),
            toDoMarkAllNotificationsRead = FakeMarkAllNotificationsRead()
        )

        viewModel.loadNotifications()

        assertEquals(ClientNotificationsStatus.Loaded, viewModel.state.status)
        assertEquals(2, viewModel.state.notifications.size)
        assertEquals(1, viewModel.state.unreadCount)
        assertNull(viewModel.state.errorMessage)
    }

    @Test
    fun `loadNotifications con lista vacia muestra estado Empty`() = runTest {
        val viewModel = ClientNotificationsViewModel(
            toDoGetClientNotifications = FakeGetNotifications(Result.success(emptyList())),
            toDoMarkNotificationRead = FakeMarkNotificationRead(),
            toDoMarkAllNotificationsRead = FakeMarkAllNotificationsRead()
        )

        viewModel.loadNotifications()

        assertEquals(ClientNotificationsStatus.Empty, viewModel.state.status)
        assertTrue(viewModel.state.notifications.isEmpty())
        assertEquals(0, viewModel.state.unreadCount)
    }

    @Test
    fun `loadNotifications fallido muestra estado Error`() = runTest {
        val viewModel = ClientNotificationsViewModel(
            toDoGetClientNotifications = FakeGetNotifications(
                Result.failure(ClientExceptionResponse(message = "Error de red"))
            ),
            toDoMarkNotificationRead = FakeMarkNotificationRead(),
            toDoMarkAllNotificationsRead = FakeMarkAllNotificationsRead()
        )

        viewModel.loadNotifications()

        assertEquals(ClientNotificationsStatus.Error, viewModel.state.status)
        assertNotNull(viewModel.state.errorMessage)
    }

    @Test
    fun `markNotificationAsRead actualiza notificacion a leida`() = runTest {
        val viewModel = ClientNotificationsViewModel(
            toDoGetClientNotifications = FakeGetNotifications(),
            toDoMarkNotificationRead = FakeMarkNotificationRead(),
            toDoMarkAllNotificationsRead = FakeMarkAllNotificationsRead()
        )
        viewModel.loadNotifications()

        viewModel.markNotificationAsRead("notif-1")

        val updated = viewModel.state.notifications.find { it.id == "notif-1" }
        assertNotNull(updated)
        assertTrue(updated.isRead)
        assertEquals(0, viewModel.state.unreadCount)
    }

    @Test
    fun `markAllNotificationsAsRead marca todas como leidas`() = runTest {
        val viewModel = ClientNotificationsViewModel(
            toDoGetClientNotifications = FakeGetNotifications(),
            toDoMarkNotificationRead = FakeMarkNotificationRead(),
            toDoMarkAllNotificationsRead = FakeMarkAllNotificationsRead()
        )
        viewModel.loadNotifications()

        viewModel.markAllNotificationsAsRead()

        assertTrue(viewModel.state.notifications.all { it.isRead })
        assertEquals(0, viewModel.state.unreadCount)
    }
}
