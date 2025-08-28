package ui.sc

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ReviewJoinBusinessViewModelTest {
    @Test
    fun `email requerido y valido`() {
        val vm = ReviewJoinBusinessViewModel()
        assertFalse(vm.isValid())
        vm.state = vm.state.copy(email = "correo@dominio.com")
        assertTrue(vm.isValid())
    }
}
