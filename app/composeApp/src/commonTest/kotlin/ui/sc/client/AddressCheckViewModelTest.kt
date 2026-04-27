package ui.sc.client

import asdo.client.ToDoCheckAddress
import asdo.client.ZoneCheckCoordinates
import asdo.client.ZoneCheckException
import asdo.client.ZoneCheckResult
import ext.location.CommLocationProvider
import ext.location.LocationOutcome
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Clock
import kotlinx.datetime.Instant
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Tests para [AddressCheckViewModel] — issue #2422.
 *
 * Cubre:
 * - CA-2: rationale + fallback manual.
 * - CA-3 / CA-4: estados positivos/negativos.
 * - CA-5: descarte de la posición tras 5 min en background.
 * - CA-6: rechazo de shippingCost fuera de rango.
 * - CA-11: estado de error → reintento.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AddressCheckViewModelTest {

    private class FakeToDoCheckAddress(
        var nextResult: Result<ZoneCheckResult>
    ) : ToDoCheckAddress {
        var calls: Int = 0
        override suspend fun execute(coordinates: ZoneCheckCoordinates): Result<ZoneCheckResult> {
            calls += 1
            return nextResult
        }
    }

    private class FakeLocationProvider(
        var coarse: LocationOutcome = LocationOutcome.Unavailable,
        var geocode: LocationOutcome = LocationOutcome.NotFound,
    ) : CommLocationProvider {
        override fun isAvailable(): Boolean = true
        override suspend fun requestCoarseLocation(): LocationOutcome = coarse
        override suspend fun geocodeAddress(query: String): LocationOutcome = geocode
    }

    private class FixedClock(var instant: Instant) : Clock {
        override fun now(): Instant = instant
    }

    @BeforeTest
    fun setUp() {
        AddressCheckStore.reset()
    }

    @AfterTest
    fun tearDown() {
        AddressCheckStore.reset()
    }

    private fun newVm(
        check: ToDoCheckAddress = FakeToDoCheckAddress(
            Result.success(ZoneCheckResult(inZone = true, shippingCost = 1500.0, etaMinutes = 30))
        ),
        location: CommLocationProvider = FakeLocationProvider(),
        clock: Clock = FixedClock(Instant.parse("2026-04-21T12:00:00Z")),
        scope: CoroutineScope? = null,
    ) = AddressCheckViewModel(
        checkAddress = check,
        locationProvider = location,
        clock = clock,
        coroutineScope = scope,
    )

    // region ── CA-2 rationale + fallback manual

    @Test
    fun `openRationale lleva el step a Rationale y abre el sheet`() {
        val vm = newVm()
        vm.openRationale()
        assertEquals(AddressCheckStep.Rationale, vm.state.step)
        assertTrue(vm.state.rationaleVisible)
    }

    @Test
    fun `chooseManualEntry oculta el sheet y va a ManualInput`() {
        val vm = newVm()
        vm.openRationale()

        vm.chooseManualEntry()

        assertEquals(AddressCheckStep.ManualInput, vm.state.step)
        assertFalse(vm.state.rationaleVisible)
    }

    @Test
    fun `permiso denegado deriva al fallback manual`() = runTest {
        val vm = newVm()
        vm.openRationale()
        vm.onPermissionRequestRequested()

        vm.onPermissionResult(granted = false)

        assertEquals(AddressCheckStep.ManualInput, vm.state.step)
    }

    // endregion

    // region ── CA-3 resultado positivo + store

    @Test
    fun `estado del VM refleja carga y luego resultado positivo`() = runTest {
        val check = FakeToDoCheckAddress(
            Result.success(ZoneCheckResult(inZone = true, shippingCost = 2000.0, etaMinutes = 25))
        )
        val location = FakeLocationProvider(
            coarse = LocationOutcome.Coordinates(latitude = -34.6, longitude = -58.4)
        )
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        val vm = newVm(check = check, location = location, scope = scope)

        vm.openRationale()
        vm.onPermissionRequestRequested()
        vm.onPermissionResult(granted = true)

        assertEquals(AddressCheckStep.ResultPositive, vm.state.step)
        assertEquals(1, check.calls)
        assertEquals(2000.0, vm.state.lastResult?.shippingCost)
        // Banner del catálogo debe quedar verificado
        assertEquals(AddressCheckStore.Phase.Verified, AddressCheckStore.state.value.phase)
    }

    // endregion

    // region ── CA-4 resultado negativo

    @Test
    fun `estado del VM refleja fuera de zona y habilita boton ver mapa`() = runTest {
        val check = FakeToDoCheckAddress(
            Result.success(ZoneCheckResult(inZone = false))
        )
        val location = FakeLocationProvider(
            coarse = LocationOutcome.Coordinates(latitude = -34.6, longitude = -58.4)
        )
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        val vm = newVm(check = check, location = location, scope = scope)

        vm.openRationale()
        vm.onPermissionRequestRequested()
        vm.onPermissionResult(granted = true)

        assertEquals(AddressCheckStep.ResultNegative, vm.state.step)
        assertEquals(AddressCheckStore.Phase.OutOfZone, AddressCheckStore.state.value.phase)

        vm.showZonesPlaceholder()
        assertTrue(vm.state.placeholderToastVisible)
    }

    @Test
    fun `tryAnotherAddress reinicia store y vuelve a ManualInput`() = runTest {
        val vm = newVm()
        AddressCheckStore.markVerified(
            ZoneCheckResult(inZone = false), nowMillis = 1L
        )

        vm.tryAnotherAddress()

        assertEquals(AddressCheckStep.ManualInput, vm.state.step)
        assertEquals(AddressCheckStore.Phase.Pending, AddressCheckStore.state.value.phase)
    }

    // endregion

    // region ── CA-11 error de red + reintento

    @Test
    fun `estado del VM refleja error de red y habilita reintento`() = runTest {
        val check = FakeToDoCheckAddress(
            Result.failure(ZoneCheckException.Network())
        )
        val location = FakeLocationProvider(
            coarse = LocationOutcome.Coordinates(latitude = -34.6, longitude = -58.4)
        )
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        val vm = newVm(check = check, location = location, scope = scope)

        vm.openRationale()
        vm.onPermissionRequestRequested()
        vm.onPermissionResult(granted = true)

        assertEquals(AddressCheckStep.ResultError, vm.state.step)
        assertEquals(AddressCheckViewModel.GENERIC_ERROR, vm.state.lastErrorMessage)

        // El reintento debe llevar de vuelta a ManualInput si no hubo
        // dirección manual previa (porque el camino fue GPS).
        vm.retry()
        assertEquals(AddressCheckStep.ManualInput, vm.state.step)
    }

    @Test
    fun `retry reusa la ultima direccion manual`() = runTest {
        val check = FakeToDoCheckAddress(
            Result.success(ZoneCheckResult(inZone = true, shippingCost = 0.0))
        )
        val location = FakeLocationProvider(
            geocode = LocationOutcome.Coordinates(latitude = -34.6, longitude = -58.4)
        )
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        val vm = newVm(check = check, location = location, scope = scope)

        vm.chooseManualEntry()
        vm.onManualAddressChange("Av. Corrientes 1234")
        vm.submitManualAddress()
        // Ahora simulemos un error y retry usando la misma dirección.
        check.nextResult = Result.failure(ZoneCheckException.Network())
        vm.onManualAddressChange("Av. Corrientes 1234")
        vm.submitManualAddress()
        assertEquals(AddressCheckStep.ResultError, vm.state.step)

        // Vuelve la red y al reintentar usa la última dirección.
        check.nextResult =
            Result.success(ZoneCheckResult(inZone = true, shippingCost = 1000.0))
        vm.retry()

        assertEquals(AddressCheckStep.ResultPositive, vm.state.step)
    }

    // endregion

    // region ── CA-5 background timeout

    @Test
    fun `estado del VM descarta posicion tras 5 min en background`() {
        // Usamos un baseline > 0 porque el watchdog ignora el caso 0L
        // (estado sin verificación previa).
        val baseline = 1_000_000L
        AddressCheckStore.markVerified(
            ZoneCheckResult(inZone = true, shippingCost = 1000.0),
            nowMillis = baseline,
        )
        assertEquals(AddressCheckStore.Phase.Verified, AddressCheckStore.state.value.phase)

        // 4 minutos: aún no se descarta.
        AddressCheckStore.maybeClearOnResume(nowMillis = baseline + 4 * 60_000L)
        assertEquals(AddressCheckStore.Phase.Verified, AddressCheckStore.state.value.phase)

        // 5 min y 1 ms: se descarta.
        AddressCheckStore.maybeClearOnResume(nowMillis = baseline + 5 * 60_000L + 1L)
        assertEquals(AddressCheckStore.Phase.Pending, AddressCheckStore.state.value.phase)
    }

    // endregion

    // region ── CA-6 shippingCost fuera de rango

    @Test
    fun `VM rechaza shippingCost fuera de rango 0,100000`() = runTest {
        val check = FakeToDoCheckAddress(
            Result.failure(ZoneCheckException.OutOfRange)
        )
        val location = FakeLocationProvider(
            geocode = LocationOutcome.Coordinates(latitude = -34.6, longitude = -58.4)
        )
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        val vm = newVm(check = check, location = location, scope = scope)

        vm.chooseManualEntry()
        vm.onManualAddressChange("Av. Corrientes 1234")
        vm.submitManualAddress()

        assertEquals(AddressCheckStep.ResultError, vm.state.step)
        assertEquals(AddressCheckViewModel.GENERIC_ERROR, vm.state.lastErrorMessage)
        // El store NO debe quedar verificado con datos podridos.
        assertEquals(AddressCheckStore.Phase.Pending, AddressCheckStore.state.value.phase)
    }

    @Test
    fun `submitManualAddress vacio marca error de input requerido`() = runTest {
        val vm = newVm()
        vm.chooseManualEntry()
        vm.onManualAddressChange("   ")

        vm.submitManualAddress()

        assertEquals(AddressCheckStep.ManualInput, vm.state.step)
        assertEquals(AddressCheckViewModel.MIN_QUERY_ERROR, vm.state.manualAddressError)
    }

    @Test
    fun `geocoder no encuentra direccion devuelve helper sin cambiar fase`() = runTest {
        val location = FakeLocationProvider(geocode = LocationOutcome.NotFound)
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        val vm = newVm(location = location, scope = scope)

        vm.chooseManualEntry()
        vm.onManualAddressChange("xkjxkjxkjx")
        vm.submitManualAddress()

        assertEquals(AddressCheckStep.ManualInput, vm.state.step)
        assertEquals(AddressCheckViewModel.NOT_FOUND_ERROR, vm.state.manualAddressError)
    }

    // endregion

    // region ── Bloqueo de carrito

    @Test
    fun `cart blocked dialog se abre y se cierra`() {
        val vm = newVm()
        assertFalse(vm.state.cartBlockedVisible)
        vm.showCartBlocked()
        assertTrue(vm.state.cartBlockedVisible)
        vm.dismissCartBlocked()
        assertFalse(vm.state.cartBlockedVisible)
    }

    @Test
    fun `acceptPositiveResult limpia el flujo y deja el banner verificado`() {
        val vm = newVm()
        AddressCheckStore.markVerified(
            ZoneCheckResult(inZone = true, shippingCost = 1500.0),
            nowMillis = 1L
        )
        vm.openRationale()

        vm.acceptPositiveResult()

        assertEquals(AddressCheckStep.Idle, vm.state.step)
        assertNull(vm.state.lastResult)
        // El store NO se limpia: el catálogo necesita el banner verificado.
        assertEquals(AddressCheckStore.Phase.Verified, AddressCheckStore.state.value.phase)
    }

    // endregion
}
