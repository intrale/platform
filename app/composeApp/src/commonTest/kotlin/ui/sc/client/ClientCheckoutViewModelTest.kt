package ui.sc.client

import asdo.client.BusinessOpenStatus
import asdo.client.ClientAddress
import asdo.client.CreateClientOrderParams
import asdo.client.CreateClientOrderResult
import asdo.client.DoCheckAddressResult
import asdo.client.PaymentMethod
import asdo.client.PaymentMethodType
import asdo.client.ToDoCheckAddress
import asdo.client.ToDoCreateClientOrder
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

private val checkoutTestLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

private val sampleAddress = ClientAddress(
    id = "addr-1",
    label = "Casa",
    street = "Av. Corrientes",
    number = "1234",
    city = "CABA"
)

private val sampleAddressOtra = ClientAddress(
    id = "addr-2",
    label = "Oficina",
    street = "Av. Cordoba",
    number = "5678",
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
            emoji = "🛍️",
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
            emoji = "🛍️",
            unitPrice = 800.0,
            categoryId = "cat-2",
            isAvailable = true
        ),
        quantity = 1
    )
)

private val zoneCheckNorte = DoCheckAddressResult(
    businessId = "biz-1",
    addressId = "addr-1",
    lat = -34.6,
    lng = -58.4,
    zoneId = "zone-norte",
    zoneName = "Zona Norte",
    shippingCost = 500.0
)

private val zoneCheckSur = DoCheckAddressResult(
    businessId = "biz-1",
    addressId = "addr-2",
    lat = -34.7,
    lng = -58.5,
    zoneId = "zone-sur",
    zoneName = "Zona Sur",
    shippingCost = 800.0
)

private val zoneCheckGratis = DoCheckAddressResult(
    businessId = "biz-1",
    addressId = "addr-1",
    lat = -34.6,
    lng = -58.4,
    zoneId = "zone-promo",
    zoneName = "Zona Promo",
    shippingCost = 0.0
)

private val zoneCheckSinZonas = DoCheckAddressResult(
    businessId = "biz-1",
    addressId = "addr-1",
    lat = -34.6,
    lng = -58.4,
    zoneId = null,
    zoneName = null,
    shippingCost = null
)

// --- Fakes ---

private class FakeCreateOrderSuccess(
    private val responseShippingCost: Double? = null,
    private val responseZoneName: String? = null
) : ToDoCreateClientOrder {
    var lastParams: CreateClientOrderParams? = null
        private set

    override suspend fun execute(params: CreateClientOrderParams): Result<CreateClientOrderResult> {
        lastParams = params
        return Result.success(
            CreateClientOrderResult(
                orderId = "order-123",
                shortCode = "ABC123",
                status = "CREATED",
                shippingCost = responseShippingCost,
                zoneName = responseZoneName
            )
        )
    }
}

private class FakeCreateOrderFailure(
    private val error: String = "Error de red"
) : ToDoCreateClientOrder {
    override suspend fun execute(params: CreateClientOrderParams): Result<CreateClientOrderResult> =
        Result.failure(RuntimeException(error))
}

private class FakeCheckAddress(
    private val result: Result<DoCheckAddressResult> = Result.success(zoneCheckSur)
) : ToDoCheckAddress {
    var callCount = 0
        private set

    override suspend fun execute(
        businessId: String,
        addressId: String?,
        lat: Double,
        lng: Double
    ): Result<DoCheckAddressResult> {
        callCount += 1
        return result
    }
}

class ClientCheckoutViewModelTest {

    @BeforeTest
    fun setUp() {
        ClientCartStore.clear()
        BusinessOpenStore.clear()
    }

    private fun createViewModel(
        toDoCreateClientOrder: ToDoCreateClientOrder = FakeCreateOrderSuccess(),
        toDoCheckAddress: ToDoCheckAddress? = null
    ): ClientCheckoutViewModel = ClientCheckoutViewModel(
        toDoCreateClientOrder = toDoCreateClientOrder,
        toDoCheckAddress = toDoCheckAddress,
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
    fun `total suma subtotal mas shippingCost de la zona`() {
        // Issue #2424 CA-2 / CA-3 — desglose con shippingCost de la verificacion.
        val viewModel = createViewModel()

        viewModel.loadFromCart(sampleCartItems, sampleAddress, samplePaymentMethod, zoneCheckNorte)

        val state = viewModel.state
        // 1200 * 2 + 800 * 1 = 3200 subtotal
        assertEquals(3200.0, state.subtotal)
        assertEquals(500.0, state.shipping)
        // Total = subtotal + shipping = 3700
        assertEquals(3700.0, state.total)
        assertEquals("Zona Norte", state.zoneName)
        assertEquals("zone-norte", state.zoneId)
        assertTrue(state.shippingCostKnown)
        assertTrue(state.showShippingRow)
        assertFalse(state.isFreeShipping)
    }

    @Test
    fun `cambio de direccion vuelve a consultar zones-check y recalcula total`() = runTest {
        // Issue #2424 CA-6 — recalculo on-change de direccion.
        val fakeCheck = FakeCheckAddress(Result.success(zoneCheckSur))
        val viewModel = createViewModel(toDoCheckAddress = fakeCheck)
        viewModel.loadFromCart(sampleCartItems, sampleAddress, samplePaymentMethod, zoneCheckNorte)

        // Estado inicial: zona Norte con shipping 500.
        assertEquals(500.0, viewModel.state.shipping)
        assertEquals(3700.0, viewModel.state.total)

        viewModel.changeAddress(sampleAddressOtra)

        // Verifica que se llamo al servicio de check-address.
        assertEquals(1, fakeCheck.callCount)
        // Estado actualizado: zona Sur con shipping 800.
        val state = viewModel.state
        assertEquals(sampleAddressOtra, state.selectedAddress)
        assertEquals(800.0, state.shipping)
        assertEquals(4000.0, state.total) // 3200 + 800
        assertEquals("Zona Sur", state.zoneName)
        assertEquals("zone-sur", state.zoneId)
        assertFalse(state.recalculatingShipping)
    }

    @Test
    fun `checkout muestra envio gratis cuando shippingCost es cero`() {
        // Issue #2424 CA-4 — shippingCost == 0 distinto de null/ausente.
        val viewModel = createViewModel()

        viewModel.loadFromCart(sampleCartItems, sampleAddress, samplePaymentMethod, zoneCheckGratis)

        val state = viewModel.state
        assertEquals(0.0, state.shipping)
        // El subtotal sigue siendo 3200, total tambien.
        assertEquals(3200.0, state.subtotal)
        assertEquals(3200.0, state.total)
        assertTrue(state.shippingCostKnown)
        assertTrue(state.showShippingRow) // Se renderiza la fila con "Envio gratis"
        assertTrue(state.isFreeShipping)   // CA-4: muestra "Envio gratis", NO "$0"
    }

    @Test
    fun `negocio sin zonas no renderiza fila de envio`() {
        // Issue #2424 CA-5 — shippingCost == null deshabilita el flujo.
        val viewModel = createViewModel()

        viewModel.loadFromCart(sampleCartItems, sampleAddress, samplePaymentMethod, zoneCheckSinZonas)

        val state = viewModel.state
        assertEquals(0.0, state.shipping)
        assertEquals(3200.0, state.total) // Total = subtotal
        assertFalse(state.shippingCostKnown)
        assertFalse(state.showShippingRow) // CA-5: NO se renderiza la fila
        assertFalse(state.isFreeShipping)
    }

    @Test
    fun `submit de orden no envia shippingCost del cliente como valor de confianza`() = runTest {
        // Issue #2424 CA-8 — tamper-proofing OWASP A04.
        // El DTO de request NUNCA debe contener un campo `shippingCost` ni el VM
        // debe declarar uno en CreateClientOrderParams.
        val fakeCreate = FakeCreateOrderSuccess(responseShippingCost = 500.0, responseZoneName = "Zona Norte")
        val viewModel = createViewModel(toDoCreateClientOrder = fakeCreate)
        viewModel.loadFromCart(sampleCartItems, sampleAddress, samplePaymentMethod, zoneCheckNorte)

        viewModel.confirmOrder()

        val params = fakeCreate.lastParams
        assertNotNull(params)
        // Verificamos por reflexion del data class que NO existe campo shippingCost.
        // Si alguien intenta agregarlo, el test falla en compilacion (porque no
        // existe en CreateClientOrderParams) o en runtime con esta verificacion.
        val paramsString = params.toString()
        assertFalse(
            paramsString.contains("shippingCost"),
            "CreateClientOrderParams.toString() no debe contener 'shippingCost' (tamper-proofing CA-8). Actual: $paramsString"
        )
        // Verificamos que SI envia los campos legitimos para que el backend recalcule.
        assertEquals("biz-1", params.businessId)
        assertEquals(-34.6, params.lat)
        assertEquals(-58.4, params.lng)
        assertEquals("zone-norte", params.zoneId)
    }

    @Test
    fun `confirmOrder usa shippingCost autoritativo del response no el local`() = runTest {
        // Issue #2424 CA-13 — UI post-submit muestra el shippingCost del response,
        // nunca el calculado localmente antes del envio.
        val fakeCreate = FakeCreateOrderSuccess(
            responseShippingCost = 750.0, // Backend recalculo a 750, no 500
            responseZoneName = "Zona Norte"
        )
        val viewModel = createViewModel(toDoCreateClientOrder = fakeCreate)
        viewModel.loadFromCart(sampleCartItems, sampleAddress, samplePaymentMethod, zoneCheckNorte)

        viewModel.confirmOrder()

        // El response del backend sobreescribe el valor local.
        assertEquals(750.0, viewModel.state.authoritativeShippingCost)
        assertEquals(CheckoutStatus.Success, viewModel.state.status)
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
    fun `canConfirm es false durante recalculo de envio`() = runTest {
        // CA-6 — durante el recalculo el boton debe estar deshabilitado.
        val fakeCheck = FakeCheckAddress(Result.success(zoneCheckSur))
        val viewModel = createViewModel(toDoCheckAddress = fakeCheck)
        viewModel.loadFromCart(sampleCartItems, sampleAddress, samplePaymentMethod, zoneCheckNorte)

        viewModel.changeAddress(sampleAddressOtra)
        // Despues de la coroutine ya termino, recalculatingShipping vuelve a false.
        assertFalse(viewModel.state.recalculatingShipping)
        assertTrue(viewModel.state.canConfirm)
    }

    @Test
    fun `recalculo fallido mantiene shippingCost previo y emite recheckError`() = runTest {
        // CA-6 — error de red durante recalculo NO reemplaza la cifra vieja.
        val fakeCheck = FakeCheckAddress(Result.failure(RuntimeException("Sin conexion")))
        val viewModel = createViewModel(toDoCheckAddress = fakeCheck)
        viewModel.loadFromCart(sampleCartItems, sampleAddress, samplePaymentMethod, zoneCheckNorte)

        viewModel.changeAddress(sampleAddressOtra)

        val state = viewModel.state
        // shipping previo se mantiene
        assertEquals(500.0, state.shipping)
        assertEquals(3700.0, state.total)
        assertEquals("Zona Norte", state.zoneName)
        // Error suave para snackbar
        assertNotNull(state.recheckError)
        assertFalse(state.recalculatingShipping)
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
