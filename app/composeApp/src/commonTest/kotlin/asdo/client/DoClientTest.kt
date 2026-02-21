package asdo.client

import ext.client.*
import ext.dto.StatusCodeDTO
import ext.storage.CommKeyValueStorage
import ext.storage.model.ClientProfileCache
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private class FakeStorage(initialToken: String? = null) : CommKeyValueStorage {
    override var token: String? = initialToken
    override var profileCache: ClientProfileCache? = null
    override var preferredLanguage: String? = null
    override var onboardingCompleted: Boolean = false
}

private class FakeProfileService(
    private val fetchResult: Result<ClientProfileResponse> = Result.success(
        ClientProfileResponse(StatusCodeDTO(200, "OK"), ClientProfileDTO(fullName = "Test", email = "test@test.com"))
    ),
    private val updateResult: Result<ClientProfileResponse> = Result.success(
        ClientProfileResponse(StatusCodeDTO(200, "OK"), ClientProfileDTO(fullName = "Updated", email = "test@test.com"))
    )
) : CommClientProfileService {
    override suspend fun fetchProfile() = fetchResult
    override suspend fun updateProfile(profile: ClientProfileDTO, preferences: ClientPreferencesDTO) = updateResult
}

private class FakeAddressesService(
    private val listResult: Result<List<ClientAddressDTO>> = Result.success(emptyList()),
    private val createResult: Result<ClientAddressDTO> = Result.success(ClientAddressDTO(id = "addr-1")),
    private val updateResult: Result<ClientAddressDTO> = Result.success(ClientAddressDTO(id = "addr-1")),
    private val deleteResult: Result<Unit> = Result.success(Unit),
    private val markDefaultResult: Result<ClientAddressDTO> = Result.success(ClientAddressDTO(id = "addr-1", isDefault = true))
) : CommClientAddressesService {
    override suspend fun listAddresses() = listResult
    override suspend fun createAddress(address: ClientAddressDTO) = createResult
    override suspend fun updateAddress(address: ClientAddressDTO) = updateResult
    override suspend fun deleteAddress(addressId: String) = deleteResult
    override suspend fun markDefault(addressId: String) = markDefaultResult
}

// region DoGetClientProfile

class DoGetClientProfileTest {

    @Test
    fun `obtener perfil exitoso retorna datos del cliente`() = runTest {
        val storage = FakeStorage()
        val sut = DoGetClientProfile(FakeProfileService(), FakeAddressesService(), storage)

        val result = sut.execute()

        assertTrue(result.isSuccess)
        assertEquals("Test", result.getOrThrow().profile.fullName)
    }

    @Test
    fun `obtener perfil guarda en cache`() = runTest {
        val storage = FakeStorage()
        val sut = DoGetClientProfile(FakeProfileService(), FakeAddressesService(), storage)

        sut.execute()

        assertEquals("Test", storage.profileCache?.fullName)
    }

    @Test
    fun `obtener perfil fallido retorna ClientExceptionResponse`() = runTest {
        val storage = FakeStorage()
        val failingProfileService = FakeProfileService(fetchResult = Result.failure(RuntimeException("Network error")))
        val sut = DoGetClientProfile(failingProfileService, FakeAddressesService(), storage)

        val result = sut.execute()

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is ClientExceptionResponse)
    }
}

// endregion

// region DoUpdateClientProfile

class DoUpdateClientProfileTest {

    @Test
    fun `actualizar perfil exitoso retorna datos actualizados`() = runTest {
        val storage = FakeStorage()
        val sut = DoUpdateClientProfile(FakeProfileService(), FakeAddressesService(), storage)

        val result = sut.execute(
            ClientProfile(fullName = "Updated", email = "test@test.com"),
            ClientPreferences(language = "en")
        )

        assertTrue(result.isSuccess)
    }

    @Test
    fun `actualizar perfil fallido retorna ClientExceptionResponse`() = runTest {
        val storage = FakeStorage()
        val failingProfileService = FakeProfileService(updateResult = Result.failure(RuntimeException("Error")))
        val sut = DoUpdateClientProfile(failingProfileService, FakeAddressesService(), storage)

        val result = sut.execute(ClientProfile(), ClientPreferences())

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is ClientExceptionResponse)
    }
}

// endregion

// region DoManageClientAddress

class DoManageClientAddressTest {

    @Test
    fun `crear direccion retorna perfil actualizado`() = runTest {
        val storage = FakeStorage()
        val sut = DoManageClientAddress(FakeProfileService(), FakeAddressesService(), storage)
        val address = ClientAddress(label = "Casa", street = "Calle 1", number = "100", city = "CABA")

        val result = sut.execute(ManageAddressAction.Create(address))

        assertTrue(result.isSuccess)
    }

    @Test
    fun `eliminar direccion retorna perfil actualizado`() = runTest {
        val storage = FakeStorage()
        val sut = DoManageClientAddress(FakeProfileService(), FakeAddressesService(), storage)

        val result = sut.execute(ManageAddressAction.Delete("addr-1"))

        assertTrue(result.isSuccess)
    }

    @Test
    fun `marcar default retorna perfil actualizado`() = runTest {
        val storage = FakeStorage()
        val sut = DoManageClientAddress(FakeProfileService(), FakeAddressesService(), storage)

        val result = sut.execute(ManageAddressAction.MarkDefault("addr-1"))

        assertTrue(result.isSuccess)
    }

    @Test
    fun `error al gestionar direccion retorna ClientExceptionResponse`() = runTest {
        val storage = FakeStorage()
        val failingAddresses = FakeAddressesService(createResult = Result.failure(RuntimeException("Error")))
        val sut = DoManageClientAddress(FakeProfileService(), failingAddresses, storage)
        val address = ClientAddress(label = "Casa", street = "Calle 1", number = "100", city = "CABA")

        val result = sut.execute(ManageAddressAction.Create(address))

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is ClientExceptionResponse)
    }
}

// endregion
