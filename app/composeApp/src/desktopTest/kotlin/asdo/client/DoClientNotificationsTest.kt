package asdo.client

import kotlinx.coroutines.test.runTest
import ui.sc.client.ClientNotificationStore
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DoGetNotificationsTest {

    @Test
    fun `retorna lista vacia cuando no hay notificaciones`() = runTest {
        ClientNotificationStore.clear()
        val sut = DoGetNotifications()

        val result = sut.execute()

        assertTrue(result.isSuccess)
        assertTrue(result.getOrThrow().isEmpty())
    }

    @Test
    fun `retorna notificaciones existentes en el store`() = runTest {
        ClientNotificationStore.clear()
        val orders = listOf(
            ClientOrder(
                id = "ord-1",
                publicId = "PUB-001",
                shortCode = "001",
                businessName = "Panaderia",
                status = ClientOrderStatus.CONFIRMED,
                createdAt = "2025-01-01T10:00:00",
                promisedAt = null,
                total = 100.0,
                itemCount = 2
            )
        )
        ClientNotificationStore.updateFromOrders(orders)
        val sut = DoGetNotifications()

        val result = sut.execute()

        assertTrue(result.isSuccess)
        assertEquals(1, result.getOrThrow().size)
        assertEquals("Panaderia", result.getOrThrow().first().businessName)
    }
}

class DoMarkNotificationReadTest {

    @Test
    fun `marca notificacion como leida exitosamente`() = runTest {
        ClientNotificationStore.clear()
        val orders = listOf(
            ClientOrder(
                id = "ord-2",
                publicId = "PUB-002",
                shortCode = "002",
                businessName = "Farmacia",
                status = ClientOrderStatus.DELIVERING,
                createdAt = "2025-01-02T09:00:00",
                promisedAt = null,
                total = 50.0,
                itemCount = 1
            )
        )
        ClientNotificationStore.updateFromOrders(orders)
        val notifId = ClientNotificationStore.notifications.value.first().id
        val sut = DoMarkNotificationRead()

        val result = sut.execute(notifId)

        assertTrue(result.isSuccess)
        val notif = ClientNotificationStore.notifications.value.first { it.id == notifId }
        assertTrue(notif.isRead)
    }

    @Test
    fun `con id inexistente no falla`() = runTest {
        ClientNotificationStore.clear()
        val sut = DoMarkNotificationRead()

        val result = sut.execute("id-que-no-existe")

        assertTrue(result.isSuccess)
    }
}

class DoMarkAllNotificationsReadTest {

    @Test
    fun `marca todas las notificaciones como leidas`() = runTest {
        ClientNotificationStore.clear()
        val orders = listOf(
            ClientOrder(
                id = "ord-3",
                publicId = "PUB-003",
                shortCode = "003",
                businessName = "Mercado",
                status = ClientOrderStatus.CONFIRMED,
                createdAt = "2025-01-03T08:00:00",
                promisedAt = null,
                total = 200.0,
                itemCount = 5
            ),
            ClientOrder(
                id = "ord-4",
                publicId = "PUB-004",
                shortCode = "004",
                businessName = "Kiosco",
                status = ClientOrderStatus.DELIVERING,
                createdAt = "2025-01-04T08:00:00",
                promisedAt = null,
                total = 30.0,
                itemCount = 1
            )
        )
        ClientNotificationStore.updateFromOrders(orders)
        val sut = DoMarkAllNotificationsRead()

        val result = sut.execute()

        assertTrue(result.isSuccess)
        val allRead = ClientNotificationStore.notifications.value.all { it.isRead }
        assertTrue(allRead)
    }

    @Test
    fun `con store vacio no falla`() = runTest {
        ClientNotificationStore.clear()
        val sut = DoMarkAllNotificationsRead()

        val result = sut.execute()

        assertTrue(result.isSuccess)
        assertEquals(0, ClientNotificationStore.unreadCount)
    }
}
