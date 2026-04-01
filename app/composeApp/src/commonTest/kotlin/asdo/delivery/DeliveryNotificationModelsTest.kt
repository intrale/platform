package asdo.delivery

import kotlin.test.Test
import kotlin.test.assertEquals

class DeliveryNotificationModelsTest {

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
    fun `toNotificationEventType mapea UNKNOWN a ORDER_AVAILABLE como fallback`() {
        assertEquals(
            DeliveryNotificationEventType.ORDER_AVAILABLE,
            DeliveryOrderStatus.UNKNOWN.toNotificationEventType()
        )
    }
}
