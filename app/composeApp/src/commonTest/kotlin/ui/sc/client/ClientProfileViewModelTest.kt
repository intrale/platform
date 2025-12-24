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
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

private val sampleData = ClientProfileData(
    profile = ClientProfile(fullName = "Jane Doe", email = "jane@intrale.com", phone = "+5411123456", defaultAddressId = "addr-1"),
    addresses = listOf(
        ClientAddress(
            id = "addr-1",
            label = "Casa",
            line1 = "Calle 123",
            city = "Buenos Aires",
            isDefault = true
        )
    ),
    preferences = ClientPreferences(language = "es")
)

class ClientProfileViewModelTest {

    @Test
    fun `loadProfile actualiza el estado con los datos del caso de uso`() = runTest {
        val viewModel = ClientProfileViewModel(
            getClientProfile = FakeGetProfile(),
            updateClientProfile = FakeUpdateProfile(),
            manageClientAddress = FakeManageAddress(),
            toDoResetLoginCache = FakeResetLoginCache()
        )

        viewModel.loadProfile()

        assertFalse(viewModel.state.loading)
        assertEquals("Jane Doe", viewModel.state.profileForm.fullName)
        assertEquals("jane@intrale.com", viewModel.state.profileForm.email)
        assertEquals(1, viewModel.state.addresses.size)
        assertTrue(viewModel.state.addresses.first().isDefault)
    }

    @Test
    fun `logout limpia el estado del store`() = runTest {
        val reset = FakeResetLoginCache()
        val viewModel = ClientProfileViewModel(
            getClientProfile = FakeGetProfile(),
            updateClientProfile = FakeUpdateProfile(),
            manageClientAddress = FakeManageAddress(),
            toDoResetLoginCache = reset
        )

        viewModel.logout()

        assertTrue(reset.called)
    }
}

private class FakeGetProfile : ToDoGetClientProfile {
    override suspend fun execute(): Result<ClientProfileData> = Result.success(sampleData)
}

private class FakeUpdateProfile : ToDoUpdateClientProfile {
    override suspend fun execute(profile: ClientProfile, preferences: ClientPreferences): Result<ClientProfileData> =
        Result.success(sampleData.copy(profile = profile, preferences = preferences))
}

private class FakeManageAddress : ToDoManageClientAddress {
    override suspend fun execute(action: ManageAddressAction): Result<ClientProfileData> = Result.success(sampleData)
}

private class FakeResetLoginCache : ToDoResetLoginCache {
    var called = false
    override suspend fun execute() {
        called = true
    }
}
