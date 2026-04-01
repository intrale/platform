package asdo.client

import kotlin.test.Test
import kotlin.test.assertEquals

class NotificationModelsTest {

    @Test
    fun `toNotificationEventType mapea PENDING a ORDER_CREATED`() {
        assertEquals(
            NotificationEventType.ORDER_CREATED,
            ClientOrderStatus.PENDING.toNotificationEventType()
        )
    }

    @Test
    fun `toNotificationEventType mapea CONFIRMED a ORDER_CONFIRMED`() {
        assertEquals(
            NotificationEventType.ORDER_CONFIRMED,
            ClientOrderStatus.CONFIRMED.toNotificationEventType()
        )
    }

    @Test
    fun `toNotificationEventType mapea PREPARING a ORDER_PREPARING`() {
        assertEquals(
            NotificationEventType.ORDER_PREPARING,
            ClientOrderStatus.PREPARING.toNotificationEventType()
        )
    }

    @Test
    fun `toNotificationEventType mapea READY a ORDER_READY`() {
        assertEquals(
            NotificationEventType.ORDER_READY,
            ClientOrderStatus.READY.toNotificationEventType()
        )
    }

    @Test
    fun `toNotificationEventType mapea DELIVERING a ORDER_DELIVERING`() {
        assertEquals(
            NotificationEventType.ORDER_DELIVERING,
            ClientOrderStatus.DELIVERING.toNotificationEventType()
        )
    }

    @Test
    fun `toNotificationEventType mapea DELIVERED a ORDER_DELIVERED`() {
        assertEquals(
            NotificationEventType.ORDER_DELIVERED,
            ClientOrderStatus.DELIVERED.toNotificationEventType()
        )
    }

    @Test
    fun `toNotificationEventType mapea CANCELLED a ORDER_CANCELLED`() {
        assertEquals(
            NotificationEventType.ORDER_CANCELLED,
            ClientOrderStatus.CANCELLED.toNotificationEventType()
        )
    }

    @Test
    fun `toNotificationEventType mapea UNKNOWN a ORDER_CREATED como fallback`() {
        assertEquals(
            NotificationEventType.ORDER_CREATED,
            ClientOrderStatus.UNKNOWN.toNotificationEventType()
        )
    }
}
