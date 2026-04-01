package asdo.delivery

import ar.com.intrale.shared.delivery.DeliveryStateChangeResponse
import kotlin.test.Test
import kotlin.test.assertEquals

class DeliveryStateModelsTest {

    @Test
    fun `toDeliveryState mapea pending correctamente`() {
        assertEquals(DeliveryState.PENDING, "pending".toDeliveryState())
    }

    @Test
    fun `toDeliveryState mapea picked_up correctamente`() {
        assertEquals(DeliveryState.PICKED_UP, "picked_up".toDeliveryState())
    }

    @Test
    fun `toDeliveryState mapea pickedup correctamente`() {
        assertEquals(DeliveryState.PICKED_UP, "pickedup".toDeliveryState())
    }

    @Test
    fun `toDeliveryState mapea in_transit correctamente`() {
        assertEquals(DeliveryState.IN_TRANSIT, "in_transit".toDeliveryState())
    }

    @Test
    fun `toDeliveryState mapea intransit correctamente`() {
        assertEquals(DeliveryState.IN_TRANSIT, "intransit".toDeliveryState())
    }

    @Test
    fun `toDeliveryState mapea delivered correctamente`() {
        assertEquals(DeliveryState.DELIVERED, "delivered".toDeliveryState())
    }

    @Test
    fun `toDeliveryState mapea cancelled correctamente`() {
        assertEquals(DeliveryState.CANCELLED, "cancelled".toDeliveryState())
    }

    @Test
    fun `toDeliveryState retorna PENDING como fallback para valor desconocido`() {
        assertEquals(DeliveryState.PENDING, "unknown_state".toDeliveryState())
    }

    @Test
    fun `toApiString mapea todos los estados`() {
        assertEquals("pending", DeliveryState.PENDING.toApiString())
        assertEquals("picked_up", DeliveryState.PICKED_UP.toApiString())
        assertEquals("in_transit", DeliveryState.IN_TRANSIT.toApiString())
        assertEquals("delivered", DeliveryState.DELIVERED.toApiString())
        assertEquals("cancelled", DeliveryState.CANCELLED.toApiString())
    }

    @Test
    fun `DeliveryStateChangeResponse toDomain mapea correctamente`() {
        val response = DeliveryStateChangeResponse(
            orderId = "order-123",
            state = "delivered"
        )
        val result = response.toDomain()
        assertEquals("order-123", result.orderId)
        assertEquals(DeliveryState.DELIVERED, result.newState)
    }
}
