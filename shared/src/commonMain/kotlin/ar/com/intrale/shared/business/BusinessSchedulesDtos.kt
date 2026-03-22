package ar.com.intrale.shared.business

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.Serializable

@Serializable
data class DayScheduleDTO(
    val day: String = "",
    val isOpen: Boolean = false,
    val openTime: String = "00:00",
    val closeTime: String = "23:59"
)

@Serializable
data class BusinessSchedulesDTO(
    val businessId: String = "",
    val schedules: List<DayScheduleDTO> = emptyList()
)

@Serializable
data class UpdateBusinessSchedulesRequest(
    val schedules: List<DayScheduleDTO>
)

@Serializable
data class GetBusinessSchedulesResponse(
    val statusCode: StatusCodeDTO,
    val schedules: BusinessSchedulesDTO
)

@Serializable
data class UpdateBusinessSchedulesResponse(
    val statusCode: StatusCodeDTO,
    val schedules: BusinessSchedulesDTO
)
