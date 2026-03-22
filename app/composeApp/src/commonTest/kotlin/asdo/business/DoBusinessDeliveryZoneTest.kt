package asdo.business

import ar.com.intrale.shared.business.BusinessDeliveryZoneDTO
import ar.com.intrale.shared.business.BusinessDeliveryZoneType
import ar.com.intrale.shared.business.UpdateBusinessDeliveryZoneRequest
import ext.business.CommBusinessDeliveryZoneService
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private val sampleZoneRadius = BusinessDeliveryZoneDTO(
    businessId = "biz-1",
    type = BusinessDeliveryZoneType.RADIUS,
    radiusKm = 10.0,
    postalCodes = emptyList()
)

private val sampleZonePostal = BusinessDeliveryZoneDTO(
    businessId = "biz-1",
    type = BusinessDeliveryZoneType.POSTAL_CODES,
    radiusKm = 0.0,
    postalCodes = listOf("1414", "1415", "1416")
)

// region DoGetBusinessDeliveryZone

class DoGetBusinessDeliveryZoneTest {

    private fun fakeService(result: Result<BusinessDeliveryZoneDTO>) = object : CommBusinessDeliveryZoneService {
        override suspend fun getDeliveryZone(businessId: String) = result
        override suspend fun updateDeliveryZone(
            businessId: String,
            request: UpdateBusinessDeliveryZoneRequest
        ): Result<BusinessDeliveryZoneDTO> = Result.failure(NotImplementedError())
    }

    @Test
    fun `consulta exitosa retorna zona de entrega con radio`() = runTest {
        val sut = DoGetBusinessDeliveryZone(fakeService(Result.success(sampleZoneRadius)))

        val result = sut.execute("biz-1")

        assertTrue(result.isSuccess)
        assertEquals(BusinessDeliveryZoneType.RADIUS, result.getOrThrow().type)
        assertEquals(10.0, result.getOrThrow().radiusKm)
    }

    @Test
    fun `consulta exitosa retorna zona de entrega con codigos postales`() = runTest {
        val sut = DoGetBusinessDeliveryZone(fakeService(Result.success(sampleZonePostal)))

        val result = sut.execute("biz-1")

        assertTrue(result.isSuccess)
        assertEquals(BusinessDeliveryZoneType.POSTAL_CODES, result.getOrThrow().type)
        assertEquals(3, result.getOrThrow().postalCodes.size)
    }

    @Test
    fun `consulta fallida retorna error`() = runTest {
        val sut = DoGetBusinessDeliveryZone(fakeService(Result.failure(RuntimeException("not found"))))

        val result = sut.execute("biz-1")

        assertTrue(result.isFailure)
    }
}

// endregion

// region DoUpdateBusinessDeliveryZone

class DoUpdateBusinessDeliveryZoneTest {

    private fun fakeService(result: Result<BusinessDeliveryZoneDTO>) = object : CommBusinessDeliveryZoneService {
        override suspend fun getDeliveryZone(businessId: String): Result<BusinessDeliveryZoneDTO> =
            Result.failure(NotImplementedError())
        override suspend fun updateDeliveryZone(
            businessId: String,
            request: UpdateBusinessDeliveryZoneRequest
        ): Result<BusinessDeliveryZoneDTO> = result
    }

    @Test
    fun `actualizacion exitosa retorna zona actualizada con radio`() = runTest {
        val updated = sampleZoneRadius.copy(radiusKm = 15.0)
        val sut = DoUpdateBusinessDeliveryZone(fakeService(Result.success(updated)))

        val request = UpdateBusinessDeliveryZoneRequest(
            type = BusinessDeliveryZoneType.RADIUS,
            radiusKm = 15.0
        )
        val result = sut.execute("biz-1", request)

        assertTrue(result.isSuccess)
        assertEquals(15.0, result.getOrThrow().radiusKm)
    }

    @Test
    fun `actualizacion exitosa retorna zona actualizada con codigos postales`() = runTest {
        val updated = sampleZonePostal.copy(postalCodes = listOf("1414", "1415"))
        val sut = DoUpdateBusinessDeliveryZone(fakeService(Result.success(updated)))

        val request = UpdateBusinessDeliveryZoneRequest(
            type = BusinessDeliveryZoneType.POSTAL_CODES,
            postalCodes = listOf("1414", "1415")
        )
        val result = sut.execute("biz-1", request)

        assertTrue(result.isSuccess)
        assertEquals(2, result.getOrThrow().postalCodes.size)
    }

    @Test
    fun `actualizacion fallida retorna error`() = runTest {
        val sut = DoUpdateBusinessDeliveryZone(fakeService(Result.failure(RuntimeException("server error"))))

        val request = UpdateBusinessDeliveryZoneRequest(type = BusinessDeliveryZoneType.RADIUS, radiusKm = 5.0)
        val result = sut.execute("biz-1", request)

        assertTrue(result.isFailure)
    }
}

// endregion
