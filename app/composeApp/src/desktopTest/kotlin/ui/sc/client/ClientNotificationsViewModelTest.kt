package ui.sc.client

import asdo.client.ClientNotification
import asdo.client.ClientPreferences
import asdo.client.NotificationEventType
import asdo.client.ToDoGetNotifications
import asdo.client.ToDoMarkAllNotificationsRead
import asdo.client.ToDoMarkNotificationRead
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ClientNotificationsViewModelTest {

    private val testLoggerFactory = LoggerFactory(simplePrintFrontend)

    private fun sampleNotifications() = listOf(
        ClientNotification(
            id = "order1_CONFIRMED",
            orderId = "order1",
            shortCode = "001",
            businessName = "La Esquina",
            eventType = NotificationEventType.ORDER_CONFIRMED,
            message = "",
            timestamp = "2026-03-25T10:00:00",
            isRead = false
        ),
        ClientNotification(
            id = "order2_DELIVERING",
            orderId = "order2",
            shortCode = "002",
            businessName = "Panaderia",
            eventType = NotificationEventType.ORDER_DELIVERING,
            message = "",
            timestamp = "2026-03-25T09:30:00",
            isRead = true
        )
    )

    @Test
    fun `loadNotifications actualiza estado con notificaciones del store`() = runTest {
        val notifications = sampleNotifications()
        val vm = ClientNotificationsViewModel(
            getNotifications = FakeGetNotifications(Result.success(notifications)),
            markRead = FakeMarkNotificationRead(Result.success(Unit)),
            markAllRead = FakeMarkAllNotificationsRead(Result.success(Unit)),
            loggerFactory = testLoggerFactory
        )

        vm.loadNotifications()

        assertEquals(NotificationsStatus.Loaded, vm.state.status)
        assertEquals(2, vm.state.notifications.size)
        assertEquals(1, vm.state.unreadCount)
    }

    @Test
    fun `loadNotifications con lista vacia muestra estado Empty`() = runTest {
        val vm = ClientNotificationsViewModel(
            getNotifications = FakeGetNotifications(Result.success(emptyList())),
            markRead = FakeMarkNotificationRead(Result.success(Unit)),
            markAllRead = FakeMarkAllNotificationsRead(Result.success(Unit)),
            loggerFactory = testLoggerFactory
        )

        vm.loadNotifications()

        assertEquals(NotificationsStatus.Empty, vm.state.status)
        assertTrue(vm.state.notifications.isEmpty())
        assertEquals(0, vm.state.unreadCount)
    }

    @Test
    fun `loadNotifications con error muestra estado Empty con mensaje`() = runTest {
        val vm = ClientNotificationsViewModel(
            getNotifications = FakeGetNotifications(Result.failure(RuntimeException("Error de red"))),
            markRead = FakeMarkNotificationRead(Result.success(Unit)),
            markAllRead = FakeMarkAllNotificationsRead(Result.success(Unit)),
            loggerFactory = testLoggerFactory
        )

        vm.loadNotifications()

        assertEquals(NotificationsStatus.Empty, vm.state.status)
        assertEquals("Error de red", vm.state.errorMessage)
    }

    @Test
    fun `markNotificationAsRead recarga notificaciones`() = runTest {
        val notifications = sampleNotifications()
        var callCount = 0
        val vm = ClientNotificationsViewModel(
            getNotifications = object : ToDoGetNotifications {
                override suspend fun execute(): Result<List<ClientNotification>> {
                    callCount++
                    return Result.success(notifications)
                }
            },
            markRead = FakeMarkNotificationRead(Result.success(Unit)),
            markAllRead = FakeMarkAllNotificationsRead(Result.success(Unit)),
            loggerFactory = testLoggerFactory
        )

        vm.loadNotifications()
        vm.markNotificationAsRead("order1_CONFIRMED")

        assertEquals(2, callCount)
    }

    @Test
    fun `markAllNotificationsAsRead recarga notificaciones`() = runTest {
        val notifications = sampleNotifications()
        var callCount = 0
        val vm = ClientNotificationsViewModel(
            getNotifications = object : ToDoGetNotifications {
                override suspend fun execute(): Result<List<ClientNotification>> {
                    callCount++
                    return Result.success(notifications)
                }
            },
            markRead = FakeMarkNotificationRead(Result.success(Unit)),
            markAllRead = FakeMarkAllNotificationsRead(Result.success(Unit)),
            loggerFactory = testLoggerFactory
        )

        vm.loadNotifications()
        vm.markAllNotificationsAsRead()

        assertEquals(2, callCount)
    }

    @Test
    fun `markNotificationAsRead con error no recarga notificaciones`() = runTest {
        val notifications = sampleNotifications()
        var loadCount = 0
        val vm = ClientNotificationsViewModel(
            getNotifications = object : ToDoGetNotifications {
                override suspend fun execute(): Result<List<ClientNotification>> {
                    loadCount++
                    return Result.success(notifications)
                }
            },
            markRead = FakeMarkNotificationRead(Result.failure(RuntimeException("Error"))),
            markAllRead = FakeMarkAllNotificationsRead(Result.success(Unit)),
            loggerFactory = testLoggerFactory
        )

        vm.loadNotifications()
        vm.markNotificationAsRead("order1_CONFIRMED")

        assertEquals(1, loadCount)
    }

    @Test
    fun `markAllNotificationsAsRead con error no recarga notificaciones`() = runTest {
        val notifications = sampleNotifications()
        var loadCount = 0
        val vm = ClientNotificationsViewModel(
            getNotifications = object : ToDoGetNotifications {
                override suspend fun execute(): Result<List<ClientNotification>> {
                    loadCount++
                    return Result.success(notifications)
                }
            },
            markRead = FakeMarkNotificationRead(Result.success(Unit)),
            markAllRead = FakeMarkAllNotificationsRead(Result.failure(RuntimeException("Error"))),
            loggerFactory = testLoggerFactory
        )

        vm.loadNotifications()
        vm.markAllNotificationsAsRead()

        assertEquals(1, loadCount)
    }

    @Test
    fun `clearError limpia el mensaje de error`() = runTest {
        val vm = ClientNotificationsViewModel(
            getNotifications = FakeGetNotifications(Result.failure(RuntimeException("Error"))),
            markRead = FakeMarkNotificationRead(Result.success(Unit)),
            markAllRead = FakeMarkAllNotificationsRead(Result.success(Unit)),
            loggerFactory = testLoggerFactory
        )

        vm.loadNotifications()
        assertEquals("Error", vm.state.errorMessage)

        vm.clearError()
        assertNull(vm.state.errorMessage)
    }
}

class ClientNotificationStoreTest {

    @Test
    fun `updateFromOrders genera notificaciones por estado de pedido`() {
        ClientNotificationStore.clear()
        val orders = listOf(
            asdo.client.ClientOrder(
                id = "ord-1", publicId = "PUB-001", shortCode = "001",
                businessName = "La Esquina", status = asdo.client.ClientOrderStatus.CONFIRMED,
                createdAt = "2026-03-25T10:00:00", promisedAt = null, total = 100.0, itemCount = 2
            ),
            asdo.client.ClientOrder(
                id = "ord-2", publicId = "PUB-002", shortCode = "002",
                businessName = "Panaderia", status = asdo.client.ClientOrderStatus.DELIVERING,
                createdAt = "2026-03-25T09:30:00", promisedAt = null, total = 50.0, itemCount = 1
            )
        )

        ClientNotificationStore.updateFromOrders(orders)

        assertEquals(2, ClientNotificationStore.notifications.value.size)
        assertEquals(2, ClientNotificationStore.unreadCount)
    }

    @Test
    fun `addBusinessMessage agrega notificacion de mensaje`() {
        ClientNotificationStore.clear()

        ClientNotificationStore.addBusinessMessage(
            orderId = "ord-1",
            shortCode = "001",
            businessName = "La Esquina",
            message = "Tu pedido esta listo!",
            timestamp = "2026-03-25T11:00:00"
        )

        val notifs = ClientNotificationStore.notifications.value
        assertEquals(1, notifs.size)
        assertEquals(NotificationEventType.BUSINESS_MESSAGE, notifs.first().eventType)
    }

    @Test
    fun `clear elimina todas las notificaciones`() {
        ClientNotificationStore.addBusinessMessage(
            "ord-1", "001", "Test", "msg", "2026-01-01"
        )

        ClientNotificationStore.clear()

        assertTrue(ClientNotificationStore.notifications.value.isEmpty())
        assertEquals(0, ClientNotificationStore.unreadCount)
    }
}

private class FakeGetNotifications(
    private val result: Result<List<ClientNotification>>
) : ToDoGetNotifications {
    override suspend fun execute(): Result<List<ClientNotification>> = result
}

private class FakeMarkNotificationRead(
    private val result: Result<Unit>
) : ToDoMarkNotificationRead {
    override suspend fun execute(notificationId: String): Result<Unit> = result
}

private class FakeMarkAllNotificationsRead(
    private val result: Result<Unit>
) : ToDoMarkAllNotificationsRead {
    override suspend fun execute(): Result<Unit> = result
}
