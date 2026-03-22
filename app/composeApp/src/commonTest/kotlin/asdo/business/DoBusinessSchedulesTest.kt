package asdo.business

import ar.com.intrale.shared.business.BusinessSchedulesDTO
import ar.com.intrale.shared.business.DayScheduleDTO
import ar.com.intrale.shared.business.UpdateBusinessSchedulesRequest
import ext.business.CommBusinessSchedulesService
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private val sampleSchedules = BusinessSchedulesDTO(
    businessId = "biz-1",
    schedules = listOf(
        DayScheduleDTO(day = "lunes", isOpen = true, openTime = "09:00", closeTime = "18:00"),
        DayScheduleDTO(day = "sabado", isOpen = false, openTime = "00:00", closeTime = "23:59")
    )
)

// region DoGetBusinessSchedules

class DoGetBusinessSchedulesTest {

    private fun fakeService(result: Result<BusinessSchedulesDTO>) = object : CommBusinessSchedulesService {
        override suspend fun getSchedules(businessId: String) = result
        override suspend fun updateSchedules(
            businessId: String,
            request: UpdateBusinessSchedulesRequest
        ): Result<BusinessSchedulesDTO> = Result.failure(NotImplementedError())
    }

    @Test
    fun `consulta exitosa retorna los horarios del negocio`() = runTest {
        val sut = DoGetBusinessSchedules(fakeService(Result.success(sampleSchedules)))

        val result = sut.execute("biz-1")

        assertTrue(result.isSuccess)
        assertEquals(2, result.getOrThrow().schedules.size)
        assertEquals("lunes", result.getOrThrow().schedules.first().day)
    }

    @Test
    fun `consulta fallida retorna error`() = runTest {
        val sut = DoGetBusinessSchedules(fakeService(Result.failure(RuntimeException("not found"))))

        val result = sut.execute("biz-1")

        assertTrue(result.isFailure)
    }
}

// endregion

// region DoUpdateBusinessSchedules

class DoUpdateBusinessSchedulesTest {

    private fun fakeService(result: Result<BusinessSchedulesDTO>) = object : CommBusinessSchedulesService {
        override suspend fun getSchedules(businessId: String): Result<BusinessSchedulesDTO> =
            Result.failure(NotImplementedError())
        override suspend fun updateSchedules(
            businessId: String,
            request: UpdateBusinessSchedulesRequest
        ): Result<BusinessSchedulesDTO> = result
    }

    @Test
    fun `actualizacion exitosa retorna horarios actualizados`() = runTest {
        val updated = sampleSchedules.copy(
            schedules = listOf(DayScheduleDTO(day = "lunes", isOpen = true, openTime = "08:00", closeTime = "20:00"))
        )
        val sut = DoUpdateBusinessSchedules(fakeService(Result.success(updated)))

        val request = UpdateBusinessSchedulesRequest(
            schedules = listOf(DayScheduleDTO(day = "lunes", isOpen = true, openTime = "08:00", closeTime = "20:00"))
        )
        val result = sut.execute("biz-1", request)

        assertTrue(result.isSuccess)
        assertEquals("08:00", result.getOrThrow().schedules.first().openTime)
    }

    @Test
    fun `actualizacion fallida retorna error`() = runTest {
        val sut = DoUpdateBusinessSchedules(fakeService(Result.failure(RuntimeException("server error"))))

        val request = UpdateBusinessSchedulesRequest(
            schedules = listOf(DayScheduleDTO(day = "lunes", isOpen = true, openTime = "09:00", closeTime = "18:00"))
        )
        val result = sut.execute("biz-1", request)

        assertTrue(result.isFailure)
    }
}

// endregion
