package ui.sc.business

import ar.com.intrale.shared.business.BusinessPaymentMethodDTO
import ar.com.intrale.shared.business.UpdateBusinessPaymentMethodsRequest
import asdo.business.ToDoGetBusinessPaymentMethods
import asdo.business.ToDoUpdateBusinessPaymentMethods
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private class FakeGetPaymentMethods(
    private val result: Result<List<BusinessPaymentMethodDTO>> = Result.success(fakePaymentMethods())
) : ToDoGetBusinessPaymentMethods {
    var calledWith: String? = null
    override suspend fun execute(businessId: String): Result<List<BusinessPaymentMethodDTO>> {
        calledWith = businessId
        return result
    }
}

private class FakeUpdatePaymentMethods(
    private val result: Result<List<BusinessPaymentMethodDTO>> = Result.success(fakePaymentMethods())
) : ToDoUpdateBusinessPaymentMethods {
    var calledWith: Pair<String, UpdateBusinessPaymentMethodsRequest>? = null
    override suspend fun execute(
        businessId: String,
        request: UpdateBusinessPaymentMethodsRequest
    ): Result<List<BusinessPaymentMethodDTO>> {
        calledWith = businessId to request
        return result
    }
}

private fun fakePaymentMethods() = listOf(
    BusinessPaymentMethodDTO(id = "cash", name = "Efectivo", type = "CASH", enabled = true, isCashOnDelivery = true),
    BusinessPaymentMethodDTO(id = "transfer", name = "Transferencia", type = "TRANSFER", enabled = false, isCashOnDelivery = false),
    BusinessPaymentMethodDTO(id = "mp", name = "Mercado Pago", type = "DIGITAL_WALLET", enabled = true, isCashOnDelivery = false)
)

class BusinessPaymentMethodsViewModelTest {

    @Test
    fun `loadPaymentMethods actualiza el estado con los medios de pago`() = runTest {
        val fake = FakeGetPaymentMethods()
        val viewModel = BusinessPaymentMethodsViewModel(
            toDoGetPaymentMethods = fake,
            toDoUpdatePaymentMethods = FakeUpdatePaymentMethods()
        )

        viewModel.loadPaymentMethods("biz-1")

        assertEquals("biz-1", fake.calledWith)
        assertEquals(3, viewModel.state.methods.size)
        assertEquals(BusinessPaymentMethodsStatus.Loaded, viewModel.state.status)
    }

    @Test
    fun `loadPaymentMethods con businessId nulo pone estado MissingBusiness`() = runTest {
        val viewModel = BusinessPaymentMethodsViewModel(
            toDoGetPaymentMethods = FakeGetPaymentMethods(),
            toDoUpdatePaymentMethods = FakeUpdatePaymentMethods()
        )

        viewModel.loadPaymentMethods(null)

        assertEquals(BusinessPaymentMethodsStatus.MissingBusiness, viewModel.state.status)
    }

    @Test
    fun `loadPaymentMethods con error pone estado Error`() = runTest {
        val fake = FakeGetPaymentMethods(Result.failure(Exception("Error de red")))
        val viewModel = BusinessPaymentMethodsViewModel(
            toDoGetPaymentMethods = fake,
            toDoUpdatePaymentMethods = FakeUpdatePaymentMethods()
        )

        viewModel.loadPaymentMethods("biz-1")

        assertTrue(viewModel.state.status is BusinessPaymentMethodsStatus.Error)
    }

    @Test
    fun `toggleMethod cambia el estado enabled del metodo`() = runTest {
        val viewModel = BusinessPaymentMethodsViewModel(
            toDoGetPaymentMethods = FakeGetPaymentMethods(),
            toDoUpdatePaymentMethods = FakeUpdatePaymentMethods()
        )
        viewModel.loadPaymentMethods("biz-1")

        val initialEnabled = viewModel.state.methods.first { it.id == "cash" }.enabled
        viewModel.toggleMethod("cash")
        val afterToggle = viewModel.state.methods.first { it.id == "cash" }.enabled

        assertFalse(afterToggle == initialEnabled)
    }

    @Test
    fun `savePaymentMethods guarda los cambios correctamente`() = runTest {
        val fakeUpdate = FakeUpdatePaymentMethods()
        val viewModel = BusinessPaymentMethodsViewModel(
            toDoGetPaymentMethods = FakeGetPaymentMethods(),
            toDoUpdatePaymentMethods = fakeUpdate
        )
        viewModel.loadPaymentMethods("biz-1")

        viewModel.savePaymentMethods("biz-1")

        assertEquals("biz-1", fakeUpdate.calledWith?.first)
        assertEquals(BusinessPaymentMethodsStatus.Saved, viewModel.state.status)
    }

    @Test
    fun `savePaymentMethods con businessId nulo retorna failure`() = runTest {
        val viewModel = BusinessPaymentMethodsViewModel(
            toDoGetPaymentMethods = FakeGetPaymentMethods(),
            toDoUpdatePaymentMethods = FakeUpdatePaymentMethods()
        )

        val result = viewModel.savePaymentMethods(null)

        assertTrue(result.isFailure)
        assertEquals(BusinessPaymentMethodsStatus.MissingBusiness, viewModel.state.status)
    }
}
