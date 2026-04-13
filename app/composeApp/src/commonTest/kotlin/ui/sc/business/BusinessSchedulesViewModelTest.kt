package ui.sc.business

import ar.com.intrale.shared.business.BusinessSchedulesDTO
import ar.com.intrale.shared.business.DayScheduleDTO
import ar.com.intrale.shared.business.UpdateBusinessSchedulesRequest
import asdo.business.ToDoGetBusinessSchedules
import asdo.business.ToDoUpdateBusinessSchedules
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend

private val testLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

/**
 * Tests para BusinessSchedulesViewModel — lógica de gestión de
 * horarios de atención del negocio (issue #1914).
 */
class BusinessSchedulesViewModelTest {

    // region Fakes

    private var getResult: Result<BusinessSchedulesDTO> = Result.success(BusinessSchedulesDTO())
    private var updateResult: Result<BusinessSchedulesDTO> = Result.success(BusinessSchedulesDTO())
    private var lastUpdateRequest: UpdateBusinessSchedulesRequest? = null

    private val fakeGet = object : ToDoGetBusinessSchedules {
        override suspend fun execute(businessId: String): Result<BusinessSchedulesDTO> = getResult
    }

    private val fakeUpdate = object : ToDoUpdateBusinessSchedules {
        override suspend fun execute(
            businessId: String,
            request: UpdateBusinessSchedulesRequest
        ): Result<BusinessSchedulesDTO> {
            lastUpdateRequest = request
            return updateResult
        }
    }

    private lateinit var vm: BusinessSchedulesViewModel

    @BeforeTest
    fun setup() {
        getResult = Result.success(BusinessSchedulesDTO())
        updateResult = Result.success(BusinessSchedulesDTO())
        lastUpdateRequest = null
        vm = BusinessSchedulesViewModel(fakeGet, fakeUpdate, testLoggerFactory)
    }

    // endregion

    // region Estado inicial

    @Test
    fun `estado inicial tiene 7 dias con defaults lunes a viernes abiertos`() {
        val schedules = vm.state.schedules
        assertEquals(7, schedules.size)
        assertTrue(schedules[0].isOpen) // lunes
        assertTrue(schedules[4].isOpen) // viernes
        assertFalse(schedules[5].isOpen) // sabado
        assertFalse(schedules[6].isOpen) // domingo
        assertEquals(BusinessSchedulesStatus.Idle, vm.state.status)
        assertFalse(vm.state.temporarilyClosed)
    }

    @Test
    fun `getState retorna el state actual`() {
        assertEquals(vm.state, vm.getState())
    }

    @Test
    fun `initInputState inicializa mapa vacio`() {
        vm.initInputState()
        assertTrue(vm.inputsStates.isEmpty())
    }

    // endregion

    // region toggleDayOpen

    @Test
    fun `toggleDayOpen cambia estado de dia`() {
        assertFalse(vm.state.schedules[5].isOpen) // sabado cerrado
        vm.toggleDayOpen(5, true)
        assertTrue(vm.state.schedules[5].isOpen)
        vm.toggleDayOpen(5, false)
        assertFalse(vm.state.schedules[5].isOpen)
    }

    @Test
    fun `toggleDayOpen no afecta otros dias`() {
        val before = vm.state.schedules.map { it.isOpen }
        vm.toggleDayOpen(0, false)
        val after = vm.state.schedules.map { it.isOpen }
        assertFalse(after[0])
        // Los demas dias no cambiaron
        for (i in 1 until 7) {
            assertEquals(before[i], after[i])
        }
    }

    // endregion

    // region updateOpenTime / updateCloseTime

    @Test
    fun `updateOpenTime actualiza hora de apertura del dia indicado`() {
        vm.updateOpenTime(0, "08:00")
        assertEquals("08:00", vm.state.schedules[0].openTime)
    }

    @Test
    fun `updateCloseTime actualiza hora de cierre del dia indicado`() {
        vm.updateCloseTime(0, "22:00")
        assertEquals("22:00", vm.state.schedules[0].closeTime)
    }

    @Test
    fun `updateOpenTime no afecta otros dias`() {
        vm.updateOpenTime(2, "07:30")
        assertEquals("09:00", vm.state.schedules[0].openTime)
        assertEquals("07:30", vm.state.schedules[2].openTime)
    }

    // endregion

    // region Split schedule

    @Test
    fun `toggleSplitSchedule activa horario cortado`() {
        assertFalse(vm.state.schedules[0].hasSplitSchedule)
        vm.toggleSplitSchedule(0, true)
        assertTrue(vm.state.schedules[0].hasSplitSchedule)
    }

    @Test
    fun `updateOpenTime2 y updateCloseTime2 actualizan segunda franja`() {
        vm.updateOpenTime2(0, "16:00")
        vm.updateCloseTime2(0, "20:00")
        assertEquals("16:00", vm.state.schedules[0].openTime2)
        assertEquals("20:00", vm.state.schedules[0].closeTime2)
    }

    // endregion

    // region Cierre temporal

    @Test
    fun `toggleTemporarilyClosed cambia estado de cierre temporal`() {
        assertFalse(vm.state.temporarilyClosed)
        vm.toggleTemporarilyClosed(true)
        assertTrue(vm.state.temporarilyClosed)
        vm.toggleTemporarilyClosed(false)
        assertFalse(vm.state.temporarilyClosed)
    }

    @Test
    fun `updateReopenDate actualiza fecha de reapertura`() {
        vm.updateReopenDate("2026-04-20")
        assertEquals("2026-04-20", vm.state.reopenDate)
    }

    // endregion

    // region loadSchedules

    @Test
    fun `loadSchedules con businessId null retorna MissingBusiness`() = runTest {
        vm.loadSchedules(null)
        assertEquals(BusinessSchedulesStatus.MissingBusiness, vm.state.status)
    }

    @Test
    fun `loadSchedules con businessId vacio retorna MissingBusiness`() = runTest {
        vm.loadSchedules("")
        assertEquals(BusinessSchedulesStatus.MissingBusiness, vm.state.status)
    }

    @Test
    fun `loadSchedules exitoso con datos carga horarios del backend`() = runTest {
        val schedules = listOf(
            DayScheduleDTO(day = "lunes", isOpen = true, openTime = "10:00", closeTime = "20:00"),
            DayScheduleDTO(day = "martes", isOpen = false, openTime = "00:00", closeTime = "00:00")
        )
        getResult = Result.success(
            BusinessSchedulesDTO(
                businessId = "biz-1",
                schedules = schedules,
                temporarilyClosed = true,
                reopenDate = "2026-05-01"
            )
        )

        vm.loadSchedules("biz-1")

        assertEquals(BusinessSchedulesStatus.Loaded, vm.state.status)
        assertEquals(2, vm.state.schedules.size)
        assertEquals("lunes", vm.state.schedules[0].day)
        assertEquals("10:00", vm.state.schedules[0].openTime)
        assertEquals("20:00", vm.state.schedules[0].closeTime)
        assertFalse(vm.state.schedules[1].isOpen)
        assertTrue(vm.state.temporarilyClosed)
        assertEquals("2026-05-01", vm.state.reopenDate)
    }

    @Test
    fun `loadSchedules exitoso con lista vacia usa defaults`() = runTest {
        getResult = Result.success(
            BusinessSchedulesDTO(
                businessId = "biz-1",
                schedules = emptyList()
            )
        )

        vm.loadSchedules("biz-1")

        assertEquals(BusinessSchedulesStatus.Loaded, vm.state.status)
        assertEquals(7, vm.state.schedules.size)
        assertEquals("lunes", vm.state.schedules[0].day)
    }

    @Test
    fun `loadSchedules fallido setea status Error`() = runTest {
        getResult = Result.failure(RuntimeException("timeout"))

        vm.loadSchedules("biz-1")

        val status = vm.state.status
        assertTrue(status is BusinessSchedulesStatus.Error)
        assertTrue((status as BusinessSchedulesStatus.Error).message.contains("timeout"))
    }

    // endregion

    // region saveSchedules

    @Test
    fun `saveSchedules con businessId null retorna MissingBusiness y failure`() = runTest {
        val result = vm.saveSchedules(null)
        assertTrue(result.isFailure)
        assertEquals(BusinessSchedulesStatus.MissingBusiness, vm.state.status)
    }

    @Test
    fun `saveSchedules con businessId vacio retorna MissingBusiness`() = runTest {
        val result = vm.saveSchedules("  ")
        assertTrue(result.isFailure)
        assertEquals(BusinessSchedulesStatus.MissingBusiness, vm.state.status)
    }

    @Test
    fun `saveSchedules exitoso envia request correcto y actualiza estado`() = runTest {
        // Modificar estado local antes de guardar
        vm.toggleDayOpen(5, true) // abrir sabado
        vm.updateOpenTime(5, "10:00")
        vm.updateCloseTime(5, "14:00")
        vm.toggleTemporarilyClosed(false)

        val responseSchedules = listOf(
            DayScheduleDTO(day = "sabado", isOpen = true, openTime = "10:00", closeTime = "14:00")
        )
        updateResult = Result.success(
            BusinessSchedulesDTO(
                businessId = "biz-1",
                schedules = responseSchedules,
                temporarilyClosed = false,
                reopenDate = ""
            )
        )

        val result = vm.saveSchedules("biz-1")

        assertTrue(result.isSuccess)
        assertEquals(BusinessSchedulesStatus.Saved, vm.state.status)
        // Verifica que el request enviado tiene 7 dias
        assertEquals(7, lastUpdateRequest!!.schedules.size)
        // El sabado fue modificado
        assertTrue(lastUpdateRequest!!.schedules[5].isOpen)
    }

    @Test
    fun `saveSchedules exitoso con response vacio mantiene schedules locales`() = runTest {
        updateResult = Result.success(
            BusinessSchedulesDTO(
                businessId = "biz-1",
                schedules = emptyList(),
                temporarilyClosed = false,
                reopenDate = ""
            )
        )

        val result = vm.saveSchedules("biz-1")

        assertTrue(result.isSuccess)
        assertEquals(BusinessSchedulesStatus.Saved, vm.state.status)
        // Mantiene los schedules locales (7 defaults)
        assertEquals(7, vm.state.schedules.size)
    }

    @Test
    fun `saveSchedules fallido setea status Error`() = runTest {
        updateResult = Result.failure(RuntimeException("server error"))

        val result = vm.saveSchedules("biz-1")

        assertTrue(result.isFailure)
        val status = vm.state.status
        assertTrue(status is BusinessSchedulesStatus.Error)
        assertTrue((status as BusinessSchedulesStatus.Error).message.contains("server error"))
    }

    @Test
    fun `saveSchedules envia temporarilyClosed y reopenDate`() = runTest {
        vm.toggleTemporarilyClosed(true)
        vm.updateReopenDate("2026-06-01")

        updateResult = Result.success(
            BusinessSchedulesDTO(
                businessId = "biz-1",
                schedules = emptyList(),
                temporarilyClosed = true,
                reopenDate = "2026-06-01"
            )
        )

        vm.saveSchedules("biz-1")

        assertTrue(lastUpdateRequest!!.temporarilyClosed)
        assertEquals("2026-06-01", lastUpdateRequest!!.reopenDate)
    }

    // endregion

    // region Flujo completo

    @Test
    fun `flujo completo - cargar, modificar, guardar`() = runTest {
        // 1. Cargar horarios existentes
        val existingSchedules = listOf(
            DayScheduleDTO(day = "lunes", isOpen = true, openTime = "09:00", closeTime = "18:00"),
            DayScheduleDTO(day = "martes", isOpen = true, openTime = "09:00", closeTime = "18:00"),
            DayScheduleDTO(day = "miercoles", isOpen = true, openTime = "09:00", closeTime = "18:00"),
            DayScheduleDTO(day = "jueves", isOpen = true, openTime = "09:00", closeTime = "18:00"),
            DayScheduleDTO(day = "viernes", isOpen = true, openTime = "09:00", closeTime = "18:00"),
            DayScheduleDTO(day = "sabado", isOpen = false),
            DayScheduleDTO(day = "domingo", isOpen = false)
        )
        getResult = Result.success(BusinessSchedulesDTO(businessId = "biz-1", schedules = existingSchedules))

        vm.loadSchedules("biz-1")
        assertEquals(BusinessSchedulesStatus.Loaded, vm.state.status)

        // 2. Modificar: abrir sabado con horario cortado
        vm.toggleDayOpen(5, true)
        vm.updateOpenTime(5, "09:00")
        vm.updateCloseTime(5, "13:00")
        vm.toggleSplitSchedule(5, true)
        vm.updateOpenTime2(5, "17:00")
        vm.updateCloseTime2(5, "20:00")

        assertTrue(vm.state.schedules[5].isOpen)
        assertTrue(vm.state.schedules[5].hasSplitSchedule)

        // 3. Guardar
        updateResult = Result.success(
            BusinessSchedulesDTO(
                businessId = "biz-1",
                schedules = existingSchedules.toMutableList().apply {
                    set(5, DayScheduleDTO(
                        day = "sabado", isOpen = true,
                        openTime = "09:00", closeTime = "13:00",
                        hasSplitSchedule = true, openTime2 = "17:00", closeTime2 = "20:00"
                    ))
                }
            )
        )

        val result = vm.saveSchedules("biz-1")
        assertTrue(result.isSuccess)
        assertEquals(BusinessSchedulesStatus.Saved, vm.state.status)
    }

    // endregion
}
