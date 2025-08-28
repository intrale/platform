package ui.sc

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class RequestJoinBusinessViewModelTest {
    @Test
    fun `business requerido`() {
        val vm = RequestJoinBusinessViewModel()
        assertFalse(vm.isValid())
        vm.state = vm.state.copy(business = "intrale")
        assertTrue(vm.isValid())
    }
}
