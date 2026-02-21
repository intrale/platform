package ui.sc.client

import asdo.client.ClientAddress
import asdo.client.ClientProfileData
import asdo.client.ManageAddressAction
import asdo.client.ToDoGetClientProfile
import asdo.client.ToDoManageClientAddress
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

private class FakeAddressListDeps(
    private val profileResult: Result<ClientProfileData>,
    private val manageResult: Result<ClientProfileData> = Result.success(ClientProfileData())
) : ToDoGetClientProfile, ToDoManageClientAddress {
    override suspend fun execute(): Result<ClientProfileData> = profileResult
    override suspend fun execute(action: ManageAddressAction): Result<ClientProfileData> = manageResult
}

private val testLogger = LoggerFactory(listOf(simplePrintFrontend))

class AddressListViewModelTest {

    @Test
    fun `carga direcciones exitosamente`() = runTest {
        val addresses = listOf(
            ClientAddress(id = "1", label = "Casa", street = "Av. Siempreviva", number = "742", city = "Springfield"),
            ClientAddress(id = "2", label = "Oficina", street = "Calle Falsa", number = "123", city = "Shelbyville")
        )
        val fake = FakeAddressListDeps(Result.success(ClientProfileData(addresses = addresses)))
        val viewModel = AddressListViewModel(fake, fake, loggerFactory = testLogger)

        viewModel.loadAddresses()

        assertEquals(AddressListStatus.Loaded, viewModel.state.status)
        assertEquals(2, viewModel.state.items.size)
        assertEquals("Casa", viewModel.state.items[0].label)
        assertEquals("Oficina", viewModel.state.items[1].label)
    }

    @Test
    fun `estado empty cuando no hay direcciones`() = runTest {
        val fake = FakeAddressListDeps(Result.success(ClientProfileData(addresses = emptyList())))
        val viewModel = AddressListViewModel(fake, fake, loggerFactory = testLogger)

        viewModel.loadAddresses()

        assertEquals(AddressListStatus.Empty, viewModel.state.status)
        assertTrue(viewModel.state.items.isEmpty())
    }

    @Test
    fun `estado error cuando falla la carga`() = runTest {
        val fake = FakeAddressListDeps(Result.failure(Exception("network error")))
        val viewModel = AddressListViewModel(fake, fake, loggerFactory = testLogger)

        viewModel.loadAddresses()

        assertEquals(AddressListStatus.Error, viewModel.state.status)
        assertNotNull(viewModel.state.errorMessage)
    }

    @Test
    fun `eliminar exitosamente remueve de la lista`() = runTest {
        val addresses = listOf(
            ClientAddress(id = "1", label = "Casa", street = "Av. Siempreviva", number = "742", city = "Springfield"),
            ClientAddress(id = "2", label = "Oficina", street = "Calle Falsa", number = "123", city = "Shelbyville")
        )
        val fake = FakeAddressListDeps(
            profileResult = Result.success(ClientProfileData(addresses = addresses)),
            manageResult = Result.success(ClientProfileData(addresses = listOf(addresses[1])))
        )
        val viewModel = AddressListViewModel(fake, fake, loggerFactory = testLogger)
        viewModel.loadAddresses()

        val result = viewModel.deleteAddress("1")

        assertTrue(result.isSuccess)
        assertEquals(1, viewModel.state.items.size)
        assertEquals("Oficina", viewModel.state.items[0].label)
    }

    @Test
    fun `fallo al eliminar informa error`() = runTest {
        val addresses = listOf(
            ClientAddress(id = "1", label = "Casa", street = "Av. Siempreviva", number = "742", city = "Springfield")
        )
        val fake = FakeAddressListDeps(
            profileResult = Result.success(ClientProfileData(addresses = addresses)),
            manageResult = Result.failure(Exception("delete failed"))
        )
        val viewModel = AddressListViewModel(fake, fake, loggerFactory = testLogger)
        viewModel.loadAddresses()

        val result = viewModel.deleteAddress("1")

        assertTrue(result.isFailure)
        assertNotNull(viewModel.state.errorMessage)
    }
}
