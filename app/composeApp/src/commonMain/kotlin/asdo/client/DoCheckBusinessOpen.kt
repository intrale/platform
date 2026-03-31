package asdo.client

import ar.com.intrale.shared.business.BusinessSchedulesDTO
import ar.com.intrale.shared.business.DayScheduleDTO
import ext.business.CommBusinessSchedulesService
import kotlinx.datetime.Clock
import kotlinx.datetime.DayOfWeek
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

/**
 * Verifica si un negocio está abierto comparando la hora actual
 * con los horarios configurados para el día de la semana.
 */
class DoCheckBusinessOpen(
    private val service: CommBusinessSchedulesService,
    private val clock: Clock = Clock.System,
    private val timeZone: TimeZone = TimeZone.currentSystemDefault()
) : ToDoCheckBusinessOpen {

    private val logger = LoggerFactory.default.newLogger<DoCheckBusinessOpen>()

    override suspend fun execute(businessId: String): Result<BusinessOpenStatus> {
        return try {
            service.getSchedules(businessId)
                .map { dto -> evaluateStatus(dto) }
        } catch (e: Exception) {
            logger.error(e) { "Error al verificar estado del negocio $businessId" }
            Result.failure(e)
        }
    }

    internal fun evaluateStatus(dto: BusinessSchedulesDTO): BusinessOpenStatus {
        // Si está cerrado temporalmente, no importan los horarios
        if (dto.temporarilyClosed) {
            val reopenInfo = if (dto.reopenDate.isNotBlank()) {
                "Reabre el ${dto.reopenDate}"
            } else {
                "Cerrado temporalmente"
            }
            return BusinessOpenStatus(
                isOpen = false,
                temporarilyClosed = true,
                nextOpeningInfo = reopenInfo,
                reopenDate = dto.reopenDate
            )
        }

        val now = clock.now().toLocalDateTime(timeZone)
        val currentDayName = dayOfWeekToSpanish(now.dayOfWeek)
        val currentTime = "${now.hour.toString().padStart(2, '0')}:${now.minute.toString().padStart(2, '0')}"

        val todaySchedule = dto.schedules.firstOrNull {
            it.day.equals(currentDayName, ignoreCase = true)
        }

        // Verificar si está abierto ahora
        if (todaySchedule != null && todaySchedule.isOpen) {
            if (isInTimeRange(currentTime, todaySchedule.openTime, todaySchedule.closeTime)) {
                return BusinessOpenStatus(isOpen = true)
            }
            // Verificar segunda franja horaria (horario cortado)
            if (todaySchedule.hasSplitSchedule &&
                isInTimeRange(currentTime, todaySchedule.openTime2, todaySchedule.closeTime2)
            ) {
                return BusinessOpenStatus(isOpen = true)
            }
        }

        // Está cerrado — calcular próxima apertura
        val nextOpeningInfo = calculateNextOpening(dto.schedules, now.dayOfWeek, currentTime, todaySchedule)
        return BusinessOpenStatus(
            isOpen = false,
            nextOpeningInfo = nextOpeningInfo
        )
    }

    private fun calculateNextOpening(
        schedules: List<DayScheduleDTO>,
        currentDayOfWeek: DayOfWeek,
        currentTime: String,
        todaySchedule: DayScheduleDTO?
    ): String {
        // ¿Abre más tarde hoy?
        if (todaySchedule != null && todaySchedule.isOpen) {
            if (currentTime < todaySchedule.openTime) {
                return "Abre hoy a las ${todaySchedule.openTime}"
            }
            if (todaySchedule.hasSplitSchedule && currentTime < todaySchedule.openTime2) {
                return "Abre hoy a las ${todaySchedule.openTime2}"
            }
        }

        // Buscar en los próximos 7 días
        for (offset in 1..7) {
            val nextDay = DayOfWeek.entries[(currentDayOfWeek.ordinal + offset) % 7]
            val nextDayName = dayOfWeekToSpanish(nextDay)
            val nextSchedule = schedules.firstOrNull { it.day.equals(nextDayName, ignoreCase = true) }

            if (nextSchedule != null && nextSchedule.isOpen) {
                val dayLabel = if (offset == 1) "manana" else capitalizeFirst(nextDayName)
                return "Abre $dayLabel a las ${nextSchedule.openTime}"
            }
        }

        return "Sin horarios de apertura disponibles"
    }

    companion object {
        /**
         * Convierte DayOfWeek de Kotlin a nombre en español (minúsculas, sin tildes).
         * Los nombres coinciden con los que el usuario configura: lunes..domingo.
         */
        internal fun dayOfWeekToSpanish(day: DayOfWeek): String = when (day) {
            DayOfWeek.MONDAY -> "lunes"
            DayOfWeek.TUESDAY -> "martes"
            DayOfWeek.WEDNESDAY -> "miercoles"
            DayOfWeek.THURSDAY -> "jueves"
            DayOfWeek.FRIDAY -> "viernes"
            DayOfWeek.SATURDAY -> "sabado"
            DayOfWeek.SUNDAY -> "domingo"
            else -> "lunes"
        }

        /**
         * Verifica si una hora (HH:mm) está dentro de un rango horario (inclusivo-exclusivo).
         */
        internal fun isInTimeRange(current: String, open: String, close: String): Boolean {
            return current >= open && current < close
        }

        private fun capitalizeFirst(text: String): String =
            text.replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }
    }
}
