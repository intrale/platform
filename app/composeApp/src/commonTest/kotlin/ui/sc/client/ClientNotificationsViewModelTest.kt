package ui.sc.client

import asdo.client.ClientNotification
import asdo.client.ClientOrder
import asdo.client.ClientOrderStatus
import asdo.client.NotificationEventType
import asdo.client.ToDoGetNotifications
import asdo.client.ToDoMarkAllNotificationsRead
import asdo.client.ToDoMarkNotificationRead
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val testLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

private val sampleNotifications = listOf(
    ClientNotification(
        id = "ord-1_PENDING",
        orderId = "ord-1",
        shortCode = "SC01",
        businessName = "Tienda",
        eventType = NotificationEventType.ORDER_CREATED,
        message = "",
        timestamp = "2025-01-02",
        isRead = false
    ),
    ClientNotification(
        id = "ord-2_DELIVERED",
        orderId = "ord-2",
        shortCode = "SC02",
        businessName = "Farmacia",
        eventType = NotificationEventType.ORDER_DELIVERED,
        message = "",
        timestamp = "2025-01-01",
        isRead = true
    )
)

private class FakeGetNotifications(
    private val result: Result<List<ClientNotification>> = Result.success(sampleNotifications)
) : ToDoGetNotifications {
    override suspend fun execute(): Result<List<ClientNotification>> = result
}

private class FakeMarkNotificationRead(
    private val result: Result<Unit> = Result.success(Unit)
) : ToDoMarkNotificationRead {
    var lastMarkedId: String? = null
    override suspend fun execute(notificationId: String): Result<Unit> {
        lastMarkedId = notificationId
        return result
    }
}

private class FakeMarkAllNotificationsRead(
    private val result: Result<Unit> = Result.success(Unit)
) : ToDoMarkAllNotificationsRead {
    var called = false
    override suspend fun execute(): Result<Unit> {
        called = true
        return result
    }
}

class ClientNotificationsViewModelTest {

    @BeforeTest
    fun setup() {
        ClientNotificationStore.clear()
    }

    @Test
    fun `estado inicial es Idle con lista vacia`() {
        val viewModel = ClientNotificationsViewModel(
            getNotifications = FakeGetNotifications(Result.success(emptyList())),
            markRead = FakeMarkNotificationRead(),
            markAllRead = FakeMarkAllNotificationsRead(),
            loggerFactory = testLoggerFactory
        )

        assertEquals(NotificationsStatus.Idle, viewModel.state.status)
        assertTrue(viewModel.state.notifications.isEmpty())
        assertEquals(0, viewModel.state.unreadCount)
        assertNull(viewModel.state.errorMessage)
    }

    @Test
    fun `loadNotifications con lista vacia muestra Empty`() = runTest {
        val viewModel = ClientNotificationsViewModel(
            getNotifications = FakeGetNotifications(Result.success(emptyList())),
            markRead = FakeMarkNotificationRead(),
            markAllRead = FakeMarkAllNotificationsRead(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadNotifications()

        assertEquals(NotificationsStatus.Empty, viewModel.state.status)
        assertTrue(viewModel.state.notifications.isEmpty())
        assertEquals(0, viewModel.state.unreadCount)
    }

    @Test
    fun `loadNotifications exitoso muestra lista con contador de no leidas`() = runTest {
        val viewModel = ClientNotificationsViewModel(
            getNotifications = FakeGetNotifications(Result.success(sampleNotifications)),
            markRead = FakeMarkNotificationRead(),
            markAllRead = FakeMarkAllNotificationsRead(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadNotifications()

        assertEquals(NotificationsStatus.Loaded, viewModel.state.status)
        assertEquals(2, viewModel.state.notifications.size)
        assertEquals(1, viewModel.state.unreadCount)
    }

    @Test
    fun `loadNotifications con error muestra Empty con mensaje`() = runTest {
        val viewModel = ClientNotificationsViewModel(
            getNotifications = FakeGetNotifications(Result.failure(RuntimeException("Sin conexion"))),
            markRead = FakeMarkNotificationRead(),
            markAllRead = FakeMarkAllNotificationsRead(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadNotifications()

        assertEquals(NotificationsStatus.Empty, viewModel.state.status)
        assertEquals("Sin conexion", viewModel.state.errorMessage)
    }

    @Test
    fun `markNotificationAsRead llama al caso de uso y recarga`() = runTest {
        val orders = listOf(
            ClientOrder(
                id = "ord-1", publicId = "PUB-001", shortCode = "SC01",
                businessName = "Tienda", status = ClientOrderStatus.PENDING,
                createdAt = "2025-01-01", promisedAt = null, total = 100.0, itemCount = 1
            )
        )
        ClientNotificationStore.updateFromOrders(orders)
        val fakeMarkRead = FakeMarkNotificationRead()

        val viewModel = ClientNotificationsViewModel(
            getNotifications = FakeGetNotifications(
                Result.success(ClientNotificationStore.notifications.value)
            ),
            markRead = fakeMarkRead,
            markAllRead = FakeMarkAllNotificationsRead(),
            loggerFactory = testLoggerFactory
        )

        viewModel.markNotificationAsRead("ord-1_PENDING")

        assertEquals("ord-1_PENDING", fakeMarkRead.lastMarkedId)
    }

    @Test
    fun `markAllNotificationsAsRead llama al caso de uso`() = runTest {
        val fakeMarkAll = FakeMarkAllNotificationsRead()

        val viewModel = ClientNotificationsViewModel(
            getNotifications = FakeGetNotifications(Result.success(sampleNotifications)),
            markRead = FakeMarkNotificationRead(),
            markAllRead = fakeMarkAll,
            loggerFactory = testLoggerFactory
        )

        viewModel.markAllNotificationsAsRead()

        assertTrue(fakeMarkAll.called)
    }

    @Test
    fun `clearError limpia el mensaje de error`() = runTest {
        val viewModel = ClientNotificationsViewModel(
            getNotifications = FakeGetNotifications(Result.failure(RuntimeException("Error"))),
            markRead = FakeMarkNotificationRead(),
            markAllRead = FakeMarkAllNotificationsRead(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadNotifications()
        assertEquals("Error", viewModel.state.errorMessage)

        viewModel.clearError()

        assertNull(viewModel.state.errorMessage)
    }

    @Test
    fun `unreadCount refleja correctamente notificaciones no leidas`() = runTest {
        val allUnread = listOf(
            ClientNotification(
                id = "n1", orderId = "ord-1", shortCode = "SC01",
                businessName = "Tienda", eventType = NotificationEventType.ORDER_CREATED,
                message = "", timestamp = "2025-01-01", isRead = false
            ),
            ClientNotification(
                id = "n2", orderId = "ord-2", shortCode = "SC02",
                businessName = "Farmacia", eventType = NotificationEventType.ORDER_CONFIRMED,
                message = "", timestamp = "2025-01-02", isRead = false
            ),
            ClientNotification(
                id = "n3", orderId = "ord-3", shortCode = "SC03",
                businessName = "Libreria", eventType = NotificationEventType.ORDER_DELIVERED,
                message = "", timestamp = "2025-01-03", isRead = true
            )
        )

        val viewModel = ClientNotificationsViewModel(
            getNotifications = FakeGetNotifications(Result.success(allUnread)),
            markRead = FakeMarkNotificationRead(),
            markAllRead = FakeMarkAllNotificationsRead(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadNotifications()

        assertEquals(NotificationsStatus.Loaded, viewModel.state.status)
        assertEquals(3, viewModel.state.notifications.size)
        assertEquals(2, viewModel.state.unreadCount)
    }
}
