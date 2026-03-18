package asdo.business

import ar.com.intrale.shared.business.BusinessConfigDTO
import ar.com.intrale.shared.business.UpdateBusinessConfigRequest
import ext.business.CommBusinessConfigService
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private val sampleConfig = BusinessConfigDTO(
    businessId = "biz-1",
    name = "Mi Negocio",
    address = "Av. Siempre Viva 742",
    phone = "+54 11 1234-5678",
    email = "contacto@minegocio.com",
    logoUrl = "https://example.com/logo.png"
)

// region DoGetBusinessConfig

class DoGetBusinessConfigTest {

    private fun fakeService(result: Result<BusinessConfigDTO>) = object : CommBusinessConfigService {
        override suspend fun getConfig(businessId: String) = result
        override suspend fun updateConfig(
            businessId: String,
            request: UpdateBusinessConfigRequest
        ): Result<BusinessConfigDTO> = Result.failure(NotImplementedError())
    }

    @Test
    fun `consulta exitosa retorna configuracion del negocio`() = runTest {
        val sut = DoGetBusinessConfig(fakeService(Result.success(sampleConfig)))

        val result = sut.execute("biz-1")

        assertTrue(result.isSuccess)
        assertEquals("Mi Negocio", result.getOrThrow().name)
        assertEquals("biz-1", result.getOrThrow().businessId)
    }

    @Test
    fun `consulta fallida retorna error`() = runTest {
        val sut = DoGetBusinessConfig(fakeService(Result.failure(RuntimeException("not found"))))

        val result = sut.execute("biz-1")

        assertTrue(result.isFailure)
    }
}

// endregion

// region DoUpdateBusinessConfig

class DoUpdateBusinessConfigTest {

    private fun fakeService(result: Result<BusinessConfigDTO>) = object : CommBusinessConfigService {
        override suspend fun getConfig(businessId: String): Result<BusinessConfigDTO> =
            Result.failure(NotImplementedError())
        override suspend fun updateConfig(
            businessId: String,
            request: UpdateBusinessConfigRequest
        ): Result<BusinessConfigDTO> = result
    }

    @Test
    fun `actualizacion exitosa retorna configuracion actualizada`() = runTest {
        val updated = sampleConfig.copy(name = "Nuevo Nombre")
        val sut = DoUpdateBusinessConfig(fakeService(Result.success(updated)))

        val request = UpdateBusinessConfigRequest(
            name = "Nuevo Nombre",
            address = sampleConfig.address,
            phone = sampleConfig.phone,
            email = sampleConfig.email,
            logoUrl = sampleConfig.logoUrl
        )
        val result = sut.execute("biz-1", request)

        assertTrue(result.isSuccess)
        assertEquals("Nuevo Nombre", result.getOrThrow().name)
    }

    @Test
    fun `actualizacion fallida retorna error`() = runTest {
        val sut = DoUpdateBusinessConfig(fakeService(Result.failure(RuntimeException("server error"))))

        val request = UpdateBusinessConfigRequest(
            name = "Test",
            address = "Calle 123",
            phone = "123",
            email = "test@test.com"
        )
        val result = sut.execute("biz-1", request)

        assertTrue(result.isFailure)
    }
}

// endregion
