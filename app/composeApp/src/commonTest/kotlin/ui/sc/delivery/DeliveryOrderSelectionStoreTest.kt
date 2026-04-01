package ui.sc.delivery

import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class DeliveryOrderSelectionStoreTest {

    @AfterTest
    fun cleanup() {
        DeliveryOrderSelectionStore.clear()
    }

    @Test
    fun `selectedOrderId inicia en null`() {
        assertNull(DeliveryOrderSelectionStore.selectedOrderId.value)
    }

    @Test
    fun `readOnly inicia en false`() {
        assertFalse(DeliveryOrderSelectionStore.readOnly.value)
    }

    @Test
    fun `select establece orderId y readOnly false por defecto`() {
        DeliveryOrderSelectionStore.select("order123")

        assertEquals("order123", DeliveryOrderSelectionStore.selectedOrderId.value)
        assertFalse(DeliveryOrderSelectionStore.readOnly.value)
    }

    @Test
    fun `select con readOnly true establece ambos valores`() {
        DeliveryOrderSelectionStore.select("order456", readOnly = true)

        assertEquals("order456", DeliveryOrderSelectionStore.selectedOrderId.value)
        assertTrue(DeliveryOrderSelectionStore.readOnly.value)
    }

    @Test
    fun `clear resetea selectedOrderId y readOnly`() {
        DeliveryOrderSelectionStore.select("order789", readOnly = true)

        DeliveryOrderSelectionStore.clear()

        assertNull(DeliveryOrderSelectionStore.selectedOrderId.value)
        assertFalse(DeliveryOrderSelectionStore.readOnly.value)
    }

    @Test
    fun `select reemplaza seleccion previa`() {
        DeliveryOrderSelectionStore.select("order1", readOnly = true)
        DeliveryOrderSelectionStore.select("order2", readOnly = false)

        assertEquals("order2", DeliveryOrderSelectionStore.selectedOrderId.value)
        assertFalse(DeliveryOrderSelectionStore.readOnly.value)
    }
}
