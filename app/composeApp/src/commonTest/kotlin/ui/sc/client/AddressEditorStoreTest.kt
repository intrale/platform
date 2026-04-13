package ui.sc.client

import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class AddressEditorStoreTest {

    @BeforeTest
    fun setUp() {
        AddressEditorStore.clear()
    }

    @Test
    fun `setDraft establece borrador de direccion`() {
        val draft = AddressDraft(
            label = "Casa",
            street = "Av. Corrientes",
            number = "1234",
            city = "Buenos Aires"
        )

        AddressEditorStore.setDraft(draft)

        assertNotNull(AddressEditorStore.draft.value)
        assertEquals("Casa", AddressEditorStore.draft.value?.label)
        assertEquals("Av. Corrientes", AddressEditorStore.draft.value?.street)
    }

    @Test
    fun `setDraft con null limpia el borrador`() {
        AddressEditorStore.setDraft(AddressDraft(label = "Casa"))

        AddressEditorStore.setDraft(null)

        assertNull(AddressEditorStore.draft.value)
    }

    @Test
    fun `update transforma el borrador existente`() {
        AddressEditorStore.setDraft(AddressDraft(label = "Casa", street = "Calle vieja"))

        AddressEditorStore.update { it?.copy(street = "Calle nueva") }

        assertEquals("Calle nueva", AddressEditorStore.draft.value?.street)
        assertEquals("Casa", AddressEditorStore.draft.value?.label)
    }

    @Test
    fun `update con borrador null retorna null`() {
        AddressEditorStore.update { it?.copy(street = "Algo") }

        assertNull(AddressEditorStore.draft.value)
    }

    @Test
    fun `clear limpia el borrador`() {
        AddressEditorStore.setDraft(AddressDraft(label = "Oficina"))

        AddressEditorStore.clear()

        assertNull(AddressEditorStore.draft.value)
    }

    @Test
    fun `clear sin borrador previo no causa error`() {
        AddressEditorStore.clear()

        assertNull(AddressEditorStore.draft.value)
    }

    @Test
    fun `setDraft reemplaza borrador existente`() {
        AddressEditorStore.setDraft(AddressDraft(label = "Casa"))
        AddressEditorStore.setDraft(AddressDraft(label = "Oficina"))

        assertEquals("Oficina", AddressEditorStore.draft.value?.label)
    }
}
