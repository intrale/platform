package asdo.client

import kotlin.test.Test
import kotlin.test.assertEquals

class NotificationModelsTest {

    @Test
    fun `PENDING se mapea a ORDER_CREATED`() {
        assertEquals(
            NotificationEventType.ORDER_CREATED,
            ClientOrderStatus.PENDING.toNotificationEventType()
        )
    }

    @Test
    fun `CONFIRMED se mapea a ORDER_CONFIRMED`() {
        assertEquals(
            NotificationEventType.ORDER_CONFIRMED,
            ClientOrderStatus.CONFIRMED.toNotificationEventType()
        )
    }

    @Test
    fun `PREPARING se mapea a ORDER_PREPARING`() {
        assertEquals(
            NotificationEventType.ORDER_PREPARING,
            ClientOrderStatus.PREPARING.toNotificationEventType()
        )
    }

    @Test
    fun `READY se mapea a ORDER_READY`() {
        assertEquals(
            NotificationEventType.ORDER_READY,
            ClientOrderStatus.READY.toNotificationEventType()
        )
    }

    @Test
    fun `DELIVERING se mapea a ORDER_DELIVERING`() {
        assertEquals(
            NotificationEventType.ORDER_DELIVERING,
            ClientOrderStatus.DELIVERING.toNotificationEventType()
        )
    }

    @Test
    fun `DELIVERED se mapea a ORDER_DELIVERED`() {
        assertEquals(
            NotificationEventType.ORDER_DELIVERED,
            ClientOrderStatus.DELIVERED.toNotificationEventType()
        )
    }

    @Test
    fun `CANCELLED se mapea a ORDER_CANCELLED`() {
        assertEquals(
            NotificationEventType.ORDER_CANCELLED,
            ClientOrderStatus.CANCELLED.toNotificationEventType()
        )
    }

    @Test
    fun `UNKNOWN se mapea a ORDER_CREATED`() {
        assertEquals(
            NotificationEventType.ORDER_CREATED,
            ClientOrderStatus.UNKNOWN.toNotificationEventType()
        )
    }

    @Test
    fun `ClientNotification se crea con isRead false por defecto`() {
        val notification = ClientNotification(
            id = "notif-1",
            orderId = "order-1",
            shortCode = "ABC",
            businessName = "Tienda",
            eventType = NotificationEventType.ORDER_CREATED,
            message = "Tu pedido fue creado",
            timestamp = "2026-04-01T10:00:00Z"
        )

        assertEquals(false, notification.isRead)
    }

    @Test
    fun `ClientNotification con isRead true se crea correctamente`() {
        val notification = ClientNotification(
            id = "notif-2",
            orderId = "order-2",
            shortCode = "DEF",
            businessName = "Otro Negocio",
            eventType = NotificationEventType.ORDER_DELIVERED,
            message = "Pedido entregado",
            timestamp = "2026-04-01T12:00:00Z",
            isRead = true
        )

        assertEquals(true, notification.isRead)
        assertEquals("notif-2", notification.id)
        assertEquals(NotificationEventType.ORDER_DELIVERED, notification.eventType)
    }
}
