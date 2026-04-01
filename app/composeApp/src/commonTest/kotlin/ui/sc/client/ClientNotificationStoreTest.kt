package ui.sc.client

import asdo.client.ClientNotification
import asdo.client.ClientOrder
import asdo.client.ClientOrderStatus
import asdo.client.NotificationEventType
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ClientNotificationStoreTest {

    @BeforeTest
    fun setUp() {
        ClientNotificationStore.clear()
    }

    // --- updateFromOrders ---

    private fun sampleOrder(
        id: String = "order-1",
        publicId: String = "pub-1",
        shortCode: String = "SC001",
        businessName: String = "Tienda Test",
        status: ClientOrderStatus = ClientOrderStatus.PENDING,
        createdAt: String = "2026-04-01T10:00:00Z",
        promisedAt: String? = null,
        total: Double = 1500.0,
        itemCount: Int = 3
    ) = ClientOrder(
        id = id,
        publicId = publicId,
        shortCode = shortCode,
        businessName = businessName,
        status = status,
        createdAt = createdAt,
        promisedAt = promisedAt,
        total = total,
        itemCount = itemCount
    )

    @Test
    fun `updateFromOrders crea notificaciones desde ordenes`() {
        val orders = listOf(
            sampleOrder()
        )

        ClientNotificationStore.updateFromOrders(orders)

        val notifications = ClientNotificationStore.notifications.value
        assertEquals(1, notifications.size)
        assertEquals("order-1_PENDING", notifications[0].id)
        assertEquals(NotificationEventType.ORDER_CREATED, notifications[0].eventType)
        assertFalse(notifications[0].isRead)
    }

    @Test
    fun `updateFromOrders no duplica notificaciones existentes`() {
        val orders = listOf(
            sampleOrder(status = ClientOrderStatus.CONFIRMED)
        )

        ClientNotificationStore.updateFromOrders(orders)
        ClientNotificationStore.updateFromOrders(orders)

        assertEquals(1, ClientNotificationStore.notifications.value.size)
    }

    @Test
    fun `updateFromOrders ordena por timestamp descendente`() {
        val orders = listOf(
            sampleOrder(
                id = "order-1",
                shortCode = "SC001",
                businessName = "Tienda A",
                status = ClientOrderStatus.PENDING,
                createdAt = "2026-04-01T08:00:00Z"
            ),
            sampleOrder(
                id = "order-2",
                publicId = "pub-2",
                shortCode = "SC002",
                businessName = "Tienda B",
                status = ClientOrderStatus.CONFIRMED,
                createdAt = "2026-04-01T12:00:00Z"
            )
        )

        ClientNotificationStore.updateFromOrders(orders)

        val notifications = ClientNotificationStore.notifications.value
        assertEquals(2, notifications.size)
        assertEquals("order-2_CONFIRMED", notifications[0].id)
        assertEquals("order-1_PENDING", notifications[1].id)
    }

    // --- addBusinessMessage ---

    @Test
    fun `addBusinessMessage agrega mensaje de negocio`() {
        ClientNotificationStore.addBusinessMessage(
            orderId = "order-1",
            shortCode = "SC001",
            businessName = "Tienda Test",
            message = "Tu pedido esta listo",
            timestamp = "2026-04-01T10:00:00Z"
        )

        val notifications = ClientNotificationStore.notifications.value
        assertEquals(1, notifications.size)
        assertEquals(NotificationEventType.BUSINESS_MESSAGE, notifications[0].eventType)
        assertEquals("Tu pedido esta listo", notifications[0].message)
    }

    @Test
    fun `addBusinessMessage no duplica mismo mensaje`() {
        ClientNotificationStore.addBusinessMessage(
            orderId = "order-1",
            shortCode = "SC001",
            businessName = "Tienda Test",
            message = "Tu pedido esta listo",
            timestamp = "2026-04-01T10:00:00Z"
        )
        ClientNotificationStore.addBusinessMessage(
            orderId = "order-1",
            shortCode = "SC001",
            businessName = "Tienda Test",
            message = "Tu pedido esta listo",
            timestamp = "2026-04-01T10:00:00Z"
        )

        assertEquals(1, ClientNotificationStore.notifications.value.size)
    }

    @Test
    fun `addBusinessMessage mensajes distintos se agregan por separado`() {
        ClientNotificationStore.addBusinessMessage(
            orderId = "order-1",
            shortCode = "SC001",
            businessName = "Tienda Test",
            message = "Mensaje 1",
            timestamp = "2026-04-01T10:00:00Z"
        )
        ClientNotificationStore.addBusinessMessage(
            orderId = "order-1",
            shortCode = "SC001",
            businessName = "Tienda Test",
            message = "Mensaje 2",
            timestamp = "2026-04-01T11:00:00Z"
        )

        assertEquals(2, ClientNotificationStore.notifications.value.size)
    }

    // --- markAsRead ---

    @Test
    fun `markAsRead marca notificacion como leida`() {
        ClientNotificationStore.addBusinessMessage(
            orderId = "order-1",
            shortCode = "SC001",
            businessName = "Test",
            message = "Hola",
            timestamp = "2026-04-01T10:00:00Z"
        )
        val id = ClientNotificationStore.notifications.value[0].id

        ClientNotificationStore.markAsRead(id)

        assertTrue(ClientNotificationStore.notifications.value[0].isRead)
    }

    @Test
    fun `markAsRead con id inexistente no cambia nada`() {
        ClientNotificationStore.addBusinessMessage(
            orderId = "order-1",
            shortCode = "SC001",
            businessName = "Test",
            message = "Hola",
            timestamp = "2026-04-01T10:00:00Z"
        )

        ClientNotificationStore.markAsRead("inexistente")

        assertFalse(ClientNotificationStore.notifications.value[0].isRead)
    }

    // --- markAllAsRead ---

    @Test
    fun `markAllAsRead marca todas las notificaciones como leidas`() {
        ClientNotificationStore.addBusinessMessage(
            orderId = "order-1", shortCode = "SC001",
            businessName = "Test", message = "Msg 1", timestamp = "2026-04-01T10:00:00Z"
        )
        ClientNotificationStore.addBusinessMessage(
            orderId = "order-2", shortCode = "SC002",
            businessName = "Test", message = "Msg 2", timestamp = "2026-04-01T11:00:00Z"
        )

        ClientNotificationStore.markAllAsRead()

        assertTrue(ClientNotificationStore.notifications.value.all { it.isRead })
    }

    // --- unreadCount ---

    @Test
    fun `unreadCount retorna cantidad correcta de no leidas`() {
        ClientNotificationStore.addBusinessMessage(
            orderId = "order-1", shortCode = "SC001",
            businessName = "Test", message = "Msg 1", timestamp = "2026-04-01T10:00:00Z"
        )
        ClientNotificationStore.addBusinessMessage(
            orderId = "order-2", shortCode = "SC002",
            businessName = "Test", message = "Msg 2", timestamp = "2026-04-01T11:00:00Z"
        )
        val firstId = ClientNotificationStore.notifications.value[0].id
        ClientNotificationStore.markAsRead(firstId)

        assertEquals(1, ClientNotificationStore.unreadCount)
    }

    @Test
    fun `unreadCount es cero cuando no hay notificaciones`() {
        assertEquals(0, ClientNotificationStore.unreadCount)
    }

    // --- clear ---

    @Test
    fun `clear vacia todas las notificaciones`() {
        ClientNotificationStore.addBusinessMessage(
            orderId = "order-1", shortCode = "SC001",
            businessName = "Test", message = "Msg", timestamp = "2026-04-01T10:00:00Z"
        )

        ClientNotificationStore.clear()

        assertTrue(ClientNotificationStore.notifications.value.isEmpty())
        assertEquals(0, ClientNotificationStore.unreadCount)
    }
}
