package ui.sc.client

import asdo.auth.ToDoResetLoginCache
import asdo.client.ClientAddress
import asdo.client.ClientPreferences
import asdo.client.ClientProfile
import asdo.client.ClientProfileData
import asdo.client.ManageAddressAction
import asdo.client.ToDoGetClientProfile
import asdo.client.ToDoManageClientAddress
import asdo.client.ToDoUpdateClientProfile
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend

private val vmTestLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

private val sampleAddresses = listOf(
    ClientAddress(
        id = "addr-1",
        label = "Casa",
        street = "Calle Falsa",
        number = "123",
        city = "Buenos Aires",
        isDefault = true
    ),
    ClientAddress(
        id = "addr-2",
        label = "Oficina",
        street = "Av Siempre Viva",
        number = "742",
        city = "Buenos Aires",
        isDefault = false
    )
)

private val sampleProfile = ClientProfile(
    fullName = "Juan Perez",
    email = "juan@intrale.com",
    phone = "+5411999888",
    defaultAddressId = "addr-1"
)

private val samplePreferences = ClientPreferences(language = "es")

private val sampleProfileData = ClientProfileData(
    profile = sampleProfile,
    addresses = sampleAddresses,
    preferences = samplePreferences
)

private val sampleProduct1 = ClientProduct(
    id = "prod-1",
    name = "Manzana roja",
    priceLabel = "$1200",
    emoji = "🍎",
    unitPrice = 1200.0,
    categoryId = "cat-1"
)

private val sampleProduct2 = ClientProduct(
    id = "prod-2",
    name = "Banana",
    priceLabel = "$800",
    emoji = "🍌",
    unitPrice = 800.0,
    categoryId = "cat-2"
)

// --- Fakes ---

private class FakeGetClientProfileSuccess(
    private val data: ClientProfileData = sampleProfileData
) : ToDoGetClientProfile {
    override suspend fun execute(): Result<ClientProfileData> = Result.success(data)
}

private class FakeGetClientProfileFailure(
    private val error: String = "Error de red"
) : ToDoGetClientProfile {
    override suspend fun execute(): Result<ClientProfileData> =
        Result.failure(RuntimeException(error))
}

private class FakeUpdateClientProfile(
    private val store: MutableProfileStore = MutableProfileStore()
) : ToDoUpdateClientProfile {
    var lastProfile: ClientProfile? = null
    var lastPreferences: ClientPreferences? = null

    override suspend fun execute(
        profile: ClientProfile,
        preferences: ClientPreferences
    ): Result<ClientProfileData> {
        lastProfile = profile
        lastPreferences = preferences
        store.profile = profile
        store.preferences = preferences
        return Result.success(store.data())
    }
}

private class FakeManageClientAddress(
    private val store: MutableProfileStore = MutableProfileStore()
) : ToDoManageClientAddress {
    var lastAction: ManageAddressAction? = null

    override suspend fun execute(action: ManageAddressAction): Result<ClientProfileData> {
        lastAction = action
        when (action) {
            is ManageAddressAction.Create -> {
                val newId = action.address.id ?: "new-1"
                store.addresses.add(action.address.copy(id = newId))
                store.normalizeDefaults(newId.takeIf { action.address.isDefault })
            }
            is ManageAddressAction.Update -> {
                val index = store.addresses.indexOfFirst { it.id == action.address.id }
                if (index != -1) store.addresses[index] = action.address
                store.normalizeDefaults(store.profile.defaultAddressId)
            }
            is ManageAddressAction.Delete -> {
                store.addresses.removeAll { it.id == action.addressId }
                store.normalizeDefaults()
            }
            is ManageAddressAction.MarkDefault -> {
                store.normalizeDefaults(action.addressId)
            }
        }
        return Result.success(store.data())
    }
}

private class FakeResetCache : ToDoResetLoginCache {
    var called = false
    override suspend fun execute() {
        called = true
    }
}

private class MutableProfileStore(
    var profile: ClientProfile = sampleProfile.copy(),
    var preferences: ClientPreferences = samplePreferences.copy(),
    val addresses: MutableList<ClientAddress> = sampleAddresses.map { it.copy() }.toMutableList()
) {
    fun data(): ClientProfileData = ClientProfileData(
        profile = profile,
        addresses = addresses.toList(),
        preferences = preferences
    )

    fun normalizeDefaults(defaultId: String? = null) {
        val chosen = defaultId
            ?: addresses.firstOrNull { it.isDefault }?.id
            ?: addresses.firstOrNull()?.id
        addresses.forEachIndexed { index, address ->
            addresses[index] = address.copy(isDefault = address.id == chosen)
        }
        profile = profile.copy(defaultAddressId = chosen)
    }
}

// =============================================================================
// ClientCartStore
// =============================================================================

class ClientCartStoreTest {

    @BeforeTest
    fun setUp() {
        ClientCartStore.clear()
    }

    @Test
    fun `add agrega un producto nuevo con cantidad 1`() {
        ClientCartStore.add(sampleProduct1)

        val items = ClientCartStore.items.value
        assertTrue(items.containsKey("prod-1"))
        assertEquals(1, items["prod-1"]?.quantity)
        assertEquals(sampleProduct1, items["prod-1"]?.product)
    }

    @Test
    fun `add incrementa cantidad si el producto ya existe`() {
        ClientCartStore.add(sampleProduct1)
        ClientCartStore.add(sampleProduct1)

        val items = ClientCartStore.items.value
        assertEquals(1, items.size)
        assertEquals(2, items["prod-1"]?.quantity)
    }

    @Test
    fun `add permite agregar multiples productos distintos`() {
        ClientCartStore.add(sampleProduct1)
        ClientCartStore.add(sampleProduct2)

        val items = ClientCartStore.items.value
        assertEquals(2, items.size)
        assertEquals(1, items["prod-1"]?.quantity)
        assertEquals(1, items["prod-2"]?.quantity)
    }

    @Test
    fun `increment aumenta la cantidad de un producto existente`() {
        ClientCartStore.add(sampleProduct1)
        ClientCartStore.increment("prod-1")

        assertEquals(2, ClientCartStore.items.value["prod-1"]?.quantity)
    }

    @Test
    fun `increment no modifica el mapa si el producto no existe`() {
        ClientCartStore.increment("prod-inexistente")

        assertTrue(ClientCartStore.items.value.isEmpty())
    }

    @Test
    fun `decrement reduce la cantidad de un producto existente`() {
        ClientCartStore.add(sampleProduct1)
        ClientCartStore.increment("prod-1")
        ClientCartStore.decrement("prod-1")

        assertEquals(1, ClientCartStore.items.value["prod-1"]?.quantity)
    }

    @Test
    fun `decrement elimina el producto cuando la cantidad llega a 1`() {
        ClientCartStore.add(sampleProduct1)
        ClientCartStore.decrement("prod-1")

        assertFalse(ClientCartStore.items.value.containsKey("prod-1"))
    }

    @Test
    fun `decrement no modifica el mapa si el producto no existe`() {
        ClientCartStore.decrement("prod-inexistente")

        assertTrue(ClientCartStore.items.value.isEmpty())
    }

    @Test
    fun `remove elimina un producto del carrito`() {
        ClientCartStore.add(sampleProduct1)
        ClientCartStore.add(sampleProduct2)

        ClientCartStore.remove("prod-1")

        val items = ClientCartStore.items.value
        assertEquals(1, items.size)
        assertFalse(items.containsKey("prod-1"))
        assertTrue(items.containsKey("prod-2"))
    }

    @Test
    fun `remove no falla si el producto no existe`() {
        ClientCartStore.remove("prod-inexistente")

        assertTrue(ClientCartStore.items.value.isEmpty())
    }

    @Test
    fun `clear vacia todos los items y la direccion seleccionada`() {
        ClientCartStore.add(sampleProduct1)
        ClientCartStore.add(sampleProduct2)
        ClientCartStore.selectAddress("addr-1")

        ClientCartStore.clear()

        assertTrue(ClientCartStore.items.value.isEmpty())
        assertNull(ClientCartStore.selectedAddressId.value)
    }

    @Test
    fun `selectAddress establece la direccion seleccionada`() {
        ClientCartStore.selectAddress("addr-1")

        assertEquals("addr-1", ClientCartStore.selectedAddressId.value)
    }

    @Test
    fun `selectAddress permite cambiar la direccion`() {
        ClientCartStore.selectAddress("addr-1")
        ClientCartStore.selectAddress("addr-2")

        assertEquals("addr-2", ClientCartStore.selectedAddressId.value)
    }

    @Test
    fun `selectAddress permite establecer null`() {
        ClientCartStore.selectAddress("addr-1")
        ClientCartStore.selectAddress(null)

        assertNull(ClientCartStore.selectedAddressId.value)
    }
}

// =============================================================================
// ClientCartViewModel
// =============================================================================

class ClientCartViewModelTest {

    @BeforeTest
    fun setUp() {
        ClientCartStore.clear()
    }

    private fun createViewModel(
        getClientProfile: ToDoGetClientProfile = FakeGetClientProfileSuccess()
    ): ClientCartViewModel = ClientCartViewModel(
        getClientProfile = getClientProfile,
        loggerFactory = vmTestLoggerFactory
    )

    @Test
    fun `loadAddresses carga direcciones y selecciona la predeterminada`() = runTest {
        val viewModel = createViewModel()

        viewModel.loadAddresses()

        assertFalse(viewModel.state.loading)
        assertNull(viewModel.state.error)
        assertEquals(2, viewModel.state.addresses.size)
        assertEquals("addr-1", viewModel.state.selectedAddressId)
        assertEquals("addr-1", ClientCartStore.selectedAddressId.value)
    }

    @Test
    fun `loadAddresses normaliza direcciones marcando la predeterminada`() = runTest {
        val viewModel = createViewModel()

        viewModel.loadAddresses()

        val defaultAddr = viewModel.state.addresses.first { it.id == "addr-1" }
        assertTrue(defaultAddr.isDefault)
    }

    @Test
    fun `loadAddresses usa primera direccion isDefault cuando profile no tiene defaultAddressId`() = runTest {
        val data = ClientProfileData(
            profile = ClientProfile(
                fullName = "Jane Doe",
                email = "jane@intrale.com",
                defaultAddressId = null
            ),
            addresses = sampleAddresses
        )
        val viewModel = createViewModel(
            getClientProfile = FakeGetClientProfileSuccess(data)
        )

        viewModel.loadAddresses()

        assertEquals("addr-1", viewModel.state.selectedAddressId)
    }

    @Test
    fun `loadAddresses usa primera direccion disponible cuando ninguna es default`() = runTest {
        val addressesSinDefault = listOf(
            ClientAddress(id = "addr-x", label = "Temp", street = "X", number = "1", city = "C", isDefault = false),
            ClientAddress(id = "addr-y", label = "Otra", street = "Y", number = "2", city = "C", isDefault = false)
        )
        val data = ClientProfileData(
            profile = ClientProfile(defaultAddressId = null),
            addresses = addressesSinDefault
        )
        val viewModel = createViewModel(
            getClientProfile = FakeGetClientProfileSuccess(data)
        )

        viewModel.loadAddresses()

        assertEquals("addr-x", viewModel.state.selectedAddressId)
    }

    @Test
    fun `loadAddresses con error actualiza el estado con mensaje de error`() = runTest {
        val viewModel = createViewModel(
            getClientProfile = FakeGetClientProfileFailure("Sin conexion")
        )

        viewModel.loadAddresses()

        assertFalse(viewModel.state.loading)
        assertEquals("Sin conexion", viewModel.state.error)
        assertTrue(viewModel.state.addresses.isEmpty())
    }

    @Test
    fun `loadAddresses con error sin mensaje usa mensaje por defecto`() = runTest {
        val viewModel = createViewModel(
            getClientProfile = object : ToDoGetClientProfile {
                override suspend fun execute(): Result<ClientProfileData> =
                    Result.failure(RuntimeException())
            }
        )

        viewModel.loadAddresses()

        assertEquals("No se pudieron cargar las direcciones", viewModel.state.error)
    }

    @Test
    fun `selectAddress actualiza el estado y el store`() = runTest {
        val viewModel = createViewModel()
        viewModel.loadAddresses()

        viewModel.selectAddress("addr-2")

        assertEquals("addr-2", viewModel.state.selectedAddressId)
        assertNull(viewModel.state.error)
        assertEquals("addr-2", ClientCartStore.selectedAddressId.value)
    }

    @Test
    fun `selectAddress limpia error previo`() = runTest {
        val viewModel = createViewModel(
            getClientProfile = FakeGetClientProfileFailure("Error previo")
        )
        viewModel.loadAddresses()
        assertEquals("Error previo", viewModel.state.error)

        viewModel.selectAddress("addr-1")

        assertNull(viewModel.state.error)
    }

    @Test
    fun `loadAddresses con lista vacia de direcciones maneja correctamente`() = runTest {
        val data = ClientProfileData(
            profile = ClientProfile(defaultAddressId = null),
            addresses = emptyList()
        )
        val viewModel = createViewModel(
            getClientProfile = FakeGetClientProfileSuccess(data)
        )

        viewModel.loadAddresses()

        assertTrue(viewModel.state.addresses.isEmpty())
        assertNull(viewModel.state.selectedAddressId)
        assertFalse(viewModel.state.loading)
    }

    @Test
    fun `getState devuelve el estado actual del ViewModel`() = runTest {
        val viewModel = createViewModel()

        val state = viewModel.getState()

        assertTrue(state is ClientCartUiState)
    }
}

// =============================================================================
// ClientProfileViewModel
// =============================================================================

class ClientProfileViewModelComprehensiveTest {

    private fun createViewModel(
        getClientProfile: ToDoGetClientProfile = FakeGetClientProfileSuccess(),
        updateClientProfile: ToDoUpdateClientProfile = FakeUpdateClientProfile(),
        manageClientAddress: ToDoManageClientAddress = FakeManageClientAddress(),
        toDoResetLoginCache: ToDoResetLoginCache = FakeResetCache()
    ): ClientProfileViewModel = ClientProfileViewModel(
        getClientProfile = getClientProfile,
        updateClientProfile = updateClientProfile,
        manageClientAddress = manageClientAddress,
        toDoResetLoginCache = toDoResetLoginCache,
        loggerFactory = vmTestLoggerFactory
    )

    @Test
    fun `loadProfile exitoso carga formulario`() = runTest {
        val viewModel = createViewModel()

        viewModel.loadProfile()

        assertFalse(viewModel.state.loading)
        assertNull(viewModel.state.error)
        assertEquals("Juan Perez", viewModel.state.profileForm.fullName)
        assertEquals("juan@intrale.com", viewModel.state.profileForm.email)
        assertEquals("+5411999888", viewModel.state.profileForm.phone)
        assertEquals("es", viewModel.state.profileForm.language)
        assertEquals(2, viewModel.state.addresses.size)
        assertTrue(viewModel.state.addresses.first { it.id == "addr-1" }.isDefault)
    }

    @Test
    fun `loadProfile con error muestra error`() = runTest {
        val viewModel = createViewModel(
            getClientProfile = FakeGetClientProfileFailure("Servidor no disponible")
        )

        viewModel.loadProfile()

        assertFalse(viewModel.state.loading)
        assertEquals("Servidor no disponible", viewModel.state.error)
    }

    @Test
    fun `saveProfile exitoso actualiza estado`() = runTest {
        val store = MutableProfileStore()
        val updateFake = FakeUpdateClientProfile(store)
        val viewModel = createViewModel(
            getClientProfile = FakeGetClientProfileSuccess(store.data()),
            updateClientProfile = updateFake
        )

        viewModel.loadProfile()
        viewModel.onNameChange("Maria Lopez")
        viewModel.saveProfile()

        assertFalse(viewModel.state.savingProfile)
        assertNull(viewModel.state.error)
        assertEquals("Maria Lopez", updateFake.lastProfile?.fullName)
    }

    @Test
    fun `onNameChange actualiza estado`() = runTest {
        val viewModel = createViewModel()

        viewModel.loadProfile()
        viewModel.onNameChange("Nuevo Nombre")

        assertEquals("Nuevo Nombre", viewModel.state.profileForm.fullName)
    }

    @Test
    fun `saveAddress crea direccion nueva`() = runTest {
        val store = MutableProfileStore()
        val manageFake = FakeManageClientAddress(store)
        val viewModel = createViewModel(
            getClientProfile = FakeGetClientProfileSuccess(store.data()),
            manageClientAddress = manageFake
        )

        viewModel.loadProfile()
        viewModel.startAddressEditing()
        viewModel.onAddressChange {
            copy(
                label = "Deposito",
                street = "Av Corrientes",
                number = "1500",
                city = "CABA",
                postalCode = "1043"
            )
        }
        viewModel.saveAddress()

        assertTrue(manageFake.lastAction is ManageAddressAction.Create)
        assertFalse(viewModel.state.savingAddress)
        assertNull(viewModel.state.error)
    }

    @Test
    fun `deleteAddress exitoso actualiza lista`() = runTest {
        val store = MutableProfileStore()
        val manageFake = FakeManageClientAddress(store)
        val viewModel = createViewModel(
            getClientProfile = FakeGetClientProfileSuccess(store.data()),
            manageClientAddress = manageFake
        )

        viewModel.loadProfile()
        viewModel.deleteAddress("addr-1")

        assertTrue(manageFake.lastAction is ManageAddressAction.Delete)
        assertFalse(viewModel.state.savingAddress)
        assertEquals(1, viewModel.state.addresses.size)
        assertEquals("addr-2", viewModel.state.profileForm.defaultAddressId)
    }

    @Test
    fun `markDefault exitoso actualiza default`() = runTest {
        val store = MutableProfileStore()
        val manageFake = FakeManageClientAddress(store)
        val viewModel = createViewModel(
            getClientProfile = FakeGetClientProfileSuccess(store.data()),
            manageClientAddress = manageFake
        )

        viewModel.loadProfile()
        viewModel.markDefault("addr-2")

        assertTrue(manageFake.lastAction is ManageAddressAction.MarkDefault)
        assertEquals("addr-2", viewModel.state.profileForm.defaultAddressId)
        assertTrue(viewModel.state.addresses.first { it.id == "addr-2" }.isDefault)
        assertFalse(viewModel.state.addresses.first { it.id == "addr-1" }.isDefault)
    }

    @Test
    fun `logout limpia sesion`() = runTest {
        val resetFake = FakeResetCache()
        val viewModel = createViewModel(toDoResetLoginCache = resetFake)

        viewModel.logout()

        assertTrue(resetFake.called)
    }
}
