package ui.sc.delivery

import asdo.delivery.DeliveryNotification
import asdo.delivery.DeliveryNotificationEventType
import asdo.delivery.DeliveryOrder
import asdo.delivery.DeliveryOrderStatus
import asdo.delivery.ToDoGetDeliveryNotifications
import asdo.delivery.ToDoMarkAllDeliveryNotificationsRead
import asdo.delivery.ToDoMarkDeliveryNotificationRead
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend
import ui.session.SessionStore
import ui.session.UserRole
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DeliveryNotificationsViewModelTest {

    private val testLoggerFactory = LoggerFactory(simplePrintFrontend)

    @BeforeTest
    fun setUp() {
        SessionStore.clear()
        SessionStore.updateRole(UserRole.Delivery)
    }

    private fun sampleNotifications() = listOf(
        DeliveryNotification(
            id = "order1_PENDING",
            orderId = "order1",
            label = "BCDF23",
            businessName = "La Esquina de Pepe",
            eventType = DeliveryNotificationEventType.ORDER_AVAILABLE,
            timestamp = "2026-03-25T10:00:00",
            isRead = false
        ),
        DeliveryNotification(
            id = "order2_IN_PROGRESS",
            orderId = "order2",
            label = "KLMN78",
            businessName = "Panaderia Los Arcos",
            eventType = DeliveryNotificationEventType.ORDER_ASSIGNED,
            timestamp = "2026-03-25T09:30:00",
            isRead = true
        )
    )

    @Test
    fun `loadNotifications actualiza estado con notificaciones del store`() = runTest {
        val notifications = sampleNotifications()
        val vm = DeliveryNotificationsViewModel(
            getNotifications = FakeGetDeliveryNotifications(Result.success(notifications)),
            markRead = FakeMarkDeliveryNotificationRead(Result.success(Unit)),
            markAllRead = FakeMarkAllDeliveryNotificationsRead(Result.success(Unit)),
            loggerFactory = testLoggerFactory
        )

        vm.loadNotifications()

        assertEquals(DeliveryNotificationsStatus.Loaded, vm.state.status)
        assertEquals(2, vm.state.notifications.size)
        assertEquals(1, vm.state.unreadCount)
    }

    @Test
    fun `loadNotifications con lista vacia muestra estado Empty`() = runTest {
        val vm = DeliveryNotificationsViewModel(
            getNotifications = FakeGetDeliveryNotifications(Result.success(emptyList())),
            markRead = FakeMarkDeliveryNotificationRead(Result.success(Unit)),
            markAllRead = FakeMarkAllDeliveryNotificationsRead(Result.success(Unit)),
            loggerFactory = testLoggerFactory
        )

        vm.loadNotifications()

        assertEquals(DeliveryNotificationsStatus.Empty, vm.state.status)
        assertTrue(vm.state.notifications.isEmpty())
        assertEquals(0, vm.state.unreadCount)
    }

    @Test
    fun `loadNotifications con error muestra estado Empty con mensaje`() = runTest {
        val vm = DeliveryNotificationsViewModel(
            getNotifications = FakeGetDeliveryNotifications(Result.failure(RuntimeException("Error de red"))),
            markRead = FakeMarkDeliveryNotificationRead(Result.success(Unit)),
            markAllRead = FakeMarkAllDeliveryNotificationsRead(Result.success(Unit)),
            loggerFactory = testLoggerFactory
        )

        vm.loadNotifications()

        assertEquals(DeliveryNotificationsStatus.Empty, vm.state.status)
        assertEquals("Error de red", vm.state.errorMessage)
    }

    @Test
    fun `markNotificationAsRead recarga notificaciones despues de marcar`() = runTest {
        val notifications = sampleNotifications()
        var callCount = 0
        val vm = DeliveryNotificationsViewModel(
            getNotifications = object : ToDoGetDeliveryNotifications {
                override suspend fun execute(): Result<List<DeliveryNotification>> {
                    callCount++
                    return Result.success(notifications)
                }
            },
            markRead = FakeMarkDeliveryNotificationRead(Result.success(Unit)),
            markAllRead = FakeMarkAllDeliveryNotificationsRead(Result.success(Unit)),
            loggerFactory = testLoggerFactory
        )

        vm.loadNotifications()
        vm.markNotificationAsRead("order1_PENDING")

        assertEquals(2, callCount)
    }

    @Test
    fun `markAllNotificationsAsRead recarga notificaciones despues de marcar`() = runTest {
        val notifications = sampleNotifications()
        var callCount = 0
        val vm = DeliveryNotificationsViewModel(
            getNotifications = object : ToDoGetDeliveryNotifications {
                override suspend fun execute(): Result<List<DeliveryNotification>> {
                    callCount++
                    return Result.success(notifications)
                }
            },
            markRead = FakeMarkDeliveryNotificationRead(Result.success(Unit)),
            markAllRead = FakeMarkAllDeliveryNotificationsRead(Result.success(Unit)),
            loggerFactory = testLoggerFactory
        )

        vm.loadNotifications()
        vm.markAllNotificationsAsRead()

        assertEquals(2, callCount)
    }

    @Test
    fun `loadNotifications con rol no Delivery queda en Empty con Access denied`() = runTest {
        SessionStore.clear()
        SessionStore.updateRole(UserRole.Client)

        val vm = DeliveryNotificationsViewModel(
            getNotifications = FakeGetDeliveryNotifications(Result.success(sampleNotifications())),
            markRead = FakeMarkDeliveryNotificationRead(Result.success(Unit)),
            markAllRead = FakeMarkAllDeliveryNotificationsRead(Result.success(Unit)),
            loggerFactory = testLoggerFactory
        )

        vm.loadNotifications()

        assertEquals(DeliveryNotificationsStatus.Empty, vm.state.status)
        assertEquals("Access denied", vm.state.errorMessage)
        assertTrue(vm.state.notifications.isEmpty())
    }

    @Test
    fun `loadNotifications sin rol asignado queda en Empty con Access denied`() = runTest {
        SessionStore.clear()

        val vm = DeliveryNotificationsViewModel(
            getNotifications = FakeGetDeliveryNotifications(Result.success(sampleNotifications())),
            markRead = FakeMarkDeliveryNotificationRead(Result.success(Unit)),
            markAllRead = FakeMarkAllDeliveryNotificationsRead(Result.success(Unit)),
            loggerFactory = testLoggerFactory
        )

        vm.loadNotifications()

        assertEquals(DeliveryNotificationsStatus.Empty, vm.state.status)
        assertEquals("Access denied", vm.state.errorMessage)
    }

    @Test
    fun `markNotificationAsRead con error no recarga notificaciones`() = runTest {
        var callCount = 0
        val vm = DeliveryNotificationsViewModel(
            getNotifications = object : ToDoGetDeliveryNotifications {
                override suspend fun execute(): Result<List<DeliveryNotification>> {
                    callCount++
                    return Result.success(sampleNotifications())
                }
            },
            markRead = FakeMarkDeliveryNotificationRead(Result.failure(RuntimeException("Error de red"))),
            markAllRead = FakeMarkAllDeliveryNotificationsRead(Result.success(Unit)),
            loggerFactory = testLoggerFactory
        )

        vm.loadNotifications()
        vm.markNotificationAsRead("order1_PENDING")

        // Solo se llamó una vez (loadNotifications inicial), no recargó tras el error
        assertEquals(1, callCount)
    }

    @Test
    fun `markAllNotificationsAsRead con error no recarga notificaciones`() = runTest {
        var callCount = 0
        val vm = DeliveryNotificationsViewModel(
            getNotifications = object : ToDoGetDeliveryNotifications {
                override suspend fun execute(): Result<List<DeliveryNotification>> {
                    callCount++
                    return Result.success(sampleNotifications())
                }
            },
            markRead = FakeMarkDeliveryNotificationRead(Result.success(Unit)),
            markAllRead = FakeMarkAllDeliveryNotificationsRead(Result.failure(RuntimeException("Error de red"))),
            loggerFactory = testLoggerFactory
        )

        vm.loadNotifications()
        vm.markAllNotificationsAsRead()

        // Solo se llamó una vez (loadNotifications inicial), no recargó tras el error
        assertEquals(1, callCount)
    }

    @Test
    fun `clearError limpia el mensaje de error`() = runTest {
        val vm = DeliveryNotificationsViewModel(
            getNotifications = FakeGetDeliveryNotifications(Result.failure(RuntimeException("Error"))),
            markRead = FakeMarkDeliveryNotificationRead(Result.success(Unit)),
            markAllRead = FakeMarkAllDeliveryNotificationsRead(Result.success(Unit)),
            loggerFactory = testLoggerFactory
        )

        vm.loadNotifications()
        assertEquals("Error", vm.state.errorMessage)

        vm.clearError()
        assertEquals(null, vm.state.errorMessage)
    }
}

class DeliveryNotificationStoreTest {

    @Test
    fun `updateFromOrders genera notificaciones por estado de pedido`() {
        DeliveryNotificationStore.clear()

        val orders = listOf(
            DeliveryOrder(
                id = "order1",
                label = "BCDF23",
                businessName = "La Esquina de Pepe",
                neighborhood = "Palermo",
                status = DeliveryOrderStatus.PENDING,
                eta = null
            ),
            DeliveryOrder(
                id = "order2",
                label = "KLMN78",
                businessName = "Panaderia Los Arcos",
                neighborhood = "Belgrano",
                status = DeliveryOrderStatus.IN_PROGRESS,
                eta = "15 min"
            )
        )

        DeliveryNotificationStore.updateFromOrders(orders)

        val notifications = DeliveryNotificationStore.notifications.value
        assertEquals(2, notifications.size)
        assertEquals(2, DeliveryNotificationStore.unreadCount)
    }

    @Test
    fun `updateFromOrders no duplica notificaciones existentes`() {
        DeliveryNotificationStore.clear()

        val orders = listOf(
            DeliveryOrder("order1", "BCDF23", "Test", "Palermo", DeliveryOrderStatus.PENDING, null)
        )

        DeliveryNotificationStore.updateFromOrders(orders)
        DeliveryNotificationStore.updateFromOrders(orders)

        assertEquals(1, DeliveryNotificationStore.notifications.value.size)
    }

    @Test
    fun `markAsRead cambia estado de una notificacion`() {
        DeliveryNotificationStore.clear()

        val orders = listOf(
            DeliveryOrder("order1", "BCDF23", "Test", "Palermo", DeliveryOrderStatus.PENDING, null),
            DeliveryOrder("order2", "KLMN78", "Test2", "Belgrano", DeliveryOrderStatus.IN_PROGRESS, null)
        )

        DeliveryNotificationStore.updateFromOrders(orders)
        DeliveryNotificationStore.markAsRead("order1_PENDING")

        assertEquals(1, DeliveryNotificationStore.unreadCount)
        assertTrue(DeliveryNotificationStore.notifications.value.first { it.id == "order1_PENDING" }.isRead)
    }

    @Test
    fun `markAllAsRead cambia estado de todas las notificaciones`() {
        DeliveryNotificationStore.clear()

        val orders = listOf(
            DeliveryOrder("order1", "BCDF23", "Test", "Palermo", DeliveryOrderStatus.PENDING, null),
            DeliveryOrder("order2", "KLMN78", "Test2", "Belgrano", DeliveryOrderStatus.IN_PROGRESS, null)
        )

        DeliveryNotificationStore.updateFromOrders(orders)
        DeliveryNotificationStore.markAllAsRead()

        assertEquals(0, DeliveryNotificationStore.unreadCount)
    }

    @Test
    fun `updateFromOrders concurrente no pierde notificaciones`() = runTest {
        DeliveryNotificationStore.clear()

        val ordersA = listOf(
            DeliveryOrder("orderA1", "AAAA11", "Negocio A1", "Palermo", DeliveryOrderStatus.PENDING, null),
            DeliveryOrder("orderA2", "AAAA22", "Negocio A2", "Belgrano", DeliveryOrderStatus.IN_PROGRESS, null)
        )
        val ordersB = listOf(
            DeliveryOrder("orderB1", "BBBB11", "Negocio B1", "Recoleta", DeliveryOrderStatus.PENDING, null),
            DeliveryOrder("orderB2", "BBBB22", "Negocio B2", "Caballito", DeliveryOrderStatus.DELIVERED, null)
        )

        // Ejecutar dos actualizaciones concurrentes
        val deferredA = async { DeliveryNotificationStore.updateFromOrders(ordersA) }
        val deferredB = async { DeliveryNotificationStore.updateFromOrders(ordersB) }
        awaitAll(deferredA, deferredB)

        // Ambas listas deben estar presentes — ninguna se perdió
        val notifications = DeliveryNotificationStore.notifications.value
        assertEquals(4, notifications.size, "Llamadas concurrentes no deben perder notificaciones")
        assertTrue(notifications.any { it.id == "orderA1_PENDING" })
        assertTrue(notifications.any { it.id == "orderA2_IN_PROGRESS" })
        assertTrue(notifications.any { it.id == "orderB1_PENDING" })
        assertTrue(notifications.any { it.id == "orderB2_DELIVERED" })
    }

    @Test
    fun `clear elimina todas las notificaciones`() {
        val orders = listOf(
            DeliveryOrder("order1", "BCDF23", "Test", "Palermo", DeliveryOrderStatus.PENDING, null)
        )

        DeliveryNotificationStore.updateFromOrders(orders)
        DeliveryNotificationStore.clear()

        assertTrue(DeliveryNotificationStore.notifications.value.isEmpty())
        assertEquals(0, DeliveryNotificationStore.unreadCount)
    }
}

private class FakeGetDeliveryNotifications(
    private val result: Result<List<DeliveryNotification>>
) : ToDoGetDeliveryNotifications {
    override suspend fun execute(): Result<List<DeliveryNotification>> = result
}

private class FakeMarkDeliveryNotificationRead(
    private val result: Result<Unit>
) : ToDoMarkDeliveryNotificationRead {
    override suspend fun execute(notificationId: String): Result<Unit> = result
}

private class FakeMarkAllDeliveryNotificationsRead(
    private val result: Result<Unit>
) : ToDoMarkAllDeliveryNotificationsRead {
    override suspend fun execute(): Result<Unit> = result
}
