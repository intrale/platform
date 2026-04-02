package ui.sc.delivery

import asdo.delivery.DeliveryNotificationEventType
import asdo.delivery.DeliveryOrder
import asdo.delivery.DeliveryOrderStatus
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class DeliveryNotificationStoreTest {

    @BeforeTest
    fun setup() {
        DeliveryNotificationStore.clear()
    }

    @Test
    fun `updateFromOrders genera notificacion de nuevo pedido disponible`() {
        val orders = listOf(
            DeliveryOrder(
                id = "order1",
                label = "BCDF23",
                businessName = "La Esquina de Pepe",
                neighborhood = "Palermo",
                status = DeliveryOrderStatus.PENDING,
                eta = null
            )
        )

        DeliveryNotificationStore.updateFromOrders(orders)

        val notifications = DeliveryNotificationStore.notifications.value
        assertEquals(1, notifications.size)
        assertEquals(DeliveryNotificationEventType.ORDER_AVAILABLE, notifications[0].eventType)
        assertEquals("order1_PENDING", notifications[0].id)
        assertEquals("order1", notifications[0].orderId)
        assertFalse(notifications[0].isRead)
    }

    @Test
    fun `updateFromOrders genera notificacion de pedido asignado`() {
        val orders = listOf(
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
        assertEquals(1, notifications.size)
        assertEquals(DeliveryNotificationEventType.ORDER_ASSIGNED, notifications[0].eventType)
        assertEquals("order2_IN_PROGRESS", notifications[0].id)
    }

    @Test
    fun `updateFromOrders genera notificacion de pedido no entregado`() {
        val orders = listOf(
            DeliveryOrder(
                id = "order3",
                label = "WXYZ99",
                businessName = "Farmacia Central",
                neighborhood = "Caballito",
                status = DeliveryOrderStatus.NOT_DELIVERED,
                eta = null
            )
        )

        DeliveryNotificationStore.updateFromOrders(orders)

        val notifications = DeliveryNotificationStore.notifications.value
        assertEquals(1, notifications.size)
        assertEquals(DeliveryNotificationEventType.ORDER_NOT_DELIVERED, notifications[0].eventType)
        assertEquals("order3_NOT_DELIVERED", notifications[0].id)
    }

    @Test
    fun `updateFromOrders no duplica notificaciones existentes`() {
        val orders = listOf(
            DeliveryOrder("order1", "BCDF23", "Test", "Palermo", DeliveryOrderStatus.PENDING, null)
        )

        DeliveryNotificationStore.updateFromOrders(orders)
        DeliveryNotificationStore.updateFromOrders(orders)

        assertEquals(1, DeliveryNotificationStore.notifications.value.size)
    }

    @Test
    fun `updateFromOrders genera notificaciones distintas por cambio de estado del mismo pedido`() {
        val orderPending = listOf(
            DeliveryOrder("order1", "BCDF23", "Test", "Palermo", DeliveryOrderStatus.PENDING, null)
        )
        val orderAssigned = listOf(
            DeliveryOrder("order1", "BCDF23", "Test", "Palermo", DeliveryOrderStatus.IN_PROGRESS, "10 min")
        )

        DeliveryNotificationStore.updateFromOrders(orderPending)
        DeliveryNotificationStore.updateFromOrders(orderAssigned)

        val notifications = DeliveryNotificationStore.notifications.value
        assertEquals(2, notifications.size)
        assertTrue(notifications.any { it.id == "order1_PENDING" })
        assertTrue(notifications.any { it.id == "order1_IN_PROGRESS" })
    }

    @Test
    fun `markAsRead marca notificacion individual como leida`() {
        val orders = listOf(
            DeliveryOrder("order1", "BCDF23", "Test", "Palermo", DeliveryOrderStatus.PENDING, null),
            DeliveryOrder("order2", "KLMN78", "Test2", "Belgrano", DeliveryOrderStatus.IN_PROGRESS, null)
        )

        DeliveryNotificationStore.updateFromOrders(orders)
        DeliveryNotificationStore.markAsRead("order1_PENDING")

        assertEquals(1, DeliveryNotificationStore.unreadCount)
        assertTrue(DeliveryNotificationStore.notifications.value.first { it.id == "order1_PENDING" }.isRead)
        assertFalse(DeliveryNotificationStore.notifications.value.first { it.id == "order2_IN_PROGRESS" }.isRead)
    }

    @Test
    fun `markAllAsRead marca todas las notificaciones como leidas`() {
        val orders = listOf(
            DeliveryOrder("order1", "BCDF23", "Test", "Palermo", DeliveryOrderStatus.PENDING, null),
            DeliveryOrder("order2", "KLMN78", "Test2", "Belgrano", DeliveryOrderStatus.IN_PROGRESS, null)
        )

        DeliveryNotificationStore.updateFromOrders(orders)
        DeliveryNotificationStore.markAllAsRead()

        assertEquals(0, DeliveryNotificationStore.unreadCount)
        assertTrue(DeliveryNotificationStore.notifications.value.all { it.isRead })
    }

    @Test
    fun `unreadCount devuelve conteo correcto de notificaciones no leidas`() {
        val orders = listOf(
            DeliveryOrder("order1", "BCDF23", "Test", "Palermo", DeliveryOrderStatus.PENDING, null),
            DeliveryOrder("order2", "KLMN78", "Test2", "Belgrano", DeliveryOrderStatus.IN_PROGRESS, null),
            DeliveryOrder("order3", "WXYZ99", "Test3", "Caballito", DeliveryOrderStatus.DELIVERED, null)
        )

        DeliveryNotificationStore.updateFromOrders(orders)
        assertEquals(3, DeliveryNotificationStore.unreadCount)

        DeliveryNotificationStore.markAsRead("order1_PENDING")
        assertEquals(2, DeliveryNotificationStore.unreadCount)

        DeliveryNotificationStore.markAsRead("order2_IN_PROGRESS")
        assertEquals(1, DeliveryNotificationStore.unreadCount)

        DeliveryNotificationStore.markAllAsRead()
        assertEquals(0, DeliveryNotificationStore.unreadCount)
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
