package ui.sc.client

import asdo.client.ClientAddress
import asdo.client.ClientProfileData
import asdo.client.ManageAddressAction
import asdo.client.ToDoManageClientAddress
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

private class FakeAddressFormManage(
    private val result: Result<ClientProfileData> = Result.success(
        ClientProfileData(
            addresses = listOf(
                ClientAddress(
                    id = "new-id",
                    label = "Casa",
                    street = "Av. Siempreviva",
                    number = "742",
                    city = "Springfield"
                )
            )
        )
    )
) : ToDoManageClientAddress {
    var lastAction: ManageAddressAction? = null
        private set

    override suspend fun execute(action: ManageAddressAction): Result<ClientProfileData> {
        lastAction = action
        return result
    }
}

class AddressFormViewModelTest {

    @Test
    fun `campos requeridos fallan validación`() = runTest {
        val fake = FakeAddressFormManage()
        val viewModel = AddressFormViewModel(fake)

        val result = viewModel.save()

        assertTrue(result.isFailure)
    }

    @Test
    fun `creación exitosa pasa a modo edición`() = runTest {
        val fake = FakeAddressFormManage()
        val viewModel = AddressFormViewModel(fake)
        viewModel.uiState = viewModel.uiState.copy(
            label = "Casa",
            street = "Av. Siempreviva",
            number = "742",
            city = "Springfield"
        )

        val result = viewModel.save()

        assertTrue(result.isSuccess)
        assertEquals(AddressFormMode.Edit, viewModel.mode)
        assertEquals("new-id", viewModel.uiState.id)
        assertTrue(fake.lastAction is ManageAddressAction.Create)
    }

    @Test
    fun `edición usa ManageAddressAction Update`() = runTest {
        val updatedAddress = ClientAddress(
            id = "existing-id",
            label = "Casa",
            street = "Calle Editada",
            number = "100",
            city = "Buenos Aires"
        )
        val fake = FakeAddressFormManage(
            Result.success(ClientProfileData(addresses = listOf(updatedAddress)))
        )
        val viewModel = AddressFormViewModel(fake)
        viewModel.applyDraft(
            AddressDraft(
                id = "existing-id",
                label = "Casa",
                street = "Av. Original",
                number = "100",
                city = "Buenos Aires"
            )
        )
        viewModel.uiState = viewModel.uiState.copy(street = "Calle Editada")

        val result = viewModel.save()

        assertTrue(result.isSuccess)
        assertTrue(fake.lastAction is ManageAddressAction.Update)
    }

    @Test
    fun `applyDraft con draft existente pasa a modo edición`() = runTest {
        val fake = FakeAddressFormManage()
        val viewModel = AddressFormViewModel(fake)

        viewModel.applyDraft(
            AddressDraft(
                id = "addr-1",
                label = "Oficina",
                street = "Calle Central",
                number = "50",
                city = "Córdoba"
            )
        )

        assertEquals(AddressFormMode.Edit, viewModel.mode)
        assertEquals("addr-1", viewModel.uiState.id)
        assertEquals("Oficina", viewModel.uiState.label)
    }

    @Test
    fun `applyDraft null reinicia a modo creación`() = runTest {
        val fake = FakeAddressFormManage()
        val viewModel = AddressFormViewModel(fake)
        viewModel.applyDraft(
            AddressDraft(id = "addr-1", label = "Oficina", street = "Calle Central", number = "50", city = "Córdoba")
        )

        viewModel.applyDraft(null)

        assertEquals(AddressFormMode.Create, viewModel.mode)
        assertEquals("", viewModel.uiState.label)
        assertEquals("", viewModel.uiState.street)
    }

    @Test
    fun `error del servicio se muestra en errorMessage`() = runTest {
        val fake = FakeAddressFormManage(Result.failure(Exception("server error")))
        val viewModel = AddressFormViewModel(fake)
        viewModel.uiState = viewModel.uiState.copy(
            label = "Casa",
            street = "Av. Siempreviva",
            number = "742",
            city = "Springfield"
        )

        val result = viewModel.save()

        assertTrue(result.isFailure)
        assertNotNull(viewModel.errorMessage)
    }
}
