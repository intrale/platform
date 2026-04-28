package ui.sc.client

import asdo.client.ClientAddress
import asdo.client.ClientPreferences
import asdo.client.ClientProfile
import asdo.client.ClientProfileData
import asdo.client.DoCheckAddressResult
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
    ClientAddress(id = "addr-1", label = "Casa", street = "San Martín", number = "123", isDefault = true),
    ClientAddress(id = "addr-2", label = "Trabajo", street = "Rivadavia", number = "456", isDefault = false)
)

private val sampleProfileData = ClientProfileData(
    profile = ClientProfile(fullName = "Juan Pérez", email = "juan@test.com", defaultAddressId = "addr-1"),
    addresses = sampleAddresses,
    preferences = ClientPreferences()
)

private val samplePaymentMethods = listOf(
    PaymentMethod(id = "pm-1", name = "Efectivo", type = PaymentMethodType.CASH, description = null, isCashOnDelivery = true, enabled = true),
    PaymentMethod(id = "pm-2", name = "Transferencia", type = PaymentMethodType.TRANSFER, description = "CBU", isCashOnDelivery = false, enabled = true),
    PaymentMethod(id = "pm-3", name = "Deshabilitado", type = PaymentMethodType.CARD, description = null, isCashOnDelivery = false, enabled = false)
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
    fun limpiarCarrito() {
        ClientCartStore.clear()
    }

    @Test
    fun `loadAddresses exitoso actualiza la lista y selecciona la direccion por defecto`() = runTest {
        val viewModel = ClientCartViewModel(
            getClientProfile = FakeGetClientProfile(),
            getPaymentMethods = FakeGetPaymentMethods(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadAddresses()

        assertFalse(viewModel.state.loading)
        assertEquals(2, viewModel.state.addresses.size)
        assertEquals("addr-1", viewModel.state.selectedAddressId)
        assertNull(viewModel.state.error)
    }

    @Test
    fun `loadAddresses selecciona primera direccion cuando no hay defaultAddressId`() = runTest {
        val profileSinDefault = sampleProfileData.copy(
            profile = sampleProfileData.profile.copy(defaultAddressId = null),
            addresses = listOf(
                ClientAddress(id = "addr-a", label = "Única", street = "Florida", number = "1", isDefault = false)
            )
        )
        val viewModel = ClientCartViewModel(
            getClientProfile = FakeGetClientProfile(Result.success(profileSinDefault)),
            getPaymentMethods = FakeGetPaymentMethods(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadAddresses()

        assertEquals("addr-a", viewModel.state.selectedAddressId)
        assertNull(viewModel.state.error)
    }

    @Test
    fun `loadAddresses con error actualiza el estado de error`() = runTest {
        val viewModel = ClientCartViewModel(
            getClientProfile = FakeGetClientProfile(Result.failure(RuntimeException("Sin conexión"))),
            getPaymentMethods = FakeGetPaymentMethods(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadAddresses()

        assertFalse(viewModel.state.loading)
        assertTrue(viewModel.state.addresses.isEmpty())
        assertNotNull(viewModel.state.error)
    }

    @Test
    fun `loadPaymentMethods exitoso carga solo los metodos habilitados`() = runTest {
        val viewModel = ClientCartViewModel(
            getClientProfile = FakeGetClientProfile(),
            getPaymentMethods = FakeGetPaymentMethods(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadPaymentMethods()

        assertFalse(viewModel.state.loadingPaymentMethods)
        assertEquals(2, viewModel.state.paymentMethods.size)
        assertTrue(viewModel.state.paymentMethods.all { it.enabled })
        assertNull(viewModel.state.error)
    }

    @Test
    fun `loadPaymentMethods selecciona el primer metodo disponible`() = runTest {
        val viewModel = ClientCartViewModel(
            getClientProfile = FakeGetClientProfile(),
            getPaymentMethods = FakeGetPaymentMethods(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadPaymentMethods()

        assertEquals("pm-1", viewModel.state.selectedPaymentMethodId)
    }

    @Test
    fun `loadPaymentMethods con error actualiza el estado de error`() = runTest {
        val viewModel = ClientCartViewModel(
            getClientProfile = FakeGetClientProfile(),
            getPaymentMethods = FakeGetPaymentMethods(Result.failure(RuntimeException("Error de red"))),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadPaymentMethods()

        assertFalse(viewModel.state.loadingPaymentMethods)
        assertTrue(viewModel.state.paymentMethods.isEmpty())
        assertNotNull(viewModel.state.error)
    }

    @Test
    fun `loadPaymentMethods filtra metodos deshabilitados`() = runTest {
        val soloDeshabilitados = listOf(
            PaymentMethod(id = "pm-off", name = "Tarjeta", type = PaymentMethodType.CARD, description = null, isCashOnDelivery = false, enabled = false)
        )
        val viewModel = ClientCartViewModel(
            getClientProfile = FakeGetClientProfile(),
            getPaymentMethods = FakeGetPaymentMethods(Result.success(soloDeshabilitados)),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadPaymentMethods()

        assertTrue(viewModel.state.paymentMethods.isEmpty())
        assertNull(viewModel.state.selectedPaymentMethodId)
    }

    @Test
    fun `selectAddress actualiza el id seleccionado y persiste en el store`() = runTest {
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
    fun `selectPaymentMethod actualiza el id seleccionado y persiste en el store`() = runTest {
        val viewModel = ClientCartViewModel(
            getClientProfile = FakeGetClientProfile(),
            getPaymentMethods = FakeGetPaymentMethods(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadPaymentMethods()
        viewModel.selectPaymentMethod("pm-2")

        assertEquals("pm-2", viewModel.state.selectedPaymentMethodId)
        assertEquals("pm-2", ClientCartStore.selectedPaymentMethodId.value)
        assertNull(viewModel.state.error)
    }

    @Test
    fun `estado inicial no tiene error ni datos cargados`() {
        val viewModel = ClientCartViewModel(
            getClientProfile = FakeGetClientProfile(),
            getPaymentMethods = FakeGetPaymentMethods(),
            loggerFactory = testLoggerFactory
        )

        assertFalse(viewModel.state.loading)
        assertFalse(viewModel.state.loadingPaymentMethods)
        assertTrue(viewModel.state.addresses.isEmpty())
        assertTrue(viewModel.state.paymentMethods.isEmpty())
        assertNull(viewModel.state.selectedAddressId)
        assertNull(viewModel.state.selectedPaymentMethodId)
        assertNull(viewModel.state.error)
    }

    @Test
    fun `cart bloquea agregar producto cuando no hay verificacion previa`() {
        // Issue #2424 CA-1 — sin verificacion vigente, addToCart se bloquea con modal.
        val viewModel = ClientCartViewModel(
            getClientProfile = FakeGetClientProfile(),
            getPaymentMethods = FakeGetPaymentMethods(),
            loggerFactory = testLoggerFactory
        )
        // Pre: sin verificacion previa
        assertNull(ClientCartStore.lastZoneCheckResult.value)

        val product = ClientProduct(
            id = "prod-1",
            name = "Manzana",
            priceLabel = "$1.200",
            emoji = "🍎",
            unitPrice = 1200.0,
            categoryId = "cat-1",
            isAvailable = true
        )
        viewModel.requestAddToCart(product)

        // El modal se dispara y el producto NO se agrega al carrito.
        assertTrue(viewModel.state.requireZoneCheck)
        assertEquals(product, viewModel.state.pendingProduct)
        assertTrue(ClientCartStore.items.value.isEmpty())
    }

    @Test
    fun `cart agrega producto cuando hay verificacion vigente`() {
        // Issue #2424 CA-1 — con verificacion vigente, el flujo es transparente.
        val viewModel = ClientCartViewModel(
            getClientProfile = FakeGetClientProfile(),
            getPaymentMethods = FakeGetPaymentMethods(),
            loggerFactory = testLoggerFactory
        )
        ClientCartStore.setZoneCheckResult(
            DoCheckAddressResult(
                businessId = "biz-1",
                addressId = "addr-1",
                lat = -34.6,
                lng = -58.4,
                zoneId = "zone-1",
                zoneName = "Zona Norte",
                shippingCost = 500.0
            )
        )

        val product = ClientProduct(
            id = "prod-1",
            name = "Manzana",
            priceLabel = "$1.200",
            emoji = "🍎",
            unitPrice = 1200.0,
            categoryId = "cat-1",
            isAvailable = true
        )
        viewModel.requestAddToCart(product)

        // No se dispara modal y el producto se agrega.
        assertFalse(viewModel.state.requireZoneCheck)
        assertNull(viewModel.state.pendingProduct)
        assertEquals(1, ClientCartStore.items.value.size)
    }

    @Test
    fun `cart agrega producto sin bloquear cuando negocio no tiene zonas`() {
        // Issue #2424 CA-5 — negocio sin zonas no activa el flujo bloqueante.
        val viewModel = ClientCartViewModel(
            getClientProfile = FakeGetClientProfile(),
            getPaymentMethods = FakeGetPaymentMethods(),
            loggerFactory = testLoggerFactory
        )
        // Sin verificacion previa, pero el negocio no tiene zonas configuradas.
        val product = ClientProduct(
            id = "prod-1",
            name = "Manzana",
            priceLabel = "$1.200",
            emoji = "🍎",
            unitPrice = 1200.0,
            categoryId = "cat-1",
            isAvailable = true
        )
        viewModel.requestAddToCart(product, businessHasZones = false)

        assertFalse(viewModel.state.requireZoneCheck)
        assertEquals(1, ClientCartStore.items.value.size)
    }
}
