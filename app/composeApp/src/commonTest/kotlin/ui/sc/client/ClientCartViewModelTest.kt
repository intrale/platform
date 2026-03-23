package ui.sc.client

import asdo.client.ClientAddress
import asdo.client.ClientProfileData
import asdo.client.PaymentMethod
import asdo.client.PaymentMethodType
import asdo.client.ToDoGetClientProfile
import asdo.client.ToDoGetPaymentMethods
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend

private val testLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

private val sampleAddresses = listOf(
    ClientAddress(id = "addr-1", label = "Casa", street = "Av. Siempre Viva", number = "742", isDefault = true),
    ClientAddress(id = "addr-2", label = "Trabajo", street = "Calle Falsa", number = "123", isDefault = false)
)

private val sampleProfileData = ClientProfileData(
    addresses = sampleAddresses
)

private val samplePaymentMethods = listOf(
    PaymentMethod(id = "pm-efectivo", name = "Efectivo", type = PaymentMethodType.CASH, description = null, isCashOnDelivery = true, enabled = true),
    PaymentMethod(id = "pm-transferencia", name = "Transferencia", type = PaymentMethodType.TRANSFER, description = "CBU/Alias", isCashOnDelivery = false, enabled = true),
    PaymentMethod(id = "pm-disabled", name = "Deshabilitado", type = PaymentMethodType.CARD, description = null, isCashOnDelivery = false, enabled = false)
)

private class FakeGetClientProfile(
    private val result: Result<ClientProfileData> = Result.success(sampleProfileData)
) : ToDoGetClientProfile {
    override suspend fun execute(): Result<ClientProfileData> = result
}

private class FakeGetPaymentMethods(
    private val result: Result<List<PaymentMethod>> = Result.success(samplePaymentMethods)
) : ToDoGetPaymentMethods {
    override suspend fun execute(): Result<List<PaymentMethod>> = result
}

class ClientCartViewModelTest {

    @BeforeTest
    fun setUp() {
        ClientCartStore.clear()
    }

    // region loadAddresses

    @Test
    fun `loadAddresses exitoso carga las direcciones en el estado`() = runTest {
        val viewModel = ClientCartViewModel(
            getClientProfile = FakeGetClientProfile(),
            getPaymentMethods = FakeGetPaymentMethods(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadAddresses()

        assertEquals(2, viewModel.state.addresses.size)
        assertFalse(viewModel.state.loading)
        assertNull(viewModel.state.error)
    }

    @Test
    fun `loadAddresses selecciona la direccion predeterminada`() = runTest {
        val viewModel = ClientCartViewModel(
            getClientProfile = FakeGetClientProfile(),
            getPaymentMethods = FakeGetPaymentMethods(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadAddresses()

        assertEquals("addr-1", viewModel.state.selectedAddressId)
    }

    @Test
    fun `loadAddresses actualiza el store con la direccion seleccionada`() = runTest {
        val viewModel = ClientCartViewModel(
            getClientProfile = FakeGetClientProfile(),
            getPaymentMethods = FakeGetPaymentMethods(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadAddresses()

        assertEquals("addr-1", ClientCartStore.selectedAddressId.value)
    }

    @Test
    fun `loadAddresses con error guarda el mensaje de error`() = runTest {
        val viewModel = ClientCartViewModel(
            getClientProfile = FakeGetClientProfile(Result.failure(Exception("Sin conexión"))),
            getPaymentMethods = FakeGetPaymentMethods(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadAddresses()

        assertFalse(viewModel.state.loading)
        assertNotNull(viewModel.state.error)
        assertTrue(viewModel.state.addresses.isEmpty())
    }

    // endregion

    // region loadPaymentMethods

    @Test
    fun `loadPaymentMethods carga solo los metodos habilitados`() = runTest {
        val viewModel = ClientCartViewModel(
            getClientProfile = FakeGetClientProfile(),
            getPaymentMethods = FakeGetPaymentMethods(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadPaymentMethods()

        assertEquals(2, viewModel.state.paymentMethods.size)
        assertTrue(viewModel.state.paymentMethods.all { it.enabled })
    }

    @Test
    fun `loadPaymentMethods selecciona el primer metodo habilitado`() = runTest {
        val viewModel = ClientCartViewModel(
            getClientProfile = FakeGetClientProfile(),
            getPaymentMethods = FakeGetPaymentMethods(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadPaymentMethods()

        assertEquals("pm-efectivo", viewModel.state.selectedPaymentMethodId)
    }

    @Test
    fun `loadPaymentMethods actualiza el store con el metodo seleccionado`() = runTest {
        val viewModel = ClientCartViewModel(
            getClientProfile = FakeGetClientProfile(),
            getPaymentMethods = FakeGetPaymentMethods(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadPaymentMethods()

        assertEquals("pm-efectivo", ClientCartStore.selectedPaymentMethodId.value)
    }

    @Test
    fun `loadPaymentMethods con error actualiza el estado de carga`() = runTest {
        val viewModel = ClientCartViewModel(
            getClientProfile = FakeGetClientProfile(),
            getPaymentMethods = FakeGetPaymentMethods(Result.failure(Exception("Error de red"))),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadPaymentMethods()

        assertFalse(viewModel.state.loadingPaymentMethods)
        assertNotNull(viewModel.state.error)
    }

    @Test
    fun `loadPaymentMethods sin metodos habilitados deja selectedPaymentMethodId nulo`() = runTest {
        val allDisabled = samplePaymentMethods.map { it.copy(enabled = false) }
        val viewModel = ClientCartViewModel(
            getClientProfile = FakeGetClientProfile(),
            getPaymentMethods = FakeGetPaymentMethods(Result.success(allDisabled)),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadPaymentMethods()

        assertTrue(viewModel.state.paymentMethods.isEmpty())
        assertNull(viewModel.state.selectedPaymentMethodId)
    }

    // endregion

    // region selectAddress / selectPaymentMethod

    @Test
    fun `selectAddress actualiza el estado y el store`() = runTest {
        val viewModel = ClientCartViewModel(
            getClientProfile = FakeGetClientProfile(),
            getPaymentMethods = FakeGetPaymentMethods(),
            loggerFactory = testLoggerFactory
        )
        viewModel.loadAddresses()

        viewModel.selectAddress("addr-2")

        assertEquals("addr-2", viewModel.state.selectedAddressId)
        assertEquals("addr-2", ClientCartStore.selectedAddressId.value)
        assertNull(viewModel.state.error)
    }

    @Test
    fun `selectPaymentMethod actualiza el estado y el store`() = runTest {
        val viewModel = ClientCartViewModel(
            getClientProfile = FakeGetClientProfile(),
            getPaymentMethods = FakeGetPaymentMethods(),
            loggerFactory = testLoggerFactory
        )
        viewModel.loadPaymentMethods()

        viewModel.selectPaymentMethod("pm-transferencia")

        assertEquals("pm-transferencia", viewModel.state.selectedPaymentMethodId)
        assertEquals("pm-transferencia", ClientCartStore.selectedPaymentMethodId.value)
        assertNull(viewModel.state.error)
    }

    // endregion
}
