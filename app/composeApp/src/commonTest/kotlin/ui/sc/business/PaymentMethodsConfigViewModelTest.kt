package ui.sc.business

import ar.com.intrale.shared.business.BusinessPaymentMethodDTO
import ar.com.intrale.shared.business.UpdatePaymentMethodsRequest
import asdo.business.ToDoGetBusinessPaymentMethods
import asdo.business.ToDoUpdateBusinessPaymentMethods
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend

private val testLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

private val defaultMethods = listOf(
    BusinessPaymentMethodDTO(id = "cash", name = "Efectivo", type = "CASH", enabled = true, isCashOnDelivery = true),
    BusinessPaymentMethodDTO(id = "transfer", name = "Transferencia", type = "TRANSFER", enabled = false),
    BusinessPaymentMethodDTO(id = "mercadopago", name = "Mercado Pago", type = "DIGITAL_WALLET", enabled = false)
)

private class FakeGetBusinessPaymentMethods(
    private val result: Result<List<BusinessPaymentMethodDTO>>
) : ToDoGetBusinessPaymentMethods {
    override suspend fun execute(): Result<List<BusinessPaymentMethodDTO>> = result
}

private class FakeUpdateBusinessPaymentMethods(
    private val result: Result<List<BusinessPaymentMethodDTO>>
) : ToDoUpdateBusinessPaymentMethods {
    var lastRequest: UpdatePaymentMethodsRequest? = null
    override suspend fun execute(request: UpdatePaymentMethodsRequest): Result<List<BusinessPaymentMethodDTO>> {
        lastRequest = request
        return result
    }
}

class PaymentMethodsConfigViewModelTest {

    @Test
    fun `loadPaymentMethods actualiza estado con metodos cargados`() = runTest {
        val getUseCase = FakeGetBusinessPaymentMethods(Result.success(defaultMethods))
        val updateUseCase = FakeUpdateBusinessPaymentMethods(Result.success(defaultMethods))
        val viewModel = PaymentMethodsConfigViewModel(getUseCase, updateUseCase, testLoggerFactory)

        viewModel.loadPaymentMethods("biz")

        assertEquals(PaymentMethodsConfigStatus.Loaded, viewModel.state.status)
        assertEquals(3, viewModel.state.methods.size)
        assertTrue(viewModel.state.methods.first { it.id == "cash" }.enabled)
        assertFalse(viewModel.state.methods.first { it.id == "transfer" }.enabled)
    }

    @Test
    fun `loadPaymentMethods con businessId vacio pasa a estado MissingBusiness`() = runTest {
        val getUseCase = FakeGetBusinessPaymentMethods(Result.success(defaultMethods))
        val updateUseCase = FakeUpdateBusinessPaymentMethods(Result.success(defaultMethods))
        val viewModel = PaymentMethodsConfigViewModel(getUseCase, updateUseCase, testLoggerFactory)

        viewModel.loadPaymentMethods(null)

        assertEquals(PaymentMethodsConfigStatus.MissingBusiness, viewModel.state.status)
    }

    @Test
    fun `loadPaymentMethods con error pasa a estado Error`() = runTest {
        val getUseCase = FakeGetBusinessPaymentMethods(Result.failure(RuntimeException("Error de red")))
        val updateUseCase = FakeUpdateBusinessPaymentMethods(Result.success(defaultMethods))
        val viewModel = PaymentMethodsConfigViewModel(getUseCase, updateUseCase, testLoggerFactory)

        viewModel.loadPaymentMethods("biz")

        assertTrue(viewModel.state.status is PaymentMethodsConfigStatus.Error)
    }

    @Test
    fun `togglePaymentMethod activa un metodo deshabilitado`() = runTest {
        val getUseCase = FakeGetBusinessPaymentMethods(Result.success(defaultMethods))
        val updateUseCase = FakeUpdateBusinessPaymentMethods(Result.success(defaultMethods))
        val viewModel = PaymentMethodsConfigViewModel(getUseCase, updateUseCase, testLoggerFactory)
        viewModel.loadPaymentMethods("biz")

        viewModel.togglePaymentMethod("transfer", true)

        assertTrue(viewModel.state.methods.first { it.id == "transfer" }.enabled)
    }

    @Test
    fun `togglePaymentMethod desactiva un metodo habilitado`() = runTest {
        val getUseCase = FakeGetBusinessPaymentMethods(Result.success(defaultMethods))
        val updateUseCase = FakeUpdateBusinessPaymentMethods(Result.success(defaultMethods))
        val viewModel = PaymentMethodsConfigViewModel(getUseCase, updateUseCase, testLoggerFactory)
        viewModel.loadPaymentMethods("biz")

        viewModel.togglePaymentMethod("cash", false)

        assertFalse(viewModel.state.methods.first { it.id == "cash" }.enabled)
    }

    @Test
    fun `savePaymentMethods envía request con metodos actuales`() = runTest {
        val updatedMethods = defaultMethods.map {
            if (it.id == "mercadopago") it.copy(enabled = true) else it
        }
        val getUseCase = FakeGetBusinessPaymentMethods(Result.success(defaultMethods))
        val updateUseCase = FakeUpdateBusinessPaymentMethods(Result.success(updatedMethods))
        val viewModel = PaymentMethodsConfigViewModel(getUseCase, updateUseCase, testLoggerFactory)
        viewModel.loadPaymentMethods("biz")
        viewModel.togglePaymentMethod("mercadopago", true)

        viewModel.savePaymentMethods("biz")

        assertEquals(PaymentMethodsConfigStatus.Saved, viewModel.state.status)
        val sentRequest = updateUseCase.lastRequest
        assertTrue(sentRequest?.paymentMethods?.first { it.id == "mercadopago" }?.enabled == true)
    }

    @Test
    fun `savePaymentMethods con businessId vacio retorna fallo`() = runTest {
        val getUseCase = FakeGetBusinessPaymentMethods(Result.success(defaultMethods))
        val updateUseCase = FakeUpdateBusinessPaymentMethods(Result.success(defaultMethods))
        val viewModel = PaymentMethodsConfigViewModel(getUseCase, updateUseCase, testLoggerFactory)

        val result = viewModel.savePaymentMethods(null)

        assertTrue(result.isFailure)
        assertEquals(PaymentMethodsConfigStatus.MissingBusiness, viewModel.state.status)
    }
}
