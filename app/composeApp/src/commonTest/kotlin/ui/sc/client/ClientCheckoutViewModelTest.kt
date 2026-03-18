package ui.sc.client

import asdo.client.CreateOrderInput
import asdo.client.CreateOrderOutput
import asdo.client.ToDoCreateOrder
import asdo.client.ClientAddress
import asdo.client.ClientPreferences
import asdo.client.ClientProfile
import asdo.client.ClientProfileData
import asdo.client.ToDoGetClientProfile
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private class FakeCreateOrder(
    private val result: Result<CreateOrderOutput> = Result.success(
        CreateOrderOutput(
            orderId = "ord-1",
            shortCode = "ABC123",
            status = "PENDING",
            total = 200.0
        )
    )
) : ToDoCreateOrder {
    override suspend fun execute(request: CreateOrderInput): Result<CreateOrderOutput> = result
}

private class FakeGetClientProfileForCheckout(
    private val result: Result<ClientProfileData> = Result.success(
        ClientProfileData(
            profile = ClientProfile(fullName = "Test User", email = "test@test.com"),
            addresses = listOf(
                ClientAddress(id = "addr-1", label = "Casa", street = "Calle", number = "123", city = "CABA", isDefault = true)
            ),
            preferences = ClientPreferences(language = "es")
        )
    )
) : ToDoGetClientProfile {
    override suspend fun execute(): Result<ClientProfileData> = result
}

class ClientCheckoutViewModelTest {

    @Test
    fun `selectPaymentMethod actualiza el estado correctamente`() = runTest {
        val viewModel = ClientCheckoutViewModel(
            createOrder = FakeCreateOrder(),
            getClientProfile = FakeGetClientProfileForCheckout()
        )

        assertEquals("cash", viewModel.state.selectedPaymentMethod)

        viewModel.selectPaymentMethod("transfer")
        assertEquals("transfer", viewModel.state.selectedPaymentMethod)
    }

    @Test
    fun `updateNotes actualiza el estado correctamente`() = runTest {
        val viewModel = ClientCheckoutViewModel(
            createOrder = FakeCreateOrder(),
            getClientProfile = FakeGetClientProfileForCheckout()
        )

        assertEquals("", viewModel.state.notes)

        viewModel.updateNotes("Sin cebolla")
        assertEquals("Sin cebolla", viewModel.state.notes)
    }

    @Test
    fun `selectAddress actualiza el estado correctamente`() = runTest {
        val viewModel = ClientCheckoutViewModel(
            createOrder = FakeCreateOrder(),
            getClientProfile = FakeGetClientProfileForCheckout()
        )

        viewModel.selectAddress("addr-2")
        assertEquals("addr-2", viewModel.state.selectedAddressId)
        assertNull(viewModel.state.error)
    }

    @Test
    fun `loadAddresses carga las direcciones del perfil`() = runTest {
        val viewModel = ClientCheckoutViewModel(
            createOrder = FakeCreateOrder(),
            getClientProfile = FakeGetClientProfileForCheckout()
        )

        viewModel.loadAddresses()

        assertFalse(viewModel.state.addressLoading)
        assertEquals(1, viewModel.state.addresses.size)
        assertEquals("addr-1", viewModel.state.selectedAddressId)
    }

    @Test
    fun `loadAddresses con error actualiza el estado con mensaje`() = runTest {
        val viewModel = ClientCheckoutViewModel(
            createOrder = FakeCreateOrder(),
            getClientProfile = FakeGetClientProfileForCheckout(
                result = Result.failure(RuntimeException("Error de red"))
            )
        )

        viewModel.loadAddresses()

        assertFalse(viewModel.state.addressLoading)
        assertNotNull(viewModel.state.error)
    }

    @Test
    fun `confirmOrder con carrito vacio retorna false con error`() = runTest {
        val viewModel = ClientCheckoutViewModel(
            createOrder = FakeCreateOrder(),
            getClientProfile = FakeGetClientProfileForCheckout()
        )

        // El carrito está vacío por defecto (no llamamos loadCartData con items)
        val result = viewModel.confirmOrder()

        assertFalse(result)
        assertEquals("empty_cart", viewModel.state.error)
    }

    @Test
    fun `confirmOrder exitoso con items retorna true y limpia carrito`() = runTest {
        // Pre-cargar un item en el store
        val product = ClientProduct(
            id = "prod-1",
            name = "Producto A",
            priceLabel = "$100.00",
            emoji = "A",
            unitPrice = 100.0
        )
        ClientCartStore.clear()
        ClientCartStore.add(product)
        ClientCartStore.add(product)

        val viewModel = ClientCheckoutViewModel(
            createOrder = FakeCreateOrder(),
            getClientProfile = FakeGetClientProfileForCheckout()
        )
        viewModel.loadCartData()

        val result = viewModel.confirmOrder()

        assertTrue(result)
        assertNotNull(viewModel.state.orderResult)
        assertEquals("ABC123", viewModel.state.orderResult?.shortCode)
        assertFalse(viewModel.state.submitting)
        assertNull(viewModel.state.error)

        // Verificar que el carrito fue vaciado
        assertTrue(ClientCartStore.items.value.isEmpty())
    }

    @Test
    fun `confirmOrder fallido retorna false con error`() = runTest {
        val product = ClientProduct(
            id = "prod-2",
            name = "Producto B",
            priceLabel = "$50.00",
            emoji = "B",
            unitPrice = 50.0
        )
        ClientCartStore.clear()
        ClientCartStore.add(product)

        val viewModel = ClientCheckoutViewModel(
            createOrder = FakeCreateOrder(
                result = Result.failure(RuntimeException("Error del servidor"))
            ),
            getClientProfile = FakeGetClientProfileForCheckout()
        )
        viewModel.loadCartData()

        val result = viewModel.confirmOrder()

        assertFalse(result)
        assertNull(viewModel.state.orderResult)
        assertFalse(viewModel.state.submitting)
        assertNotNull(viewModel.state.error)

        // Limpiar
        ClientCartStore.clear()
    }
}
