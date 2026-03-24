package asdo.delivery

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class DeliveryOrderStatusTransitionTest {

    // region nextStatus — transiciones secuenciales

    @Test
    fun `ASSIGNED avanza a HEADING_TO_BUSINESS`() {
        assertEquals(DeliveryOrderStatus.HEADING_TO_BUSINESS, DeliveryOrderStatus.ASSIGNED.nextStatus())
    }

    @Test
    fun `HEADING_TO_BUSINESS avanza a AT_BUSINESS`() {
        assertEquals(DeliveryOrderStatus.AT_BUSINESS, DeliveryOrderStatus.HEADING_TO_BUSINESS.nextStatus())
    }

    @Test
    fun `AT_BUSINESS avanza a HEADING_TO_CLIENT`() {
        assertEquals(DeliveryOrderStatus.HEADING_TO_CLIENT, DeliveryOrderStatus.AT_BUSINESS.nextStatus())
    }

    @Test
    fun `HEADING_TO_CLIENT avanza a DELIVERED`() {
        assertEquals(DeliveryOrderStatus.DELIVERED, DeliveryOrderStatus.HEADING_TO_CLIENT.nextStatus())
    }

    @Test
    fun `DELIVERED no tiene siguiente estado`() {
        assertNull(DeliveryOrderStatus.DELIVERED.nextStatus())
    }

    @Test
    fun `NOT_DELIVERED no tiene siguiente estado`() {
        assertNull(DeliveryOrderStatus.NOT_DELIVERED.nextStatus())
    }

    @Test
    fun `UNKNOWN no tiene siguiente estado`() {
        assertNull(DeliveryOrderStatus.UNKNOWN.nextStatus())
    }

    // endregion

    // region canAdvance

    @Test
    fun `canAdvance es true para estados intermedios`() {
        assertTrue(DeliveryOrderStatus.ASSIGNED.canAdvance())
        assertTrue(DeliveryOrderStatus.HEADING_TO_BUSINESS.canAdvance())
        assertTrue(DeliveryOrderStatus.AT_BUSINESS.canAdvance())
        assertTrue(DeliveryOrderStatus.HEADING_TO_CLIENT.canAdvance())
    }

    @Test
    fun `canAdvance es false para estados finales`() {
        assertFalse(DeliveryOrderStatus.DELIVERED.canAdvance())
        assertFalse(DeliveryOrderStatus.NOT_DELIVERED.canAdvance())
        assertFalse(DeliveryOrderStatus.UNKNOWN.canAdvance())
    }

    // endregion

    // region canMarkNotDelivered

    @Test
    fun `canMarkNotDelivered es true para estados no finales`() {
        assertTrue(DeliveryOrderStatus.ASSIGNED.canMarkNotDelivered())
        assertTrue(DeliveryOrderStatus.HEADING_TO_BUSINESS.canMarkNotDelivered())
        assertTrue(DeliveryOrderStatus.AT_BUSINESS.canMarkNotDelivered())
        assertTrue(DeliveryOrderStatus.HEADING_TO_CLIENT.canMarkNotDelivered())
    }

    @Test
    fun `canMarkNotDelivered es false para estados finales`() {
        assertFalse(DeliveryOrderStatus.DELIVERED.canMarkNotDelivered())
        assertFalse(DeliveryOrderStatus.NOT_DELIVERED.canMarkNotDelivered())
        assertFalse(DeliveryOrderStatus.UNKNOWN.canMarkNotDelivered())
    }

    // endregion

    // region isFinal

    @Test
    fun `isFinal es true solo para DELIVERED y NOT_DELIVERED`() {
        assertTrue(DeliveryOrderStatus.DELIVERED.isFinal())
        assertTrue(DeliveryOrderStatus.NOT_DELIVERED.isFinal())
    }

    @Test
    fun `isFinal es false para estados intermedios`() {
        assertFalse(DeliveryOrderStatus.ASSIGNED.isFinal())
        assertFalse(DeliveryOrderStatus.HEADING_TO_BUSINESS.isFinal())
        assertFalse(DeliveryOrderStatus.AT_BUSINESS.isFinal())
        assertFalse(DeliveryOrderStatus.HEADING_TO_CLIENT.isFinal())
    }

    // endregion

    // region stepIndex

    @Test
    fun `stepIndex retorna indices secuenciales correctos`() {
        assertEquals(0, DeliveryOrderStatus.ASSIGNED.stepIndex())
        assertEquals(1, DeliveryOrderStatus.HEADING_TO_BUSINESS.stepIndex())
        assertEquals(2, DeliveryOrderStatus.AT_BUSINESS.stepIndex())
        assertEquals(3, DeliveryOrderStatus.HEADING_TO_CLIENT.stepIndex())
        assertEquals(4, DeliveryOrderStatus.DELIVERED.stepIndex())
        assertEquals(5, DeliveryOrderStatus.NOT_DELIVERED.stepIndex())
        assertEquals(-1, DeliveryOrderStatus.UNKNOWN.stepIndex())
    }

    // endregion

    // region DELIVERY_SEQUENCE

    @Test
    fun `DELIVERY_SEQUENCE contiene 5 estados en orden`() {
        val sequence = DeliveryOrderStatus.DELIVERY_SEQUENCE
        assertEquals(5, sequence.size)
        assertEquals(DeliveryOrderStatus.ASSIGNED, sequence[0])
        assertEquals(DeliveryOrderStatus.HEADING_TO_BUSINESS, sequence[1])
        assertEquals(DeliveryOrderStatus.AT_BUSINESS, sequence[2])
        assertEquals(DeliveryOrderStatus.HEADING_TO_CLIENT, sequence[3])
        assertEquals(DeliveryOrderStatus.DELIVERED, sequence[4])
    }

    // endregion

    // region toDeliveryOrderStatus — mapeo de strings

    @Test
    fun `mapeo de string assigned a ASSIGNED`() {
        assertEquals(DeliveryOrderStatus.ASSIGNED, "assigned".toDeliveryOrderStatus())
    }

    @Test
    fun `mapeo de string pending a ASSIGNED por compatibilidad`() {
        assertEquals(DeliveryOrderStatus.ASSIGNED, "pending".toDeliveryOrderStatus())
    }

    @Test
    fun `mapeo de string heading_to_business a HEADING_TO_BUSINESS`() {
        assertEquals(DeliveryOrderStatus.HEADING_TO_BUSINESS, "heading_to_business".toDeliveryOrderStatus())
    }

    @Test
    fun `mapeo de string at_business a AT_BUSINESS`() {
        assertEquals(DeliveryOrderStatus.AT_BUSINESS, "at_business".toDeliveryOrderStatus())
    }

    @Test
    fun `mapeo de string picked_up a AT_BUSINESS por compatibilidad`() {
        assertEquals(DeliveryOrderStatus.AT_BUSINESS, "picked_up".toDeliveryOrderStatus())
    }

    @Test
    fun `mapeo de string heading_to_client a HEADING_TO_CLIENT`() {
        assertEquals(DeliveryOrderStatus.HEADING_TO_CLIENT, "heading_to_client".toDeliveryOrderStatus())
    }

    @Test
    fun `mapeo de string in_transit a HEADING_TO_CLIENT por compatibilidad`() {
        assertEquals(DeliveryOrderStatus.HEADING_TO_CLIENT, "in_transit".toDeliveryOrderStatus())
    }

    @Test
    fun `mapeo de string delivered a DELIVERED`() {
        assertEquals(DeliveryOrderStatus.DELIVERED, "delivered".toDeliveryOrderStatus())
    }

    @Test
    fun `mapeo de string not_delivered a NOT_DELIVERED`() {
        assertEquals(DeliveryOrderStatus.NOT_DELIVERED, "not_delivered".toDeliveryOrderStatus())
    }

    @Test
    fun `mapeo de string desconocido a UNKNOWN`() {
        assertEquals(DeliveryOrderStatus.UNKNOWN, "xyz_invalid".toDeliveryOrderStatus())
    }

    // endregion

    // region toApiString — serialización

    @Test
    fun `toApiString serializa correctamente todos los estados`() {
        assertEquals("assigned", DeliveryOrderStatus.ASSIGNED.toApiString())
        assertEquals("heading_to_business", DeliveryOrderStatus.HEADING_TO_BUSINESS.toApiString())
        assertEquals("at_business", DeliveryOrderStatus.AT_BUSINESS.toApiString())
        assertEquals("heading_to_client", DeliveryOrderStatus.HEADING_TO_CLIENT.toApiString())
        assertEquals("delivered", DeliveryOrderStatus.DELIVERED.toApiString())
        assertEquals("not_delivered", DeliveryOrderStatus.NOT_DELIVERED.toApiString())
        assertEquals("unknown", DeliveryOrderStatus.UNKNOWN.toApiString())
    }

    // endregion

    // region DeliveryStatusHistoryEntry

    @Test
    fun `historial de estados registra timestamp y razon`() {
        val entry = DeliveryStatusHistoryEntry(
            status = DeliveryOrderStatus.NOT_DELIVERED,
            timestamp = "2026-03-24T14:30:00",
            reason = "absent"
        )
        assertEquals(DeliveryOrderStatus.NOT_DELIVERED, entry.status)
        assertEquals("2026-03-24T14:30:00", entry.timestamp)
        assertEquals("absent", entry.reason)
    }

    @Test
    fun `historial sin razon tiene reason null`() {
        val entry = DeliveryStatusHistoryEntry(
            status = DeliveryOrderStatus.AT_BUSINESS,
            timestamp = "2026-03-24T14:30:00"
        )
        assertNull(entry.reason)
    }

    // endregion
}
