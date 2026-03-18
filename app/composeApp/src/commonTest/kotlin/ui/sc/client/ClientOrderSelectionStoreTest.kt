package ui.sc.client

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ClientOrderSelectionStoreTest {

    @Test
    fun `select guarda el orderId seleccionado`() {
        ClientOrderSelectionStore.clear()

        ClientOrderSelectionStore.select("ord-123")

        assertEquals("ord-123", ClientOrderSelectionStore.selectedOrderId.value)
    }

    @Test
    fun `clear limpia la seleccion`() {
        ClientOrderSelectionStore.select("ord-456")

        ClientOrderSelectionStore.clear()

        assertNull(ClientOrderSelectionStore.selectedOrderId.value)
    }

    @Test
    fun `select reemplaza la seleccion anterior`() {
        ClientOrderSelectionStore.select("ord-1")
        ClientOrderSelectionStore.select("ord-2")

        assertEquals("ord-2", ClientOrderSelectionStore.selectedOrderId.value)
    }
}
