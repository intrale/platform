package ar.com.intrale.shared.business

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.Serializable

@Serializable
data class DayScheduleDTO(
    val day: String = "",
    val isOpen: Boolean = false,
    val openTime: String = "00:00",
    val closeTime: String = "23:59",
    val hasSplitSchedule: Boolean = false,
    val openTime2: String = "",
    val closeTime2: String = ""
)

@Serializable
data class BusinessSchedulesDTO(
    val businessId: String = "",
    val schedules: List<DayScheduleDTO> = emptyList(),
    val temporarilyClosed: Boolean = false,
    val reopenDate: String = ""
)

@Serializable
data class UpdateBusinessSchedulesRequest(
    val schedules: List<DayScheduleDTO>,
    val temporarilyClosed: Boolean = false,
    val reopenDate: String = ""
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
