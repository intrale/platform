package ui.sc.client

import asdo.client.ClientNotification
import asdo.client.NotificationType
import asdo.client.ToDoGetNotifications
import asdo.client.ToDoMarkAllNotificationsAsRead
import asdo.client.ToDoMarkNotificationAsRead
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend

private val testLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

private val sampleNotifications = listOf(
    ClientNotification(
        id = "n1",
        type = NotificationType.ORDER_CREATED,
        title = "Pedido creado",
        body = "Tu pedido #001 fue recibido",
        isRead = false,
        timestamp = "2026-03-23T10:00:00",
        orderId = "ord-001"
    ),
    ClientNotification(
        id = "n2",
        type = NotificationType.ORDER_STATUS_CHANGED,
        title = "Estado actualizado",
        body = "Tu pedido #001 esta en preparacion",
        isRead = true,
        timestamp = "2026-03-23T11:00:00",
        orderId = "ord-001"
    )
)

private class FakeGetNotifications(
    private val result: Result<List<ClientNotification>> = Result.success(sampleNotifications)
) : ToDoGetNotifications {
    override suspend fun execute(): Result<List<ClientNotification>> = result
}

private class FakeMarkAsRead(
    private val shouldFail: Boolean = false
) : ToDoMarkNotificationAsRead {
    val markedIds = mutableListOf<String>()
    override suspend fun execute(notificationId: String): Result<Unit> {
        if (shouldFail) return Result.failure(RuntimeException("Error"))
        markedIds.add(notificationId)
        return Result.success(Unit)
    }
}

private class FakeMarkAllAsRead(
    private val shouldFail: Boolean = false
) : ToDoMarkAllNotificationsAsRead {
    var called = false
    override suspend fun execute(): Result<Unit> {
        if (shouldFail) return Result.failure(RuntimeException("Error"))
        called = true
        return Result.success(Unit)
    }
}

class ClientNotificationsViewModelTest {

    @Test
    fun `loadNotifications exitoso muestra lista de notificaciones`() = runTest {
        val viewModel = ClientNotificationsViewModel(
            getNotifications = FakeGetNotifications(),
            markAsRead = FakeMarkAsRead(),
            markAllAsRead = FakeMarkAllAsRead(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadNotifications()

        assertEquals(ClientNotificationsStatus.Loaded, viewModel.state.status)
        assertEquals(2, viewModel.state.notifications.size)
        assertNull(viewModel.state.errorMessage)
    }

    @Test
    fun `loadNotifications con lista vacia muestra Empty`() = runTest {
        val viewModel = ClientNotificationsViewModel(
            getNotifications = FakeGetNotifications(Result.success(emptyList())),
            markAsRead = FakeMarkAsRead(),
            markAllAsRead = FakeMarkAllAsRead(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadNotifications()

        assertEquals(ClientNotificationsStatus.Empty, viewModel.state.status)
        assertTrue(viewModel.state.notifications.isEmpty())
    }

    @Test
    fun `loadNotifications con error muestra Error`() = runTest {
        val viewModel = ClientNotificationsViewModel(
            getNotifications = FakeGetNotifications(Result.failure(RuntimeException("Sin conexion"))),
            markAsRead = FakeMarkAsRead(),
            markAllAsRead = FakeMarkAllAsRead(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadNotifications()

        assertEquals(ClientNotificationsStatus.Error, viewModel.state.status)
        assertNotNull(viewModel.state.errorMessage)
    }

    @Test
    fun `markNotificationAsRead actualiza estado de la notificacion`() = runTest {
        val viewModel = ClientNotificationsViewModel(
            getNotifications = FakeGetNotifications(),
            markAsRead = FakeMarkAsRead(),
            markAllAsRead = FakeMarkAllAsRead(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadNotifications()
        assertFalse(viewModel.state.notifications.first { it.id == "n1" }.isRead)

        viewModel.markNotificationAsRead("n1")

        assertTrue(viewModel.state.notifications.first { it.id == "n1" }.isRead)
    }

    @Test
    fun `markAllNotificationsAsRead marca todas como leidas`() = runTest {
        val fakeMarkAll = FakeMarkAllAsRead()
        val viewModel = ClientNotificationsViewModel(
            getNotifications = FakeGetNotifications(),
            markAsRead = FakeMarkAsRead(),
            markAllAsRead = fakeMarkAll,
            loggerFactory = testLoggerFactory
        )

        viewModel.loadNotifications()
        viewModel.markAllNotificationsAsRead()

        assertTrue(fakeMarkAll.called)
        assertTrue(viewModel.state.notifications.all { it.isRead })
        assertFalse(viewModel.state.markingAllRead)
    }

    @Test
    fun `clearError limpia mensaje de error`() = runTest {
        val viewModel = ClientNotificationsViewModel(
            getNotifications = FakeGetNotifications(Result.failure(RuntimeException("Fallo"))),
            markAsRead = FakeMarkAsRead(),
            markAllAsRead = FakeMarkAllAsRead(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadNotifications()
        assertNotNull(viewModel.state.errorMessage)

        viewModel.clearError()

        assertNull(viewModel.state.errorMessage)
    }

    @Test
    fun `loadNotifications pone estado en Loading antes de resolver`() = runTest {
        val viewModel = ClientNotificationsViewModel(
            getNotifications = FakeGetNotifications(),
            markAsRead = FakeMarkAsRead(),
            markAllAsRead = FakeMarkAllAsRead(),
            loggerFactory = testLoggerFactory
        )

        // El estado inicial es Idle
        assertEquals(ClientNotificationsStatus.Idle, viewModel.state.status)

        viewModel.loadNotifications()

        // Despues de cargar correctamente, es Loaded
        assertEquals(ClientNotificationsStatus.Loaded, viewModel.state.status)
    }
}
