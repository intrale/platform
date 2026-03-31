package ui.sc.business

import asdo.business.BusinessOrder
import asdo.business.BusinessOrderStatus
import asdo.business.OrderSoundConfig
import asdo.business.OrderSoundType
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class BusinessOrderNotificationStoreTest {

    @BeforeTest
    fun setup() {
        BusinessOrderNotificationStore.clear()
    }

    @Test
    fun `processOrders detecta pedidos nuevos PENDING`() {
        val orders = listOf(
            sampleOrder("order-1", BusinessOrderStatus.PENDING),
            sampleOrder("order-2", BusinessOrderStatus.CONFIRMED)
        )

        val newOrders = BusinessOrderNotificationStore.processOrders(orders)

        assertEquals(1, newOrders.size)
        assertEquals("order-1", newOrders[0].id)
        assertTrue(BusinessOrderNotificationStore.hasActiveAlerts)
    }

    @Test
    fun `processOrders no re-alerta pedidos ya conocidos`() {
        val orders = listOf(sampleOrder("order-1", BusinessOrderStatus.PENDING))
        BusinessOrderNotificationStore.processOrders(orders)

        // Segunda vez con los mismos pedidos
        val newOrders = BusinessOrderNotificationStore.processOrders(orders)

        assertEquals(0, newOrders.size)
    }

    @Test
    fun `dismissAlert remueve alerta especifica`() {
        val orders = listOf(
            sampleOrder("order-1", BusinessOrderStatus.PENDING),
            sampleOrder("order-2", BusinessOrderStatus.PENDING)
        )
        BusinessOrderNotificationStore.processOrders(orders)

        BusinessOrderNotificationStore.dismissAlert("order-1")

        val alerts = BusinessOrderNotificationStore.activeAlerts.value
        assertEquals(1, alerts.size)
        assertEquals("order-2", alerts[0].orderId)
    }

    @Test
    fun `dismissAllAlerts limpia todas las alertas`() {
        val orders = listOf(
            sampleOrder("order-1", BusinessOrderStatus.PENDING),
            sampleOrder("order-2", BusinessOrderStatus.PENDING)
        )
        BusinessOrderNotificationStore.processOrders(orders)

        BusinessOrderNotificationStore.dismissAllAlerts()

        assertFalse(BusinessOrderNotificationStore.hasActiveAlerts)
    }

    @Test
    fun `toggleMute cambia estado de silencio`() {
        assertFalse(BusinessOrderNotificationStore.config.value.isMuted)

        BusinessOrderNotificationStore.toggleMute()
        assertTrue(BusinessOrderNotificationStore.config.value.isMuted)

        BusinessOrderNotificationStore.toggleMute()
        assertFalse(BusinessOrderNotificationStore.config.value.isMuted)
    }

    @Test
    fun `updateVolume respeta limites`() {
        BusinessOrderNotificationStore.updateVolume(1.5f)
        assertEquals(OrderSoundConfig.MAX_VOLUME, BusinessOrderNotificationStore.config.value.volume)

        BusinessOrderNotificationStore.updateVolume(-0.5f)
        assertEquals(OrderSoundConfig.MIN_VOLUME, BusinessOrderNotificationStore.config.value.volume)
    }

    @Test
    fun `updateSoundType cambia tipo de sonido`() {
        BusinessOrderNotificationStore.updateSoundType(OrderSoundType.URGENT)
        assertEquals(OrderSoundType.URGENT, BusinessOrderNotificationStore.config.value.soundType)
    }

    @Test
    fun `shouldPlaySound devuelve false cuando esta silenciado`() {
        val orders = listOf(sampleOrder("order-1", BusinessOrderStatus.PENDING))
        BusinessOrderNotificationStore.processOrders(orders)

        BusinessOrderNotificationStore.toggleMute()

        assertFalse(BusinessOrderNotificationStore.shouldPlaySound)
    }

    @Test
    fun `shouldPlaySound devuelve false cuando esta deshabilitado`() {
        val orders = listOf(sampleOrder("order-1", BusinessOrderStatus.PENDING))
        BusinessOrderNotificationStore.processOrders(orders)

        BusinessOrderNotificationStore.toggleEnabled()

        assertFalse(BusinessOrderNotificationStore.shouldPlaySound)
    }

    @Test
    fun `shouldPlaySound devuelve true con alertas activas y config habilitada`() {
        val orders = listOf(sampleOrder("order-1", BusinessOrderStatus.PENDING))
        BusinessOrderNotificationStore.processOrders(orders)

        assertTrue(BusinessOrderNotificationStore.shouldPlaySound)
    }

    @Test
    fun `alertas se remueven cuando el pedido ya no esta PENDING`() {
        val orders = listOf(sampleOrder("order-1", BusinessOrderStatus.PENDING))
        BusinessOrderNotificationStore.processOrders(orders)
        assertTrue(BusinessOrderNotificationStore.hasActiveAlerts)

        // El pedido ahora esta CONFIRMED
        val updatedOrders = listOf(sampleOrder("order-1", BusinessOrderStatus.CONFIRMED))
        BusinessOrderNotificationStore.processOrders(updatedOrders)

        assertFalse(BusinessOrderNotificationStore.hasActiveAlerts)
    }

    @Test
    fun `clear limpia todo el estado`() {
        val orders = listOf(sampleOrder("order-1", BusinessOrderStatus.PENDING))
        BusinessOrderNotificationStore.processOrders(orders)
        BusinessOrderNotificationStore.toggleMute()

        BusinessOrderNotificationStore.clear()

        assertFalse(BusinessOrderNotificationStore.hasActiveAlerts)
        assertFalse(BusinessOrderNotificationStore.config.value.isMuted)
    }

    private fun sampleOrder(id: String, status: BusinessOrderStatus) = BusinessOrder(
        id = id,
        shortCode = id.take(6).uppercase(),
        clientEmail = "test@example.com",
        status = status,
        total = 100.0,
        createdAt = "2026-03-31T10:00:00Z"
    )
}
