package ui.session

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class SessionStoreTest {

    @Test
    fun `updateRole actualiza el rol del usuario`() {
        SessionStore.clear()

        SessionStore.updateRole(UserRole.Delivery)

        assertEquals(UserRole.Delivery, SessionStore.sessionState.value.role)
    }

    @Test
    fun `updateSelectedBusiness actualiza el negocio seleccionado`() {
        SessionStore.clear()

        SessionStore.updateSelectedBusiness("business-123")

        assertEquals("business-123", SessionStore.sessionState.value.selectedBusinessId)
    }

    @Test
    fun `clear resetea el estado`() {
        SessionStore.updateRole(UserRole.Client)
        SessionStore.updateSelectedBusiness("business-456")

        SessionStore.clear()

        assertNull(SessionStore.sessionState.value.role)
        assertNull(SessionStore.sessionState.value.selectedBusinessId)
    }
}
