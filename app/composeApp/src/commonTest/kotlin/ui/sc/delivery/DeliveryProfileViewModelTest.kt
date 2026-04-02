package ui.sc.delivery

import asdo.auth.ToDoResetLoginCache
import asdo.delivery.DeliveryProfile
import asdo.delivery.DeliveryProfileData
import asdo.delivery.DeliveryVehicle
import asdo.delivery.DeliveryZone
import asdo.delivery.DeliveryAvailabilityBlock
import asdo.delivery.DeliveryAvailabilityConfig
import asdo.delivery.DeliveryAvailabilityMode
import asdo.delivery.DeliveryAvailabilitySlot
import asdo.delivery.ToDoGetDeliveryProfile
import asdo.delivery.ToDoUpdateDeliveryProfile
import asdo.delivery.ToDoGetDeliveryAvailability
import asdo.delivery.ToDoUpdateDeliveryAvailability
import ar.com.intrale.strings.model.MessageKey
import kotlinx.datetime.DayOfWeek
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

private val sampleProfile = DeliveryProfile(
    fullName = "Rita Rider",
    email = "rita@example.com",
    phone = "+541145667788",
    vehicle = DeliveryVehicle(type = "Moto", model = "Yamaha", plate = "AB123CD")
)

private val sampleData = DeliveryProfileData(
    profile = sampleProfile,
    zones = listOf(DeliveryZone(id = "zone-1", name = "Centro", description = "Cobertura urbana"))
)

private val sampleAvailability = DeliveryAvailabilityConfig(
    timezone = "America/Argentina/Buenos_Aires",
    slots = listOf(
        DeliveryAvailabilitySlot(
            dayOfWeek = kotlinx.datetime.DayOfWeek.MONDAY,
            mode = DeliveryAvailabilityMode.BLOCK,
            block = DeliveryAvailabilityBlock.MORNING,
            start = "06:00",
            end = "12:00"
        )
    )
)

private val testLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

class DeliveryProfileViewModelTest {

    @Test
    fun `loadProfile actualiza el estado con datos de dominio`() = runTest {
        val viewModel = DeliveryProfileViewModel(
            getDeliveryProfile = FakeGetProfile(),
            updateDeliveryProfile = FakeUpdateProfile(),
            getDeliveryAvailability = FakeGetAvailability(),
            updateDeliveryAvailability = FakeUpdateAvailability(),
            toDoResetLoginCache = FakeResetLoginCache(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadProfile()

        assertFalse(viewModel.state.loading)
        assertEquals("Rita Rider", viewModel.state.form.fullName)
        assertEquals("Centro", viewModel.state.zones.first().name)
        assertEquals("America/Argentina/Buenos_Aires", viewModel.state.availability.timezone)
        assertTrue(viewModel.state.availability.slots.first().enabled)
    }

    @Test
    fun `saveProfile marca éxito al persistir`() = runTest {
        val viewModel = DeliveryProfileViewModel(
            getDeliveryProfile = FakeGetProfile(),
            updateDeliveryProfile = FakeUpdateProfile(),
            getDeliveryAvailability = FakeGetAvailability(),
            updateDeliveryAvailability = FakeUpdateAvailability(),
            toDoResetLoginCache = FakeResetLoginCache(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadProfile()
        viewModel.saveProfile()

        assertFalse(viewModel.state.saving)
        assertEquals(MessageKey.delivery_availability_saved, viewModel.state.successKey)
    }

    @Test
    fun `logout limpia caché de sesión`() = runTest {
        val reset = FakeResetLoginCache()
        val viewModel = DeliveryProfileViewModel(
            getDeliveryProfile = FakeGetProfile(),
            updateDeliveryProfile = FakeUpdateProfile(),
            getDeliveryAvailability = FakeGetAvailability(),
            updateDeliveryAvailability = FakeUpdateAvailability(),
            toDoResetLoginCache = reset,
            loggerFactory = testLoggerFactory
        )

        viewModel.logout()

        assertTrue(reset.called)
    }

    @Test
    fun `onNameChange actualiza el nombre en el formulario`() {
        val viewModel = createViewModel()
        viewModel.onNameChange("Nuevo Nombre")
        assertEquals("Nuevo Nombre", viewModel.state.form.fullName)
    }

    @Test
    fun `onEmailChange actualiza el email en el formulario`() {
        val viewModel = createViewModel()
        viewModel.onEmailChange("nuevo@email.com")
        assertEquals("nuevo@email.com", viewModel.state.form.email)
    }

    @Test
    fun `onPhoneChange actualiza el telefono en el formulario`() {
        val viewModel = createViewModel()
        viewModel.onPhoneChange("+5491155556677")
        assertEquals("+5491155556677", viewModel.state.form.phone)
    }

    @Test
    fun `onVehicleTypeChange actualiza tipo de vehiculo`() {
        val viewModel = createViewModel()
        viewModel.onVehicleTypeChange("Auto")
        assertEquals("Auto", viewModel.state.form.vehicleType)
    }

    @Test
    fun `onVehicleModelChange actualiza modelo de vehiculo`() {
        val viewModel = createViewModel()
        viewModel.onVehicleModelChange("Toyota Corolla")
        assertEquals("Toyota Corolla", viewModel.state.form.vehicleModel)
    }

    @Test
    fun `onVehiclePlateChange actualiza patente del vehiculo`() {
        val viewModel = createViewModel()
        viewModel.onVehiclePlateChange("AB123CD")
        assertEquals("AB123CD", viewModel.state.form.vehiclePlate)
    }

    @Test
    fun `onTimezoneChange actualiza timezone y limpia error de disponibilidad`() {
        val viewModel = createViewModel()
        viewModel.onTimezoneChange("America/Argentina/Cordoba")
        assertEquals("America/Argentina/Cordoba", viewModel.state.availability.timezone)
        assertNull(viewModel.state.availabilityErrorKey)
    }

    @Test
    fun `onToggleDay habilita un dia con rangos por defecto`() {
        val viewModel = createViewModel()
        viewModel.onToggleDay(DayOfWeek.TUESDAY, true)
        val tuesdaySlot = viewModel.state.availability.slots.first { it.dayOfWeek == DayOfWeek.TUESDAY }
        assertTrue(tuesdaySlot.enabled)
        assertEquals("06:00", tuesdaySlot.start)
        assertEquals("12:00", tuesdaySlot.end)
    }

    @Test
    fun `onToggleDay deshabilita un dia`() {
        val viewModel = createViewModel()
        viewModel.onToggleDay(DayOfWeek.WEDNESDAY, true)
        viewModel.onToggleDay(DayOfWeek.WEDNESDAY, false)
        val wedSlot = viewModel.state.availability.slots.first { it.dayOfWeek == DayOfWeek.WEDNESDAY }
        assertFalse(wedSlot.enabled)
    }

    @Test
    fun `onBlockSelected configura bloque tarde con rangos correctos`() {
        val viewModel = createViewModel()
        viewModel.onBlockSelected(DayOfWeek.MONDAY, DeliveryAvailabilityBlock.AFTERNOON)
        val slot = viewModel.state.availability.slots.first { it.dayOfWeek == DayOfWeek.MONDAY }
        assertTrue(slot.enabled)
        assertEquals(DeliveryAvailabilityMode.BLOCK, slot.mode)
        assertEquals(DeliveryAvailabilityBlock.AFTERNOON, slot.block)
        assertEquals("12:00", slot.start)
        assertEquals("18:00", slot.end)
    }

    @Test
    fun `onBlockSelected configura bloque noche con rangos correctos`() {
        val viewModel = createViewModel()
        viewModel.onBlockSelected(DayOfWeek.FRIDAY, DeliveryAvailabilityBlock.NIGHT)
        val slot = viewModel.state.availability.slots.first { it.dayOfWeek == DayOfWeek.FRIDAY }
        assertEquals("18:00", slot.start)
        assertEquals("23:00", slot.end)
    }

    @Test
    fun `onCustomSelected cambia modo a custom manteniendo dia habilitado`() {
        val viewModel = createViewModel()
        viewModel.onCustomSelected(DayOfWeek.THURSDAY)
        val slot = viewModel.state.availability.slots.first { it.dayOfWeek == DayOfWeek.THURSDAY }
        assertTrue(slot.enabled)
        assertEquals(DeliveryAvailabilityMode.CUSTOM, slot.mode)
    }

    @Test
    fun `onCustomStartChange y onCustomEndChange actualizan horarios custom`() {
        val viewModel = createViewModel()
        viewModel.onCustomSelected(DayOfWeek.SATURDAY)
        viewModel.onCustomStartChange(DayOfWeek.SATURDAY, "08:30")
        viewModel.onCustomEndChange(DayOfWeek.SATURDAY, "16:45")
        val slot = viewModel.state.availability.slots.first { it.dayOfWeek == DayOfWeek.SATURDAY }
        assertEquals("08:30", slot.start)
        assertEquals("16:45", slot.end)
    }

    @Test
    fun `loadProfile con error en perfil muestra mensaje de error`() = runTest {
        val viewModel = DeliveryProfileViewModel(
            getDeliveryProfile = FakeGetProfileError("Error de conexion"),
            updateDeliveryProfile = FakeUpdateProfile(),
            getDeliveryAvailability = FakeGetAvailability(),
            updateDeliveryAvailability = FakeUpdateAvailability(),
            toDoResetLoginCache = FakeResetLoginCache(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadProfile()

        assertFalse(viewModel.state.loading)
        assertEquals("Error de conexion", viewModel.state.error)
    }

    @Test
    fun `loadProfile con error en disponibilidad carga perfil pero muestra error`() = runTest {
        val viewModel = DeliveryProfileViewModel(
            getDeliveryProfile = FakeGetProfile(),
            updateDeliveryProfile = FakeUpdateProfile(),
            getDeliveryAvailability = FakeGetAvailabilityError("Error disponibilidad"),
            updateDeliveryAvailability = FakeUpdateAvailability(),
            toDoResetLoginCache = FakeResetLoginCache(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadProfile()

        assertFalse(viewModel.state.loading)
        assertEquals("Rita Rider", viewModel.state.form.fullName)
        assertEquals("Error disponibilidad", viewModel.state.error)
    }

    @Test
    fun `saveProfile con error en perfil muestra error y no guarda`() = runTest {
        val viewModel = DeliveryProfileViewModel(
            getDeliveryProfile = FakeGetProfile(),
            updateDeliveryProfile = FakeUpdateProfileError("Fallo al guardar"),
            getDeliveryAvailability = FakeGetAvailability(),
            updateDeliveryAvailability = FakeUpdateAvailability(),
            toDoResetLoginCache = FakeResetLoginCache(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadProfile()
        viewModel.saveProfile()

        assertFalse(viewModel.state.saving)
        assertEquals("Fallo al guardar", viewModel.state.error)
    }

    @Test
    fun `saveProfile con error en disponibilidad muestra error`() = runTest {
        val viewModel = DeliveryProfileViewModel(
            getDeliveryProfile = FakeGetProfile(),
            updateDeliveryProfile = FakeUpdateProfile(),
            getDeliveryAvailability = FakeGetAvailability(),
            updateDeliveryAvailability = FakeUpdateAvailabilityError("Fallo disponibilidad"),
            toDoResetLoginCache = FakeResetLoginCache(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadProfile()
        viewModel.onToggleDay(DayOfWeek.MONDAY, true)
        viewModel.saveProfile()

        assertFalse(viewModel.state.saving)
        assertEquals("Fallo disponibilidad", viewModel.state.error)
    }

    @Test
    fun `saveProfile con formulario vacio no persiste por validacion`() = runTest {
        val viewModel = createViewModel()
        // No cargar perfil, dejar formulario vacío
        viewModel.saveProfile()

        // No debería haber guardado porque la validación falla
        assertNull(viewModel.state.successKey)
    }

    @Test
    fun `getState retorna el formulario actual`() {
        val viewModel = createViewModel()
        viewModel.onNameChange("Test")
        val result = viewModel.getState()
        assertTrue(result is DeliveryProfileForm)
        assertEquals("Test", (result as DeliveryProfileForm).fullName)
    }

    private fun createViewModel() = DeliveryProfileViewModel(
        getDeliveryProfile = FakeGetProfile(),
        updateDeliveryProfile = FakeUpdateProfile(),
        getDeliveryAvailability = FakeGetAvailability(),
        updateDeliveryAvailability = FakeUpdateAvailability(),
        toDoResetLoginCache = FakeResetLoginCache(),
        loggerFactory = testLoggerFactory
    )
}

private class FakeGetProfile : ToDoGetDeliveryProfile {
    override suspend fun execute(): Result<DeliveryProfileData> = Result.success(sampleData)
}

private class FakeUpdateProfile : ToDoUpdateDeliveryProfile {
    override suspend fun execute(profile: DeliveryProfile): Result<DeliveryProfileData> =
        Result.success(sampleData.copy(profile = profile))
}

private class FakeGetAvailability : ToDoGetDeliveryAvailability {
    override suspend fun execute(): Result<DeliveryAvailabilityConfig> = Result.success(sampleAvailability)
}

private class FakeUpdateAvailability : ToDoUpdateDeliveryAvailability {
    override suspend fun execute(config: DeliveryAvailabilityConfig): Result<DeliveryAvailabilityConfig> =
        Result.success(config)
}

private class FakeResetLoginCache : ToDoResetLoginCache {
    var called: Boolean = false
    override suspend fun execute() {
        called = true
    }
}

private class FakeGetProfileError(private val msg: String) : ToDoGetDeliveryProfile {
    override suspend fun execute(): Result<DeliveryProfileData> =
        Result.failure(RuntimeException(msg))
}

private class FakeGetAvailabilityError(private val msg: String) : ToDoGetDeliveryAvailability {
    override suspend fun execute(): Result<DeliveryAvailabilityConfig> =
        Result.failure(RuntimeException(msg))
}

private class FakeUpdateProfileError(private val msg: String) : ToDoUpdateDeliveryProfile {
    override suspend fun execute(profile: DeliveryProfile): Result<DeliveryProfileData> =
        Result.failure(RuntimeException(msg))
}

private class FakeUpdateAvailabilityError(private val msg: String) : ToDoUpdateDeliveryAvailability {
    override suspend fun execute(config: DeliveryAvailabilityConfig): Result<DeliveryAvailabilityConfig> =
        Result.failure(RuntimeException(msg))
}
