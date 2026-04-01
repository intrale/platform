package ui.sc.delivery

import asdo.delivery.DeliveryNotification
import asdo.delivery.DeliveryNotificationEventType
import asdo.delivery.DeliveryOrder
import asdo.delivery.DeliveryOrderStatus
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DeliveryNotificationStoreTest {

    @BeforeTest
    fun setup() {
        DeliveryNotificationStore.clear()
    }

    @AfterTest
    fun cleanup() {
        DeliveryNotificationStore.clear()
    }

    @Test
    fun `unreadCount retorna 0 cuando no hay notificaciones`() {
        assertEquals(0, DeliveryNotificationStore.unreadCount)
    }

    @Test
    fun `notifications inicia vacio`() {
        assertTrue(DeliveryNotificationStore.notifications.value.isEmpty())
    }

    @Test
    fun `updateFromOrders crea notificaciones a partir de ordenes`() {
        val orders = listOf(
            DeliveryOrder(
                id = "order1",
                label = "Pedido #1",
                businessName = "Test Business",
                neighborhood = "Palermo",
                status = DeliveryOrderStatus.PENDING,
                eta = null
            ),
            DeliveryOrder(
                id = "order2",
                label = "Pedido #2",
                businessName = "Test Business 2",
                neighborhood = "Recoleta",
                status = DeliveryOrderStatus.DELIVERED,
                eta = null
            )
        )

        DeliveryNotificationStore.updateFromOrders(orders)

        val notifs = DeliveryNotificationStore.notifications.value
        assertEquals(2, notifs.size)
        assertEquals(2, DeliveryNotificationStore.unreadCount)
    }

    @Test
    fun `updateFromOrders no duplica notificaciones existentes`() {
        val orders = listOf(
            DeliveryOrder(
                id = "order1",
                label = "Pedido #1",
                businessName = "Test Business",
                neighborhood = "Palermo",
                status = DeliveryOrderStatus.PENDING,
                eta = null
            )
        )

        DeliveryNotificationStore.updateFromOrders(orders)
        DeliveryNotificationStore.updateFromOrders(orders)

        assertEquals(1, DeliveryNotificationStore.notifications.value.size)
    }

    @Test
    fun `updateFromOrders agrega nuevos estados de la misma orden`() {
        val orderPending = listOf(
            DeliveryOrder(
                id = "order1",
                label = "Pedido #1",
                businessName = "Test",
                neighborhood = "Palermo",
                status = DeliveryOrderStatus.PENDING,
                eta = null
            )
        )
        val orderDelivered = listOf(
            DeliveryOrder(
                id = "order1",
                label = "Pedido #1",
                businessName = "Test",
                neighborhood = "Palermo",
                status = DeliveryOrderStatus.DELIVERED,
                eta = null
            )
        )

        DeliveryNotificationStore.updateFromOrders(orderPending)
        DeliveryNotificationStore.updateFromOrders(orderPending + orderDelivered)

        assertEquals(2, DeliveryNotificationStore.notifications.value.size)
    }

    @Test
    fun `markAsRead marca una notificacion como leida`() {
        val orders = listOf(
            DeliveryOrder(
                id = "order1",
                label = "Pedido #1",
                businessName = "Test",
                neighborhood = "Palermo",
                status = DeliveryOrderStatus.PENDING,
                eta = null
            ),
            DeliveryOrder(
                id = "order2",
                label = "Pedido #2",
                businessName = "Test",
                neighborhood = "Recoleta",
                status = DeliveryOrderStatus.IN_PROGRESS,
                eta = null
            )
        )

        DeliveryNotificationStore.updateFromOrders(orders)
        assertEquals(2, DeliveryNotificationStore.unreadCount)

        DeliveryNotificationStore.markAsRead("order1_PENDING")
        assertEquals(1, DeliveryNotificationStore.unreadCount)

        val marked = DeliveryNotificationStore.notifications.value.first { it.id == "order1_PENDING" }
        assertTrue(marked.isRead)
    }

    @Test
    fun `markAllAsRead marca todas las notificaciones como leidas`() {
        val orders = listOf(
            DeliveryOrder(
                id = "order1",
                label = "Pedido #1",
                businessName = "Test",
                neighborhood = "Palermo",
                status = DeliveryOrderStatus.PENDING,
                eta = null
            ),
            DeliveryOrder(
                id = "order2",
                label = "Pedido #2",
                businessName = "Test",
                neighborhood = "Recoleta",
                status = DeliveryOrderStatus.DELIVERED,
                eta = null
            )
        )

        DeliveryNotificationStore.updateFromOrders(orders)
        assertEquals(2, DeliveryNotificationStore.unreadCount)

        DeliveryNotificationStore.markAllAsRead()
        assertEquals(0, DeliveryNotificationStore.unreadCount)
    }

    @Test
    fun `clear elimina todas las notificaciones`() {
        val orders = listOf(
            DeliveryOrder(
                id = "order1",
                label = "Pedido #1",
                businessName = "Test",
                neighborhood = "Palermo",
                status = DeliveryOrderStatus.PENDING,
                eta = null
            )
        )

        DeliveryNotificationStore.updateFromOrders(orders)
        assertEquals(1, DeliveryNotificationStore.notifications.value.size)

        DeliveryNotificationStore.clear()
        assertTrue(DeliveryNotificationStore.notifications.value.isEmpty())
        assertEquals(0, DeliveryNotificationStore.unreadCount)
    }

    @Test
    fun `updateFromOrders mapea event types correctamente`() {
        val orders = listOf(
            DeliveryOrder("o1", "P1", "B1", "N1", DeliveryOrderStatus.PENDING, null),
            DeliveryOrder("o2", "P2", "B2", "N2", DeliveryOrderStatus.IN_PROGRESS, null),
            DeliveryOrder("o3", "P3", "B3", "N3", DeliveryOrderStatus.DELIVERED, null),
            DeliveryOrder("o4", "P4", "B4", "N4", DeliveryOrderStatus.NOT_DELIVERED, null)
        )

        DeliveryNotificationStore.updateFromOrders(orders)

        val notifs = DeliveryNotificationStore.notifications.value
        val byId = notifs.associateBy { it.id }

        assertEquals(DeliveryNotificationEventType.ORDER_AVAILABLE, byId["o1_PENDING"]?.eventType)
        assertEquals(DeliveryNotificationEventType.ORDER_ASSIGNED, byId["o2_IN_PROGRESS"]?.eventType)
        assertEquals(DeliveryNotificationEventType.ORDER_DELIVERED, byId["o3_DELIVERED"]?.eventType)
        assertEquals(DeliveryNotificationEventType.ORDER_NOT_DELIVERED, byId["o4_NOT_DELIVERED"]?.eventType)
    }
}
