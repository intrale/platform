package ui.sc.business

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import ar.com.intrale.shared.business.DayScheduleDTO
import ar.com.intrale.shared.business.UpdateBusinessSchedulesRequest
import asdo.business.ToDoGetBusinessSchedules
import asdo.business.ToDoUpdateBusinessSchedules
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

sealed interface BusinessSchedulesStatus {
    data object Idle : BusinessSchedulesStatus
    data object Loading : BusinessSchedulesStatus
    data object Loaded : BusinessSchedulesStatus
    data object Saving : BusinessSchedulesStatus
    data object Saved : BusinessSchedulesStatus
    data object MissingBusiness : BusinessSchedulesStatus
    data class Error(val message: String) : BusinessSchedulesStatus
}

data class DayScheduleUiState(
    val day: String = "",
    val isOpen: Boolean = false,
    val openTime: String = "09:00",
    val closeTime: String = "18:00",
    val hasSplitSchedule: Boolean = false,
    val openTime2: String = "17:00",
    val closeTime2: String = "21:00"
)

data class BusinessSchedulesUiState(
    val schedules: List<DayScheduleUiState> = defaultSchedules(),
    val status: BusinessSchedulesStatus = BusinessSchedulesStatus.Idle,
    val temporarilyClosed: Boolean = false,
    val reopenDate: String = ""
)

private fun defaultSchedules(): List<DayScheduleUiState> = listOf(
    DayScheduleUiState(day = "lunes", isOpen = true),
    DayScheduleUiState(day = "martes", isOpen = true),
    DayScheduleUiState(day = "miercoles", isOpen = true),
    DayScheduleUiState(day = "jueves", isOpen = true),
    DayScheduleUiState(day = "viernes", isOpen = true),
    DayScheduleUiState(day = "sabado", isOpen = false),
    DayScheduleUiState(day = "domingo", isOpen = false)
)

class BusinessSchedulesViewModel(
    private val toDoGetBusinessSchedules: ToDoGetBusinessSchedules = DIManager.di.direct.instance(),
    private val toDoUpdateBusinessSchedules: ToDoUpdateBusinessSchedules = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<BusinessSchedulesViewModel>()

    var state by mutableStateOf(BusinessSchedulesUiState())
        private set

    override fun getState(): Any = state

    override fun initInputState() {
        inputsStates = mutableMapOf()
    }

    fun toggleDayOpen(index: Int, isOpen: Boolean) {
        val updated = state.schedules.toMutableList()
        updated[index] = updated[index].copy(isOpen = isOpen)
        state = state.copy(schedules = updated)
    }

    fun updateOpenTime(index: Int, time: String) {
        val updated = state.schedules.toMutableList()
        updated[index] = updated[index].copy(openTime = time)
        state = state.copy(schedules = updated)
    }

    fun updateCloseTime(index: Int, time: String) {
        val updated = state.schedules.toMutableList()
        updated[index] = updated[index].copy(closeTime = time)
        state = state.copy(schedules = updated)
    }

    fun toggleSplitSchedule(index: Int, hasSplit: Boolean) {
        val updated = state.schedules.toMutableList()
        updated[index] = updated[index].copy(hasSplitSchedule = hasSplit)
        state = state.copy(schedules = updated)
    }

    fun updateOpenTime2(index: Int, time: String) {
        val updated = state.schedules.toMutableList()
        updated[index] = updated[index].copy(openTime2 = time)
        state = state.copy(schedules = updated)
    }

    fun updateCloseTime2(index: Int, time: String) {
        val updated = state.schedules.toMutableList()
        updated[index] = updated[index].copy(closeTime2 = time)
        state = state.copy(schedules = updated)
    }

    fun toggleTemporarilyClosed(closed: Boolean) {
        state = state.copy(temporarilyClosed = closed)
    }

    fun updateReopenDate(date: String) {
        state = state.copy(reopenDate = date)
    }

    suspend fun loadSchedules(businessId: String?) {
        if (businessId.isNullOrBlank()) {
            state = state.copy(status = BusinessSchedulesStatus.MissingBusiness)
            return
        }
        state = state.copy(status = BusinessSchedulesStatus.Loading)
        toDoGetBusinessSchedules.execute(businessId)
            .onSuccess { dto ->
                val loaded = if (dto.schedules.isNotEmpty()) {
                    dto.schedules.map { s ->
                        DayScheduleUiState(
                            day = s.day,
                            isOpen = s.isOpen,
                            openTime = s.openTime,
                            closeTime = s.closeTime,
                            hasSplitSchedule = s.hasSplitSchedule,
                            openTime2 = s.openTime2,
                            closeTime2 = s.closeTime2
                        )
                    }
                } else {
                    defaultSchedules()
                }
                state = state.copy(
                    schedules = loaded,
                    status = BusinessSchedulesStatus.Loaded,
                    temporarilyClosed = dto.temporarilyClosed,
                    reopenDate = dto.reopenDate
                )
            }
            .onFailure { error ->
                logger.error(error) { "Error al cargar horarios" }
                state = state.copy(status = BusinessSchedulesStatus.Error(error.message ?: "Error al cargar horarios"))
            }
    }

    suspend fun saveSchedules(businessId: String?): Result<Unit> {
        if (businessId.isNullOrBlank()) {
            state = state.copy(status = BusinessSchedulesStatus.MissingBusiness)
            return Result.failure(IllegalStateException("businessId requerido"))
        }
        state = state.copy(status = BusinessSchedulesStatus.Saving)
        val request = UpdateBusinessSchedulesRequest(
            schedules = state.schedules.map { s ->
                DayScheduleDTO(
                    day = s.day,
                    isOpen = s.isOpen,
                    openTime = s.openTime,
                    closeTime = s.closeTime,
                    hasSplitSchedule = s.hasSplitSchedule,
                    openTime2 = s.openTime2,
                    closeTime2 = s.closeTime2
                )
            },
            temporarilyClosed = state.temporarilyClosed,
            reopenDate = state.reopenDate
        )
        return toDoUpdateBusinessSchedules.execute(businessId, request)
            .map { dto ->
                val updated = dto.schedules.map { s ->
                    DayScheduleUiState(
                        day = s.day,
                        isOpen = s.isOpen,
                        openTime = s.openTime,
                        closeTime = s.closeTime,
                        hasSplitSchedule = s.hasSplitSchedule,
                        openTime2 = s.openTime2,
                        closeTime2 = s.closeTime2
                    )
                }
                state = state.copy(
                    schedules = if (updated.isNotEmpty()) updated else state.schedules,
                    status = BusinessSchedulesStatus.Saved,
                    temporarilyClosed = dto.temporarilyClosed,
                    reopenDate = dto.reopenDate
                )
            }
            .onFailure { error ->
                logger.error(error) { "Error al guardar horarios" }
                state = state.copy(status = BusinessSchedulesStatus.Error(error.message ?: "Error al guardar horarios"))
            }
    }
}
