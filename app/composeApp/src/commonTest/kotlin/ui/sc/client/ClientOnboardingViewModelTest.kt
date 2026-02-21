package ui.sc.client

import ext.storage.CommKeyValueStorage
import ext.storage.model.ClientProfileCache
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private class FakeKeyValueStorage(
    override var token: String? = null,
    override var profileCache: ClientProfileCache? = null,
    override var preferredLanguage: String? = null,
    override var onboardingCompleted: Boolean = false,
) : CommKeyValueStorage

class ClientOnboardingViewModelTest {

    @Test
    fun `onboardingCompleted retorna false cuando no fue completado`() {
        val storage = FakeKeyValueStorage(onboardingCompleted = false)
        val viewModel = ClientOnboardingViewModel(storage = storage)

        assertFalse(viewModel.isOnboardingCompleted)
    }

    @Test
    fun `completeOnboarding marca flag y actualiza estado`() {
        val storage = FakeKeyValueStorage(onboardingCompleted = false)
        val viewModel = ClientOnboardingViewModel(storage = storage)

        viewModel.completeOnboarding()

        assertTrue(storage.onboardingCompleted)
        assertTrue(viewModel.state.completed)
    }

    @Test
    fun `nextPage avanza a la siguiente pagina`() {
        val storage = FakeKeyValueStorage()
        val viewModel = ClientOnboardingViewModel(storage = storage)

        assertEquals(0, viewModel.state.currentPage)

        viewModel.nextPage()

        assertEquals(1, viewModel.state.currentPage)
    }

    @Test
    fun `nextPage no avanza mas alla de la ultima pagina`() {
        val storage = FakeKeyValueStorage()
        val viewModel = ClientOnboardingViewModel(storage = storage)

        repeat(10) { viewModel.nextPage() }

        assertEquals(viewModel.state.totalPages - 1, viewModel.state.currentPage)
    }

    @Test
    fun `onPageChange actualiza la pagina actual`() {
        val storage = FakeKeyValueStorage()
        val viewModel = ClientOnboardingViewModel(storage = storage)

        viewModel.onPageChange(2)

        assertEquals(2, viewModel.state.currentPage)
    }
}
