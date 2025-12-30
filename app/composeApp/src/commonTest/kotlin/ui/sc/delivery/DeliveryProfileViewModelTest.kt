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
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
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
