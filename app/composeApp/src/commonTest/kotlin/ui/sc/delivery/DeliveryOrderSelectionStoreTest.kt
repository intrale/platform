package ui.sc.delivery

import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class DeliveryOrderSelectionStoreTest {

    @BeforeTest
    fun setUp() {
        DeliveryOrderSelectionStore.clear()
    }

    @Test
    fun `select establece orderId y readOnly por defecto en false`() {
        DeliveryOrderSelectionStore.select("order-123")

        assertEquals("order-123", DeliveryOrderSelectionStore.selectedOrderId.value)
        assertFalse(DeliveryOrderSelectionStore.readOnly.value)
    }

    @Test
    fun `select con readOnly true establece ambos valores`() {
        DeliveryOrderSelectionStore.select("order-456", readOnly = true)

        assertEquals("order-456", DeliveryOrderSelectionStore.selectedOrderId.value)
        assertTrue(DeliveryOrderSelectionStore.readOnly.value)
    }

    @Test
    fun `clear resetea orderId y readOnly`() {
        DeliveryOrderSelectionStore.select("order-789", readOnly = true)

        DeliveryOrderSelectionStore.clear()

        assertNull(DeliveryOrderSelectionStore.selectedOrderId.value)
        assertFalse(DeliveryOrderSelectionStore.readOnly.value)
    }

    @Test
    fun `select reemplaza seleccion anterior`() {
        DeliveryOrderSelectionStore.select("order-1")
        DeliveryOrderSelectionStore.select("order-2")

        assertEquals("order-2", DeliveryOrderSelectionStore.selectedOrderId.value)
    }

    @Test
    fun `estado inicial es null y false`() {
        assertNull(DeliveryOrderSelectionStore.selectedOrderId.value)
        assertFalse(DeliveryOrderSelectionStore.readOnly.value)
    }
}
