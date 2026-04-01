package ui.sc.client

import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ClientProductSelectionStoreTest {

    @BeforeTest
    fun setUp() {
        ClientProductSelectionStore.clear()
    }

    @Test
    fun `select establece el producto seleccionado`() {
        ClientProductSelectionStore.select("prod-1")

        assertEquals("prod-1", ClientProductSelectionStore.selectedProductId.value)
    }

    @Test
    fun `select reemplaza seleccion anterior`() {
        ClientProductSelectionStore.select("prod-1")
        ClientProductSelectionStore.select("prod-2")

        assertEquals("prod-2", ClientProductSelectionStore.selectedProductId.value)
    }

    @Test
    fun `clear limpia la seleccion`() {
        ClientProductSelectionStore.select("prod-1")

        ClientProductSelectionStore.clear()

        assertNull(ClientProductSelectionStore.selectedProductId.value)
    }

    @Test
    fun `clear sin seleccion previa no causa error`() {
        ClientProductSelectionStore.clear()

        assertNull(ClientProductSelectionStore.selectedProductId.value)
    }
}
