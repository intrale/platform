package ui.sc.delivery

import kotlin.test.AfterTest
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

    @AfterTest
    fun cleanup() {
        DeliveryOrderSelectionStore.clear()
    }

    @Test
    fun `estado inicial es null y false`() {
        assertNull(DeliveryOrderSelectionStore.selectedOrderId.value)
        assertFalse(DeliveryOrderSelectionStore.readOnly.value)
    }

    @Test
    fun `select almacena orderId y readOnly`() {
        DeliveryOrderSelectionStore.select("order1", readOnly = true)
        assertEquals("order1", DeliveryOrderSelectionStore.selectedOrderId.value)
        assertEquals(true, DeliveryOrderSelectionStore.readOnly.value)
    }

    @Test
    fun `select sin readOnly usa false por defecto`() {
        DeliveryOrderSelectionStore.select("order2")
        assertEquals("order2", DeliveryOrderSelectionStore.selectedOrderId.value)
        assertFalse(DeliveryOrderSelectionStore.readOnly.value)
    }

    @Test
    fun `clear limpia seleccion y readOnly`() {
        DeliveryOrderSelectionStore.select("order1", readOnly = true)
        DeliveryOrderSelectionStore.clear()
        assertNull(DeliveryOrderSelectionStore.selectedOrderId.value)
        assertFalse(DeliveryOrderSelectionStore.readOnly.value)
    }

    @Test
    fun `select reemplaza seleccion anterior`() {
        DeliveryOrderSelectionStore.select("order1", readOnly = true)
        DeliveryOrderSelectionStore.select("order2", readOnly = false)

        assertEquals("order2", DeliveryOrderSelectionStore.selectedOrderId.value)
        assertFalse(DeliveryOrderSelectionStore.readOnly.value)
    }
}
