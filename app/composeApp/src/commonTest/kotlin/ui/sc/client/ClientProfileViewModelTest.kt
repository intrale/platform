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
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend
import ui.sc.client.AddressForm

private val testLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

private class FakeAddressStore(
    val addresses: MutableList<ClientAddress> = mutableListOf(
        ClientAddress(
            id = "addr-1",
            label = "Casa",
            street = "Calle",
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
    ),
    var profile: ClientProfile = ClientProfile(
        fullName = "Jane Doe",
        email = "jane@intrale.com",
        phone = "+5411123456",
        defaultAddressId = "addr-1"
    ),
    var preferences: ClientPreferences = ClientPreferences(language = "es")
) {
    fun data(): ClientProfileData = ClientProfileData(
        profile = profile,
        addresses = addresses.toList(),
        preferences = preferences
    )

    fun normalize(defaultId: String? = null) {
        val chosen = defaultId
            ?: addresses.firstOrNull { it.isDefault }?.id
            ?: addresses.firstOrNull()?.id
        addresses.replaceAll { it.copy(isDefault = it.id == chosen) }
        profile = profile.copy(defaultAddressId = chosen)
    }
}

class ClientProfileViewModelTest {

    @Test
    fun `loadProfile actualiza el estado con los datos del caso de uso`() = runTest {
        val store = FakeAddressStore()
        val viewModel = ClientProfileViewModel(
            getClientProfile = FakeGetProfile(store),
            updateClientProfile = FakeUpdateProfile(store),
            manageClientAddress = FakeManageAddress(store),
            toDoResetLoginCache = FakeResetLoginCache(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadProfile()

        assertFalse(viewModel.state.loading)
        assertEquals("Jane Doe", viewModel.state.profileForm.fullName)
        assertEquals("jane@intrale.com", viewModel.state.profileForm.email)
        assertEquals(2, viewModel.state.addresses.size)
        assertTrue(viewModel.state.addresses.first().isDefault)
    }

    @Test
    fun `saveAddress valida campos requeridos antes de invocar el caso de uso`() = runTest {
        val manage = FakeManageAddress(FakeAddressStore())
        val viewModel = ClientProfileViewModel(
            getClientProfile = FakeGetProfile(),
            updateClientProfile = FakeUpdateProfile(),
            manageClientAddress = manage,
            toDoResetLoginCache = FakeResetLoginCache(),
            loggerFactory = testLoggerFactory
        )

        viewModel.startAddressEditing()
        viewModel.onAddressChange { copy(label = "", street = "", number = "", city = "") }
        viewModel.saveAddress()

        assertNull(manage.lastAction)
        assertFalse(viewModel.inputsStates[AddressForm::street.name]!!.value.isValid)
        assertFalse(viewModel.inputsStates[AddressForm::number.name]!!.value.isValid)
    }

    @Test
    fun `saveAddress crea y marca la dirección predeterminada`() = runTest {
        val store = FakeAddressStore()
        val manage = FakeManageAddress(store)
        val viewModel = ClientProfileViewModel(
            getClientProfile = FakeGetProfile(store),
            updateClientProfile = FakeUpdateProfile(store),
            manageClientAddress = manage,
            toDoResetLoginCache = FakeResetLoginCache(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadProfile()
        viewModel.startAddressEditing()
        viewModel.onAddressChange { copy(label = "Nueva", street = "Laprida", number = "456", city = "CABA", isDefault = true) }
        viewModel.saveAddress()

        assertTrue(manage.lastAction is ManageAddressAction.Create)
        val defaultId = viewModel.state.profileForm.defaultAddressId
        assertEquals("new-1", defaultId)
        assertTrue(viewModel.state.addresses.first { it.id == defaultId }.isDefault)
    }

    @Test
    fun `deleteAddress reasigna la predeterminada cuando corresponde`() = runTest {
        val store = FakeAddressStore()
        val manage = FakeManageAddress(store)
        val viewModel = ClientProfileViewModel(
            getClientProfile = FakeGetProfile(store),
            updateClientProfile = FakeUpdateProfile(store),
            manageClientAddress = manage,
            toDoResetLoginCache = FakeResetLoginCache(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadProfile()
        viewModel.deleteAddress("addr-1")

        assertTrue(manage.lastAction is ManageAddressAction.Delete)
        assertEquals("addr-2", viewModel.state.profileForm.defaultAddressId)
        assertTrue(viewModel.state.addresses.first { it.id == "addr-2" }.isDefault)
    }

    @Test
    fun `markDefault actualiza la dirección seleccionada`() = runTest {
        val store = FakeAddressStore()
        val manage = FakeManageAddress(store)
        val viewModel = ClientProfileViewModel(
            getClientProfile = FakeGetProfile(store),
            updateClientProfile = FakeUpdateProfile(store),
            manageClientAddress = manage,
            toDoResetLoginCache = FakeResetLoginCache(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadProfile()
        viewModel.markDefault("addr-2")

        assertTrue(manage.lastAction is ManageAddressAction.MarkDefault)
        assertEquals("addr-2", viewModel.state.profileForm.defaultAddressId)
        assertTrue(viewModel.state.addresses.first { it.id == "addr-2" }.isDefault)
    }
}

private class FakeGetProfile(
    private val store: FakeAddressStore = FakeAddressStore()
) : ToDoGetClientProfile {
    override suspend fun execute(): Result<ClientProfileData> = Result.success(store.data())
}

private class FakeUpdateProfile(
    private val store: FakeAddressStore = FakeAddressStore()
) : ToDoUpdateClientProfile {
    override suspend fun execute(profile: ClientProfile, preferences: ClientPreferences): Result<ClientProfileData> {
        store.profile = profile
        store.preferences = preferences
        return Result.success(store.data())
    }
}

private class FakeManageAddress(
    private val store: FakeAddressStore
) : ToDoManageClientAddress {
    var lastAction: ManageAddressAction? = null

    override suspend fun execute(action: ManageAddressAction): Result<ClientProfileData> {
        lastAction = action
        when (action) {
            is ManageAddressAction.Create -> {
                val newId = action.address.id ?: "new-1"
                store.addresses.add(action.address.copy(id = newId))
                store.normalize(newId.takeIf { action.address.isDefault })
            }

            is ManageAddressAction.Update -> {
                val index = store.addresses.indexOfFirst { it.id == action.address.id }
                if (index != -1) {
                    store.addresses[index] = action.address
                }
                store.normalize(store.profile.defaultAddressId)
            }

            is ManageAddressAction.Delete -> {
                store.addresses.removeIf { it.id == action.addressId }
                store.normalize()
            }

            is ManageAddressAction.MarkDefault -> {
                store.normalize(action.addressId)
            }
        }
        return Result.success(store.data())
    }
}

private class FakeResetLoginCache : ToDoResetLoginCache {
    var called = false
    override suspend fun execute() {
        called = true
    }
}
