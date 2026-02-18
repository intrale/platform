package asdo.delivery

import ext.delivery.*
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private class FakeDeliveryProfileService(
    private val fetchResult: Result<DeliveryProfileResponse> = Result.success(
        DeliveryProfileResponse(
            profile = DeliveryProfileDTO(fullName = "Driver Test", email = "driver@test.com"),
            zones = listOf(DeliveryZoneDTO(id = "z1", name = "Zona Norte"))
        )
    ),
    private val updateResult: Result<DeliveryProfileResponse> = Result.success(
        DeliveryProfileResponse(
            profile = DeliveryProfileDTO(fullName = "Driver Updated", email = "driver@test.com"),
            zones = emptyList()
        )
    )
) : CommDeliveryProfileService {
    override suspend fun fetchProfile() = fetchResult
    override suspend fun updateProfile(profile: DeliveryProfileDTO) = updateResult
}

private class FakeDeliveryAvailabilityService(
    private val fetchResult: Result<DeliveryAvailabilityDTO> = Result.success(
        DeliveryAvailabilityDTO(timezone = "America/Argentina/Buenos_Aires", slots = emptyList())
    ),
    private val updateResult: Result<DeliveryAvailabilityDTO> = Result.success(
        DeliveryAvailabilityDTO(timezone = "America/Argentina/Buenos_Aires", slots = emptyList())
    )
) : CommDeliveryAvailabilityService {
    override suspend fun fetchAvailability() = fetchResult
    override suspend fun updateAvailability(config: DeliveryAvailabilityDTO) = updateResult
}

// region DoGetDeliveryProfile

class DoGetDeliveryProfileTest {

    @Test
    fun `obtener perfil exitoso retorna datos del repartidor`() = runTest {
        val sut = DoGetDeliveryProfile(FakeDeliveryProfileService())

        val result = sut.execute()

        assertTrue(result.isSuccess)
        assertEquals("Driver Test", result.getOrThrow().profile.fullName)
        assertEquals(1, result.getOrThrow().zones.size)
    }

    @Test
    fun `obtener perfil fallido retorna DeliveryExceptionResponse`() = runTest {
        val sut = DoGetDeliveryProfile(FakeDeliveryProfileService(fetchResult = Result.failure(RuntimeException("Error"))))

        val result = sut.execute()

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is DeliveryExceptionResponse)
    }
}

// endregion

// region DoUpdateDeliveryProfile

class DoUpdateDeliveryProfileTest {

    @Test
    fun `actualizar perfil exitoso retorna datos actualizados`() = runTest {
        val sut = DoUpdateDeliveryProfile(FakeDeliveryProfileService())

        val result = sut.execute(DeliveryProfile(fullName = "Updated", email = "driver@test.com"))

        assertTrue(result.isSuccess)
        assertEquals("Driver Updated", result.getOrThrow().profile.fullName)
    }

    @Test
    fun `actualizar perfil fallido retorna DeliveryExceptionResponse`() = runTest {
        val sut = DoUpdateDeliveryProfile(
            FakeDeliveryProfileService(updateResult = Result.failure(RuntimeException("Error")))
        )

        val result = sut.execute(DeliveryProfile())

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is DeliveryExceptionResponse)
    }
}

// endregion

// region DoGetDeliveryAvailability

class DoGetDeliveryAvailabilityTest {

    @Test
    fun `obtener disponibilidad exitoso retorna config`() = runTest {
        val sut = DoGetDeliveryAvailability(FakeDeliveryAvailabilityService())

        val result = sut.execute()

        assertTrue(result.isSuccess)
        assertEquals("America/Argentina/Buenos_Aires", result.getOrThrow().timezone)
    }

    @Test
    fun `obtener disponibilidad fallido retorna DeliveryExceptionResponse`() = runTest {
        val sut = DoGetDeliveryAvailability(
            FakeDeliveryAvailabilityService(fetchResult = Result.failure(RuntimeException("Error")))
        )

        val result = sut.execute()

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is DeliveryExceptionResponse)
    }
}

// endregion

// region DoUpdateDeliveryAvailability

class DoUpdateDeliveryAvailabilityTest {

    @Test
    fun `actualizar disponibilidad exitoso retorna config`() = runTest {
        val sut = DoUpdateDeliveryAvailability(FakeDeliveryAvailabilityService())

        val result = sut.execute(DeliveryAvailabilityConfig(timezone = "UTC"))

        assertTrue(result.isSuccess)
    }

    @Test
    fun `actualizar disponibilidad fallido retorna DeliveryExceptionResponse`() = runTest {
        val sut = DoUpdateDeliveryAvailability(
            FakeDeliveryAvailabilityService(updateResult = Result.failure(RuntimeException("Error")))
        )

        val result = sut.execute(DeliveryAvailabilityConfig())

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is DeliveryExceptionResponse)
    }
}

// endregion
