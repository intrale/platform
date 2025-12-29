package ui.sc.delivery

import asdo.auth.ToDoResetLoginCache
import asdo.delivery.DeliveryProfile
import asdo.delivery.DeliveryProfileData
import asdo.delivery.DeliveryVehicle
import asdo.delivery.DeliveryZone
import asdo.delivery.ToDoGetDeliveryProfile
import asdo.delivery.ToDoUpdateDeliveryProfile
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

private val testLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

class DeliveryProfileViewModelTest {

    @Test
    fun `loadProfile actualiza el estado con datos de dominio`() = runTest {
        val viewModel = DeliveryProfileViewModel(
            getDeliveryProfile = FakeGetProfile(),
            updateDeliveryProfile = FakeUpdateProfile(),
            toDoResetLoginCache = FakeResetLoginCache(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadProfile()

        assertFalse(viewModel.state.loading)
        assertEquals("Rita Rider", viewModel.state.form.fullName)
        assertEquals("Centro", viewModel.state.zones.first().name)
    }

    @Test
    fun `saveProfile marca éxito al persistir`() = runTest {
        val viewModel = DeliveryProfileViewModel(
            getDeliveryProfile = FakeGetProfile(),
            updateDeliveryProfile = FakeUpdateProfile(),
            toDoResetLoginCache = FakeResetLoginCache(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadProfile()
        viewModel.saveProfile()

        assertFalse(viewModel.state.saving)
        assertEquals(MessageKey.delivery_profile_saved, viewModel.state.successKey)
    }

    @Test
    fun `logout limpia caché de sesión`() = runTest {
        val reset = FakeResetLoginCache()
        val viewModel = DeliveryProfileViewModel(
            getDeliveryProfile = FakeGetProfile(),
            updateDeliveryProfile = FakeUpdateProfile(),
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

private class FakeResetLoginCache : ToDoResetLoginCache {
    var called: Boolean = false
    override suspend fun execute() {
        called = true
    }
}
