package asdo.client

import kotlinx.coroutines.test.runTest
import ui.sc.client.ClientNotificationStore
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DoGetNotificationsTest {

    @BeforeTest
    fun setup() {
        ClientNotificationStore.clear()
    }

    @Test
    fun `obtener notificaciones cuando el store esta vacio retorna lista vacia`() = runTest {
        val sut = DoGetNotifications()

        val result = sut.execute()

        assertTrue(result.isSuccess)
        assertTrue(result.getOrThrow().isEmpty())
    }

    @Test
    fun `obtener notificaciones retorna las del store`() = runTest {
        val orders = listOf(
            ClientOrder(
                id = "ord-1", publicId = "PUB-001", shortCode = "SC01",
                businessName = "Tienda", status = ClientOrderStatus.PENDING,
                createdAt = "2025-01-01", promisedAt = null,
                total = 100.0, itemCount = 2
            )
        )
        ClientNotificationStore.updateFromOrders(orders)

        val sut = DoGetNotifications()
        val result = sut.execute()

        assertTrue(result.isSuccess)
        val notifications = result.getOrThrow()
        assertEquals(1, notifications.size)
        assertEquals("ord-1_PENDING", notifications[0].id)
        assertEquals(NotificationEventType.ORDER_CREATED, notifications[0].eventType)
        assertEquals("Tienda", notifications[0].businessName)
    }

    @Test
    fun `obtener notificaciones incluye mensajes del negocio`() = runTest {
        ClientNotificationStore.addBusinessMessage(
            orderId = "ord-1",
            shortCode = "SC01",
            businessName = "Tienda",
            message = "Tu pedido esta listo",
            timestamp = "2025-01-01T12:00:00"
        )

        val sut = DoGetNotifications()
        val result = sut.execute()

        assertTrue(result.isSuccess)
        val notifications = result.getOrThrow()
        assertEquals(1, notifications.size)
        assertEquals(NotificationEventType.BUSINESS_MESSAGE, notifications[0].eventType)
        assertEquals("Tu pedido esta listo", notifications[0].message)
    }
}

class DoMarkNotificationReadTest {

    @BeforeTest
    fun setup() {
        ClientNotificationStore.clear()
    }

    @Test
    fun `marcar notificacion como leida actualiza el estado en el store`() = runTest {
        val orders = listOf(
            ClientOrder(
                id = "ord-1", publicId = "PUB-001", shortCode = "SC01",
                businessName = "Tienda", status = ClientOrderStatus.CONFIRMED,
                createdAt = "2025-01-01", promisedAt = null,
                total = 100.0, itemCount = 1
            )
        )
        ClientNotificationStore.updateFromOrders(orders)
        val notifId = "ord-1_CONFIRMED"

        val sut = DoMarkNotificationRead()
        val result = sut.execute(notifId)

        assertTrue(result.isSuccess)
        val notifications = ClientNotificationStore.notifications.value
        assertTrue(notifications.first { it.id == notifId }.isRead)
    }

    @Test
    fun `marcar notificacion inexistente no falla`() = runTest {
        val sut = DoMarkNotificationRead()
        val result = sut.execute("id-inexistente")

        assertTrue(result.isSuccess)
    }
}

class DoMarkAllNotificationsReadTest {

    @BeforeTest
    fun setup() {
        ClientNotificationStore.clear()
    }

    @Test
    fun `marcar todas como leidas actualiza todas las notificaciones`() = runTest {
        val orders = listOf(
            ClientOrder(
                id = "ord-1", publicId = "PUB-001", shortCode = "SC01",
                businessName = "Tienda", status = ClientOrderStatus.PENDING,
                createdAt = "2025-01-01", promisedAt = null,
                total = 100.0, itemCount = 1
            ),
            ClientOrder(
                id = "ord-2", publicId = "PUB-002", shortCode = "SC02",
                businessName = "Farmacia", status = ClientOrderStatus.CONFIRMED,
                createdAt = "2025-01-02", promisedAt = null,
                total = 50.0, itemCount = 1
            )
        )
        ClientNotificationStore.updateFromOrders(orders)

        val sut = DoMarkAllNotificationsRead()
        val result = sut.execute()

        assertTrue(result.isSuccess)
        val notifications = ClientNotificationStore.notifications.value
        assertEquals(2, notifications.size)
        assertTrue(notifications.all { it.isRead })
    }

    @Test
    fun `marcar todas como leidas con store vacio no falla`() = runTest {
        val sut = DoMarkAllNotificationsRead()
        val result = sut.execute()

        assertTrue(result.isSuccess)
    }
}

class NotificationModelsTest {

    @Test
    fun `toNotificationEventType mapea correctamente todos los estados de pedido`() {
        assertEquals(NotificationEventType.ORDER_CREATED, ClientOrderStatus.PENDING.toNotificationEventType())
        assertEquals(NotificationEventType.ORDER_CONFIRMED, ClientOrderStatus.CONFIRMED.toNotificationEventType())
        assertEquals(NotificationEventType.ORDER_PREPARING, ClientOrderStatus.PREPARING.toNotificationEventType())
        assertEquals(NotificationEventType.ORDER_READY, ClientOrderStatus.READY.toNotificationEventType())
        assertEquals(NotificationEventType.ORDER_DELIVERING, ClientOrderStatus.DELIVERING.toNotificationEventType())
        assertEquals(NotificationEventType.ORDER_DELIVERED, ClientOrderStatus.DELIVERED.toNotificationEventType())
        assertEquals(NotificationEventType.ORDER_CANCELLED, ClientOrderStatus.CANCELLED.toNotificationEventType())
        assertEquals(NotificationEventType.ORDER_CREATED, ClientOrderStatus.UNKNOWN.toNotificationEventType())
    }
}

class ClientNotificationStoreTest {

    @BeforeTest
    fun setup() {
        ClientNotificationStore.clear()
    }

    @Test
    fun `updateFromOrders genera notificaciones unicas por pedido y estado`() {
        val orders = listOf(
            ClientOrder(
                id = "ord-1", publicId = "PUB-001", shortCode = "SC01",
                businessName = "Tienda", status = ClientOrderStatus.DELIVERING,
                createdAt = "2025-01-01", promisedAt = null,
                total = 200.0, itemCount = 3
            )
        )

        ClientNotificationStore.updateFromOrders(orders)
        ClientNotificationStore.updateFromOrders(orders) // segunda llamada no debe duplicar

        assertEquals(1, ClientNotificationStore.notifications.value.size)
    }

    @Test
    fun `unreadCount es correcto despues de marcar como leido`() {
        val orders = listOf(
            ClientOrder(
                id = "ord-1", publicId = "PUB-001", shortCode = "SC01",
                businessName = "Tienda", status = ClientOrderStatus.DELIVERED,
                createdAt = "2025-01-01", promisedAt = null,
                total = 100.0, itemCount = 1
            )
        )
        ClientNotificationStore.updateFromOrders(orders)
        assertEquals(1, ClientNotificationStore.unreadCount)

        ClientNotificationStore.markAsRead("ord-1_DELIVERED")
        assertEquals(0, ClientNotificationStore.unreadCount)
    }

    @Test
    fun `addBusinessMessage no agrega duplicados con el mismo mensaje`() {
        repeat(3) {
            ClientNotificationStore.addBusinessMessage(
                orderId = "ord-1",
                shortCode = "SC01",
                businessName = "Tienda",
                message = "Mismo mensaje",
                timestamp = "2025-01-01T10:00:00"
            )
        }

        assertEquals(1, ClientNotificationStore.notifications.value.size)
    }
}
