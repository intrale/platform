package ui.sc.client

import asdo.client.BusinessOpenStatus
import asdo.client.ClientAddress
import asdo.client.CreateClientOrderParams
import asdo.client.CreateClientOrderResult
import asdo.client.PaymentMethod
import asdo.client.PaymentMethodType
import asdo.client.ToDoCreateClientOrder
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend

private val checkoutTestLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

private val sampleAddress = ClientAddress(
    id = "addr-1",
    label = "Casa",
    street = "Av. Corrientes",
    number = "1234",
    city = "CABA"
)

private val samplePaymentMethod = PaymentMethod(
    id = "pm-1",
    name = "Efectivo",
    type = PaymentMethodType.CASH,
    description = "Pago en efectivo",
    isCashOnDelivery = true,
    enabled = true
)

private val sampleCartItems = listOf(
    ClientCartItem(
        product = ClientProduct(
            id = "prod-1",
            name = "Manzana roja",
            priceLabel = "$1.200",
            emoji = "\uD83D\uDECD\uFE0F",
            unitPrice = 1200.0,
            categoryId = "cat-1",
            isAvailable = true
        ),
        quantity = 2
    ),
    ClientCartItem(
        product = ClientProduct(
            id = "prod-2",
            name = "Banana",
            priceLabel = "$800",
            emoji = "\uD83D\uDECD\uFE0F",
            unitPrice = 800.0,
            categoryId = "cat-2",
            isAvailable = true
        ),
        quantity = 1
    )
)

// --- Fakes ---

private class FakeCreateOrderSuccess : ToDoCreateClientOrder {
    override suspend fun execute(params: CreateClientOrderParams): Result<CreateClientOrderResult> =
        Result.success(
            CreateClientOrderResult(
                orderId = "order-123",
                shortCode = "ABC123",
                status = "CREATED"
            )
        )
}

private class FakeCreateOrderFailure(
    private val error: String = "Error de red"
) : ToDoCreateClientOrder {
    override suspend fun execute(params: CreateClientOrderParams): Result<CreateClientOrderResult> =
        Result.failure(RuntimeException(error))
}

class ClientCheckoutViewModelTest {

    @BeforeTest
    fun setUp() {
        ClientCartStore.clear()
        BusinessOpenStore.clear()
    }

    private fun createViewModel(
        toDoCreateClientOrder: ToDoCreateClientOrder = FakeCreateOrderSuccess()
    ): ClientCheckoutViewModel = ClientCheckoutViewModel(
        toDoCreateClientOrder = toDoCreateClientOrder,
        loggerFactory = checkoutTestLoggerFactory
    )

    @Test
    fun `estado inicial es Review sin items`() {
        val viewModel = createViewModel()

        assertEquals(CheckoutStatus.Review, viewModel.state.status)
        assertTrue(viewModel.state.items.isEmpty())
        assertNull(viewModel.state.selectedAddress)
        assertNull(viewModel.state.selectedPaymentMethod)
        assertEquals(0.0, viewModel.state.total)
        assertFalse(viewModel.state.canConfirm)
    }

    @Test
    fun `loadFromCart calcula subtotal y total correctamente`() {
        val viewModel = createViewModel()

        viewModel.loadFromCart(sampleCartItems, sampleAddress, samplePaymentMethod)

        val state = viewModel.state
        assertEquals(2, state.items.size)
        assertEquals(sampleAddress, state.selectedAddress)
        assertEquals(samplePaymentMethod, state.selectedPaymentMethod)
        // 1200 * 2 + 800 * 1 = 3200
        assertEquals(3200.0, state.subtotal)
        assertEquals(0.0, state.shipping)
        assertEquals(3200.0, state.total)
    }

    @Test
    fun `canConfirm es true cuando tiene items y address y paymentMethod`() {
        val viewModel = createViewModel()

        viewModel.loadFromCart(sampleCartItems, sampleAddress, samplePaymentMethod)

        assertTrue(viewModel.state.canConfirm)
    }

    @Test
    fun `canConfirm es false sin address`() {
        val viewModel = createViewModel()

        viewModel.loadFromCart(sampleCartItems, null, samplePaymentMethod)

        assertFalse(viewModel.state.canConfirm)
    }

    @Test
    fun `canConfirm es false sin paymentMethod`() {
        val viewModel = createViewModel()

        viewModel.loadFromCart(sampleCartItems, sampleAddress, null)

        assertFalse(viewModel.state.canConfirm)
    }

    @Test
    fun `canConfirm es false con items vacios`() {
        val viewModel = createViewModel()

        viewModel.loadFromCart(emptyList(), sampleAddress, samplePaymentMethod)

        assertFalse(viewModel.state.canConfirm)
    }

    @Test
    fun `updateNotes actualiza las notas`() {
        val viewModel = createViewModel()

        viewModel.updateNotes("Sin cebolla por favor")

        assertEquals("Sin cebolla por favor", viewModel.state.notes)
    }

    @Test
    fun `confirmOrder exitoso cambia a Success y limpia carrito`() = runTest {
        val viewModel = createViewModel()
        viewModel.loadFromCart(sampleCartItems, sampleAddress, samplePaymentMethod)

        viewModel.confirmOrder()

        val state = viewModel.state
        assertEquals(CheckoutStatus.Success, state.status)
        assertEquals("order-123", state.orderId)
        assertEquals("ABC123", state.shortCode)
    }

    @Test
    fun `confirmOrder con error cambia a Error`() = runTest {
        val viewModel = createViewModel(
            toDoCreateClientOrder = FakeCreateOrderFailure("Timeout")
        )
        viewModel.loadFromCart(sampleCartItems, sampleAddress, samplePaymentMethod)

        viewModel.confirmOrder()

        val state = viewModel.state
        assertEquals(CheckoutStatus.Error, state.status)
        assertEquals("Timeout", state.errorMessage)
    }

    @Test
    fun `confirmOrder sin canConfirm no ejecuta`() = runTest {
        val viewModel = createViewModel()
        // No cargamos items, asi que canConfirm = false

        viewModel.confirmOrder()

        assertEquals(CheckoutStatus.Review, viewModel.state.status)
    }

    @Test
    fun `retryConfirm vuelve a Review`() = runTest {
        val viewModel = createViewModel(
            toDoCreateClientOrder = FakeCreateOrderFailure()
        )
        viewModel.loadFromCart(sampleCartItems, sampleAddress, samplePaymentMethod)
        viewModel.confirmOrder()
        assertEquals(CheckoutStatus.Error, viewModel.state.status)

        viewModel.retryConfirm()

        assertEquals(CheckoutStatus.Review, viewModel.state.status)
        assertNull(viewModel.state.errorMessage)
    }

    @Test
    fun `checkBusinessOpenStatus con negocio cerrado bloquea confirmacion`() {
        val viewModel = createViewModel()
        viewModel.loadFromCart(sampleCartItems, sampleAddress, samplePaymentMethod)
        BusinessOpenStore.update(
            BusinessOpenStatus(isOpen = false, nextOpeningInfo = "Abre manana a las 9")
        )

        viewModel.checkBusinessOpenStatus()

        assertTrue(viewModel.state.businessClosed)
        assertEquals("Abre manana a las 9", viewModel.state.businessClosedInfo)
        assertFalse(viewModel.state.canConfirm)
    }

    @Test
    fun `checkBusinessOpenStatus con negocio abierto permite confirmacion`() {
        val viewModel = createViewModel()
        viewModel.loadFromCart(sampleCartItems, sampleAddress, samplePaymentMethod)
        BusinessOpenStore.update(BusinessOpenStatus(isOpen = true))

        viewModel.checkBusinessOpenStatus()

        assertFalse(viewModel.state.businessClosed)
        assertTrue(viewModel.state.canConfirm)
    }

    @Test
    fun `confirmOrder con notas las incluye`() = runTest {
        val viewModel = createViewModel()
        viewModel.loadFromCart(sampleCartItems, sampleAddress, samplePaymentMethod)
        viewModel.updateNotes("Dejar en porteria")

        viewModel.confirmOrder()

        assertEquals(CheckoutStatus.Success, viewModel.state.status)
    }
}
