package ui.sc.client

import asdo.client.BusinessOpenStatus
import asdo.client.ClientAddress
import asdo.client.CreateClientOrderParams
import asdo.client.CreateClientOrderResult
import asdo.client.PaymentMethod
import asdo.client.PaymentMethodType
import asdo.client.ToDoCreateClientOrder
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

// region Fakes

private class FakeCreateClientOrder(
    private val result: Result<CreateClientOrderResult> = Result.success(
        CreateClientOrderResult(orderId = "ord-99", shortCode = "XYZ123", status = "PENDING")
    )
) : ToDoCreateClientOrder {
    var lastParams: CreateClientOrderParams? = null
    override suspend fun execute(params: CreateClientOrderParams): Result<CreateClientOrderResult> {
        lastParams = params
        return result
    }
}

// endregion

// region Datos de prueba

private val sampleProduct = ClientProduct(
    id = "prod-1", name = "Producto A", priceLabel = "$100",
    emoji = "🍕", unitPrice = 100.0
)
private val sampleProduct2 = ClientProduct(
    id = "prod-2", name = "Producto B", priceLabel = "$50",
    emoji = "🍔", unitPrice = 50.0
)
private val sampleAddress = ClientAddress(
    id = "addr-1", label = "Casa", street = "Av. Siempreviva",
    number = "742", city = "Springfield"
)
private val samplePaymentMethod = PaymentMethod(
    id = "pm-1", name = "Efectivo", type = PaymentMethodType.CASH,
    description = "Pago en efectivo", isCashOnDelivery = true, enabled = true
)
private val sampleCartItems = listOf(
    ClientCartItem(product = sampleProduct, quantity = 2),
    ClientCartItem(product = sampleProduct2, quantity = 1)
)

// endregion

class ClientCheckoutViewModelTest {

    private fun createViewModel(
        fakeCreate: FakeCreateClientOrder = FakeCreateClientOrder()
    ) = ClientCheckoutViewModel(
        toDoCreateClientOrder = fakeCreate,
        loggerFactory = LoggerFactory.default
    )

    @Test
    fun `estado inicial tiene status Review y listas vacias`() {
        val vm = createViewModel()

        assertEquals(CheckoutStatus.Review, vm.state.status)
        assertTrue(vm.state.items.isEmpty())
        assertNull(vm.state.selectedAddress)
        assertNull(vm.state.selectedPaymentMethod)
        assertEquals(0.0, vm.state.subtotal)
        assertEquals(0.0, vm.state.total)
        assertFalse(vm.state.canConfirm)
    }

    @Test
    fun `loadFromCart carga items y calcula subtotal`() {
        val vm = createViewModel()

        vm.loadFromCart(sampleCartItems, sampleAddress, samplePaymentMethod)

        assertEquals(2, vm.state.items.size)
        assertEquals(sampleAddress, vm.state.selectedAddress)
        assertEquals(samplePaymentMethod, vm.state.selectedPaymentMethod)
        // subtotal = (100 * 2) + (50 * 1) = 250
        assertEquals(250.0, vm.state.subtotal)
        assertEquals(250.0, vm.state.total)
    }

    @Test
    fun `canConfirm es true con items y direccion y metodo de pago`() {
        val vm = createViewModel()
        vm.loadFromCart(sampleCartItems, sampleAddress, samplePaymentMethod)

        assertTrue(vm.state.canConfirm)
    }

    @Test
    fun `canConfirm es false sin direccion`() {
        val vm = createViewModel()
        vm.loadFromCart(sampleCartItems, null, samplePaymentMethod)

        assertFalse(vm.state.canConfirm)
    }

    @Test
    fun `canConfirm es false sin metodo de pago`() {
        val vm = createViewModel()
        vm.loadFromCart(sampleCartItems, sampleAddress, null)

        assertFalse(vm.state.canConfirm)
    }

    @Test
    fun `canConfirm es false con items vacios`() {
        val vm = createViewModel()
        vm.loadFromCart(emptyList(), sampleAddress, samplePaymentMethod)

        assertFalse(vm.state.canConfirm)
    }

    @Test
    fun `updateNotes actualiza las notas`() {
        val vm = createViewModel()

        vm.updateNotes("Sin cebolla por favor")

        assertEquals("Sin cebolla por favor", vm.state.notes)
    }

    @Test
    fun `confirmOrder exitoso actualiza status a Success`() = runTest {
        val fake = FakeCreateClientOrder()
        val vm = createViewModel(fake)
        vm.loadFromCart(sampleCartItems, sampleAddress, samplePaymentMethod)
        vm.updateNotes("Extra salsa")

        vm.confirmOrder()

        assertEquals(CheckoutStatus.Success, vm.state.status)
        assertEquals("ord-99", vm.state.orderId)
        assertEquals("XYZ123", vm.state.shortCode)
        // Verifica que los params se pasaron correctamente
        val params = fake.lastParams!!
        assertEquals(2, params.items.size)
        assertEquals("prod-1", params.items[0].productId)
        assertEquals(2, params.items[0].quantity)
        assertEquals("addr-1", params.addressId)
        assertEquals("pm-1", params.paymentMethodId)
        assertEquals("Extra salsa", params.notes)
    }

    @Test
    fun `confirmOrder fallido actualiza status a Error con mensaje`() = runTest {
        val fake = FakeCreateClientOrder(
            result = Result.failure(RuntimeException("Timeout de red"))
        )
        val vm = createViewModel(fake)
        vm.loadFromCart(sampleCartItems, sampleAddress, samplePaymentMethod)

        vm.confirmOrder()

        assertEquals(CheckoutStatus.Error, vm.state.status)
        assertEquals("Timeout de red", vm.state.errorMessage)
    }

    @Test
    fun `confirmOrder no ejecuta si canConfirm es false`() = runTest {
        val fake = FakeCreateClientOrder()
        val vm = createViewModel(fake)
        // No cargar items → canConfirm = false

        vm.confirmOrder()

        assertEquals(CheckoutStatus.Review, vm.state.status)
        assertNull(fake.lastParams)
    }

    @Test
    fun `confirmOrder con notas vacias envia null`() = runTest {
        val fake = FakeCreateClientOrder()
        val vm = createViewModel(fake)
        vm.loadFromCart(sampleCartItems, sampleAddress, samplePaymentMethod)
        vm.updateNotes("")

        vm.confirmOrder()

        assertNull(fake.lastParams!!.notes)
    }

    @Test
    fun `retryConfirm resetea status a Review`() {
        val vm = createViewModel()
        vm.loadFromCart(sampleCartItems, sampleAddress, samplePaymentMethod)

        vm.retryConfirm()

        assertEquals(CheckoutStatus.Review, vm.state.status)
        assertNull(vm.state.errorMessage)
    }

    @Test
    fun `checkBusinessOpenStatus bloquea cuando negocio cerrado`() {
        val vm = createViewModel()
        vm.loadFromCart(sampleCartItems, sampleAddress, samplePaymentMethod)

        // Simular negocio cerrado
        BusinessOpenStore.update(BusinessOpenStatus(isOpen = false, nextOpeningInfo = "Abre manana a las 09:00"))

        vm.checkBusinessOpenStatus()

        assertTrue(vm.state.businessClosed)
        assertEquals("Abre manana a las 09:00", vm.state.businessClosedInfo)
        assertFalse(vm.state.canConfirm) // canConfirm = false cuando businessClosed

        // Limpiar estado global
        BusinessOpenStore.clear()
    }

    @Test
    fun `checkBusinessOpenStatus desbloquea cuando negocio abierto`() {
        val vm = createViewModel()
        vm.loadFromCart(sampleCartItems, sampleAddress, samplePaymentMethod)

        // Simular negocio abierto
        BusinessOpenStore.update(BusinessOpenStatus(isOpen = true))

        vm.checkBusinessOpenStatus()

        assertFalse(vm.state.businessClosed)
        assertEquals("", vm.state.businessClosedInfo)
        assertTrue(vm.state.canConfirm)

        // Limpiar estado global
        BusinessOpenStore.clear()
    }

    @Test
    fun `checkBusinessOpenStatus sin estado mantiene desbloqueado`() {
        val vm = createViewModel()
        vm.loadFromCart(sampleCartItems, sampleAddress, samplePaymentMethod)

        // Estado null = no verificado
        BusinessOpenStore.clear()

        vm.checkBusinessOpenStatus()

        assertFalse(vm.state.businessClosed)
        assertTrue(vm.state.canConfirm)
    }
}
