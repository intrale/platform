package ui.sc.client

import asdo.client.ClientNotification
import asdo.client.NotificationEventType
import asdo.client.ToDoGetNotifications
import asdo.client.ToDoMarkAllNotificationsRead
import asdo.client.ToDoMarkNotificationRead
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend

private val notifTestLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

private val sampleNotifications = listOf(
    ClientNotification(
        id = "notif-1",
        orderId = "order-1",
        shortCode = "ABC",
        businessName = "Panaderia",
        eventType = NotificationEventType.ORDER_CONFIRMED,
        message = "Tu pedido fue confirmado",
        timestamp = "2026-03-31T10:00:00Z",
        isRead = false
    ),
    ClientNotification(
        id = "notif-2",
        orderId = "order-1",
        shortCode = "ABC",
        businessName = "Panaderia",
        eventType = NotificationEventType.ORDER_READY,
        message = "Tu pedido esta listo",
        timestamp = "2026-03-31T11:00:00Z",
        isRead = true
    )
)

// --- Fakes ---

private class FakeGetNotificationsSuccess(
    private val notifications: List<ClientNotification> = sampleNotifications
) : ToDoGetNotifications {
    override suspend fun execute(): Result<List<ClientNotification>> =
        Result.success(notifications)
}

private class FakeGetNotificationsFailure(
    private val error: String = "Error de red"
) : ToDoGetNotifications {
    override suspend fun execute(): Result<List<ClientNotification>> =
        Result.failure(RuntimeException(error))
}

private class FakeMarkReadSuccess : ToDoMarkNotificationRead {
    override suspend fun execute(notificationId: String): Result<Unit> =
        Result.success(Unit)
}

private class FakeMarkReadFailure : ToDoMarkNotificationRead {
    override suspend fun execute(notificationId: String): Result<Unit> =
        Result.failure(RuntimeException("Error"))
}

private class FakeMarkAllReadSuccess : ToDoMarkAllNotificationsRead {
    override suspend fun execute(): Result<Unit> = Result.success(Unit)
}

private class FakeMarkAllReadFailure : ToDoMarkAllNotificationsRead {
    override suspend fun execute(): Result<Unit> = Result.failure(RuntimeException("Error"))
}

class ClientNotificationsViewModelTest {

    private fun createViewModel(
        getNotifications: ToDoGetNotifications = FakeGetNotificationsSuccess(),
        markRead: ToDoMarkNotificationRead = FakeMarkReadSuccess(),
        markAllRead: ToDoMarkAllNotificationsRead = FakeMarkAllReadSuccess()
    ): ClientNotificationsViewModel = ClientNotificationsViewModel(
        getNotifications = getNotifications,
        markRead = markRead,
        markAllRead = markAllRead,
        loggerFactory = notifTestLoggerFactory
    )

    @Test
    fun `estado inicial es Idle`() {
        val viewModel = createViewModel()

        assertEquals(NotificationsStatus.Idle, viewModel.state.status)
        assertTrue(viewModel.state.notifications.isEmpty())
        assertEquals(0, viewModel.state.unreadCount)
    }

    @Test
    fun `loadNotifications exitoso carga lista y cuenta no leidas`() = runTest {
        val viewModel = createViewModel()

        viewModel.loadNotifications()

        val state = viewModel.state
        assertEquals(NotificationsStatus.Loaded, state.status)
        assertEquals(2, state.notifications.size)
        assertEquals(1, state.unreadCount)
        assertNull(state.errorMessage)
    }

    @Test
    fun `loadNotifications con lista vacia muestra Empty`() = runTest {
        val viewModel = createViewModel(
            getNotifications = FakeGetNotificationsSuccess(emptyList())
        )

        viewModel.loadNotifications()

        assertEquals(NotificationsStatus.Empty, viewModel.state.status)
        assertEquals(0, viewModel.state.unreadCount)
    }

    @Test
    fun `loadNotifications con error muestra Empty y errorMessage`() = runTest {
        val viewModel = createViewModel(
            getNotifications = FakeGetNotificationsFailure("Sin conexion")
        )

        viewModel.loadNotifications()

        assertEquals(NotificationsStatus.Empty, viewModel.state.status)
        assertEquals("Sin conexion", viewModel.state.errorMessage)
    }

    @Test
    fun `markNotificationAsRead exitoso recarga notificaciones`() = runTest {
        val viewModel = createViewModel()
        viewModel.loadNotifications()

        viewModel.markNotificationAsRead("notif-1")

        // Deberia haber recargado
        assertEquals(NotificationsStatus.Loaded, viewModel.state.status)
    }

    @Test
    fun `markNotificationAsRead con error no cambia estado`() = runTest {
        val viewModel = createViewModel(
            markRead = FakeMarkReadFailure()
        )
        viewModel.loadNotifications()

        viewModel.markNotificationAsRead("notif-1")

        // El estado se mantiene loaded porque el error se logea pero no cambia estado
        assertEquals(NotificationsStatus.Loaded, viewModel.state.status)
    }

    @Test
    fun `markAllNotificationsAsRead exitoso recarga notificaciones`() = runTest {
        val viewModel = createViewModel()
        viewModel.loadNotifications()

        viewModel.markAllNotificationsAsRead()

        assertEquals(NotificationsStatus.Loaded, viewModel.state.status)
    }

    @Test
    fun `markAllNotificationsAsRead con error no cambia estado`() = runTest {
        val viewModel = createViewModel(
            markAllRead = FakeMarkAllReadFailure()
        )
        viewModel.loadNotifications()

        viewModel.markAllNotificationsAsRead()

        assertEquals(NotificationsStatus.Loaded, viewModel.state.status)
    }

    @Test
    fun `clearError limpia el mensaje de error`() = runTest {
        val viewModel = createViewModel(
            getNotifications = FakeGetNotificationsFailure("Error")
        )
        viewModel.loadNotifications()
        assertEquals("Error", viewModel.state.errorMessage)

        viewModel.clearError()

        assertNull(viewModel.state.errorMessage)
    }
}
