package asdo.delivery

import kotlinx.coroutines.test.runTest
import ui.sc.delivery.DeliveryNotificationStore
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DeliveryNotificationEventTypeMappingTest {

    @Test
    fun `toNotificationEventType mapea PENDING a ORDER_AVAILABLE`() {
        assertEquals(
            DeliveryNotificationEventType.ORDER_AVAILABLE,
            DeliveryOrderStatus.PENDING.toNotificationEventType()
        )
    }

    @Test
    fun `toNotificationEventType mapea IN_PROGRESS a ORDER_ASSIGNED`() {
        assertEquals(
            DeliveryNotificationEventType.ORDER_ASSIGNED,
            DeliveryOrderStatus.IN_PROGRESS.toNotificationEventType()
        )
    }

    @Test
    fun `toNotificationEventType mapea DELIVERED a ORDER_DELIVERED`() {
        assertEquals(
            DeliveryNotificationEventType.ORDER_DELIVERED,
            DeliveryOrderStatus.DELIVERED.toNotificationEventType()
        )
    }

    @Test
    fun `toNotificationEventType mapea NOT_DELIVERED a ORDER_NOT_DELIVERED`() {
        assertEquals(
            DeliveryNotificationEventType.ORDER_NOT_DELIVERED,
            DeliveryOrderStatus.NOT_DELIVERED.toNotificationEventType()
        )
    }

    @Test
    fun `toNotificationEventType mapea UNKNOWN a ORDER_AVAILABLE`() {
        assertEquals(
            DeliveryNotificationEventType.ORDER_AVAILABLE,
            DeliveryOrderStatus.UNKNOWN.toNotificationEventType()
        )
    }
}

class DoGetDeliveryNotificationsTest {

    @Test
    fun `retorna lista vacia cuando no hay notificaciones`() = runTest {
        DeliveryNotificationStore.clear()
        val sut = DoGetDeliveryNotifications()

        val result = sut.execute()

        assertTrue(result.isSuccess)
        assertTrue(result.getOrThrow().isEmpty())
    }

    @Test
    fun `retorna notificaciones existentes en el store`() = runTest {
        DeliveryNotificationStore.clear()
        val orders = listOf(
            DeliveryOrder(
                id = "ord-1",
                label = "Pedido #001",
                businessName = "Panaderia",
                neighborhood = "Centro",
                status = DeliveryOrderStatus.PENDING,
                eta = "2025-01-01T10:00:00"
            )
        )
        DeliveryNotificationStore.updateFromOrders(orders)
        val sut = DoGetDeliveryNotifications()

        val result = sut.execute()

        assertTrue(result.isSuccess)
        assertEquals(1, result.getOrThrow().size)
        assertEquals("Panaderia", result.getOrThrow().first().businessName)
    }
}

class DoMarkDeliveryNotificationReadTest {

    @Test
    fun `marca notificacion como leida exitosamente`() = runTest {
        DeliveryNotificationStore.clear()
        val orders = listOf(
            DeliveryOrder(
                id = "ord-2",
                label = "Pedido #002",
                businessName = "Farmacia",
                neighborhood = "Alberdi",
                status = DeliveryOrderStatus.IN_PROGRESS,
                eta = "2025-01-02T09:00:00"
            )
        )
        DeliveryNotificationStore.updateFromOrders(orders)
        val notifId = DeliveryNotificationStore.notifications.value.first().id
        val sut = DoMarkDeliveryNotificationRead()

        val result = sut.execute(notifId)

        assertTrue(result.isSuccess)
        val notif = DeliveryNotificationStore.notifications.value.first { it.id == notifId }
        assertTrue(notif.isRead)
    }

    @Test
    fun `con id inexistente no falla`() = runTest {
        DeliveryNotificationStore.clear()
        val sut = DoMarkDeliveryNotificationRead()

        val result = sut.execute("id-que-no-existe")

        assertTrue(result.isSuccess)
    }
}

class DoMarkAllDeliveryNotificationsReadTest {

    @Test
    fun `marca todas las notificaciones como leidas`() = runTest {
        DeliveryNotificationStore.clear()
        val orders = listOf(
            DeliveryOrder(
                id = "ord-3",
                label = "Pedido #003",
                businessName = "Mercado",
                neighborhood = "Nueva Cordoba",
                status = DeliveryOrderStatus.PENDING,
                eta = "2025-01-03T08:00:00"
            ),
            DeliveryOrder(
                id = "ord-4",
                label = "Pedido #004",
                businessName = "Kiosco",
                neighborhood = "General Paz",
                status = DeliveryOrderStatus.IN_PROGRESS,
                eta = "2025-01-04T08:00:00"
            )
        )
        DeliveryNotificationStore.updateFromOrders(orders)
        val sut = DoMarkAllDeliveryNotificationsRead()

        val result = sut.execute()

        assertTrue(result.isSuccess)
        val allRead = DeliveryNotificationStore.notifications.value.all { it.isRead }
        assertTrue(allRead)
    }

    @Test
    fun `con store vacio no falla`() = runTest {
        DeliveryNotificationStore.clear()
        val sut = DoMarkAllDeliveryNotificationsRead()

        val result = sut.execute()

        assertTrue(result.isSuccess)
        assertEquals(0, DeliveryNotificationStore.unreadCount)
    }
}
