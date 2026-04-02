package asdo.client

import kotlinx.coroutines.test.runTest
import ui.sc.client.ClientNotificationStore
import ui.sc.client.ClientPushPreferencesStore
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class DoPushNotificationHandlerTest {

    private lateinit var sut: DoPushNotificationHandler

    @BeforeTest
    fun setup() {
        ClientNotificationStore.clear()
        ClientPushPreferencesStore.clear()
        sut = DoPushNotificationHandler()
    }

    @Test
    fun `agrega notificacion al store cuando push esta habilitado`() = runTest {
        val notification = buildNotification(NotificationEventType.ORDER_CONFIRMED)

        val result = sut.execute(notification)

        assertTrue(result.isSuccess)
        assertTrue(result.getOrThrow())
        assertEquals(1, ClientNotificationStore.notifications.value.size)
        assertEquals("Panaderia Test", ClientNotificationStore.notifications.value.first().businessName)
    }

    @Test
    fun `descarta notificacion cuando push esta desactivado globalmente`() = runTest {
        ClientPushPreferencesStore.toggleEnabled(false)

        val notification = buildNotification(NotificationEventType.ORDER_CONFIRMED)
        val result = sut.execute(notification)

        assertTrue(result.isSuccess)
        assertFalse(result.getOrThrow())
        assertEquals(0, ClientNotificationStore.notifications.value.size)
    }

    @Test
    fun `filtra notificacion ORDER_CONFIRMED cuando preferencia esta desactivada`() = runTest {
        ClientPushPreferencesStore.toggleOrderConfirmed(false)

        val notification = buildNotification(NotificationEventType.ORDER_CONFIRMED)
        val result = sut.execute(notification)

        assertTrue(result.isSuccess)
        assertFalse(result.getOrThrow())
        assertEquals(0, ClientNotificationStore.notifications.value.size)
    }

    @Test
    fun `filtra notificacion ORDER_DELIVERING cuando preferencia esta desactivada`() = runTest {
        ClientPushPreferencesStore.toggleOrderDelivering(false)

        val notification = buildNotification(NotificationEventType.ORDER_DELIVERING)
        val result = sut.execute(notification)

        assertTrue(result.isSuccess)
        assertFalse(result.getOrThrow())
    }

    @Test
    fun `filtra notificacion ORDER_DELIVERED cuando preferencia esta desactivada`() = runTest {
        ClientPushPreferencesStore.toggleOrderDelivered(false)

        val notification = buildNotification(NotificationEventType.ORDER_DELIVERED)
        val result = sut.execute(notification)

        assertTrue(result.isSuccess)
        assertFalse(result.getOrThrow())
    }

    @Test
    fun `filtra notificacion ORDER_READY (nearby) cuando preferencia esta desactivada`() = runTest {
        ClientPushPreferencesStore.toggleOrderNearby(false)

        val notification = buildNotification(NotificationEventType.ORDER_READY)
        val result = sut.execute(notification)

        assertTrue(result.isSuccess)
        assertFalse(result.getOrThrow())
    }

    @Test
    fun `siempre permite ORDER_CANCELLED aunque preferencias esten parcialmente desactivadas`() = runTest {
        ClientPushPreferencesStore.toggleOrderConfirmed(false)
        ClientPushPreferencesStore.toggleOrderDelivering(false)

        val notification = buildNotification(NotificationEventType.ORDER_CANCELLED)
        val result = sut.execute(notification)

        assertTrue(result.isSuccess)
        assertTrue(result.getOrThrow())
        assertEquals(1, ClientNotificationStore.notifications.value.size)
    }

    @Test
    fun `siempre permite BUSINESS_MESSAGE cuando push esta habilitado`() = runTest {
        val notification = buildNotification(
            eventType = NotificationEventType.BUSINESS_MESSAGE,
            message = "Tu pedido tiene una demora de 10 min"
        )
        val result = sut.execute(notification)

        assertTrue(result.isSuccess)
        assertTrue(result.getOrThrow())
        assertEquals(1, ClientNotificationStore.notifications.value.size)
    }

    @Test
    fun `no duplica notificacion con mismo orderId y eventType`() = runTest {
        val notification = buildNotification(NotificationEventType.ORDER_CONFIRMED)

        sut.execute(notification)
        sut.execute(notification)

        assertEquals(1, ClientNotificationStore.notifications.value.size)
    }

    @Test
    fun `agrega notificaciones distintas del mismo pedido`() = runTest {
        val confirmed = buildNotification(NotificationEventType.ORDER_CONFIRMED)
        val delivering = buildNotification(NotificationEventType.ORDER_DELIVERING)

        sut.execute(confirmed)
        sut.execute(delivering)

        assertEquals(2, ClientNotificationStore.notifications.value.size)
    }

    private fun buildNotification(
        eventType: NotificationEventType,
        orderId: String = "order-123",
        shortCode: String = "A1B2",
        businessName: String = "Panaderia Test",
        message: String = "",
        timestamp: String = "2025-06-15T14:30:00"
    ) = IncomingPushNotification(
        orderId = orderId,
        shortCode = shortCode,
        businessName = businessName,
        eventType = eventType,
        message = message,
        timestamp = timestamp
    )
}
