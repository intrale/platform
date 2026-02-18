package ui.sc.delivery

import asdo.auth.ToDoResetLoginCache
import asdo.delivery.DeliveryAvailabilityBlock
import asdo.delivery.DeliveryAvailabilityConfig
import asdo.delivery.DeliveryAvailabilityMode
import asdo.delivery.DeliveryAvailabilitySlot
import asdo.delivery.DeliveryProfile
import asdo.delivery.DeliveryProfileData
import asdo.delivery.DeliveryVehicle
import asdo.delivery.DeliveryZone
import asdo.delivery.ToDoGetDeliveryAvailability
import asdo.delivery.ToDoGetDeliveryProfile
import asdo.delivery.ToDoUpdateDeliveryAvailability
import asdo.delivery.ToDoUpdateDeliveryProfile
import ar.com.intrale.strings.model.MessageKey
import ext.delivery.CommDeliveryOrdersService
import ext.delivery.DeliveryOrderDTO
import ext.delivery.DeliveryOrdersSummaryDTO
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.DayOfWeek
import kotlinx.datetime.LocalDate
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend
import ui.session.SessionStore
import ui.session.UserRole
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

// --- Datos de ejemplo ---

private val sampleSummary = DeliveryOrdersSummaryDTO(pending = 3, inProgress = 2, delivered = 5)

private val sampleActiveOrders = listOf(
    DeliveryOrderDTO(id = "o1", publicId = "PUB-1", businessName = "Pizzeria", neighborhood = "Centro", status = "pending", eta = "12:00"),
    DeliveryOrderDTO(id = "o2", publicId = "PUB-2", businessName = "Farmacia", neighborhood = "Norte", status = "inprogress", eta = "11:30"),
    DeliveryOrderDTO(id = "o3", shortCode = "SC3", businessName = "Panaderia", neighborhood = "Sur", status = "assigned", eta = "13:00"),
    DeliveryOrderDTO(id = "o4", publicId = "PUB-4", businessName = "Verduleria", neighborhood = "Oeste", status = "pending", eta = "14:00"),
    DeliveryOrderDTO(id = "o5", publicId = "PUB-5", businessName = "Carniceria", neighborhood = "Este", status = "pending", eta = "15:00"),
    DeliveryOrderDTO(id = "o6", publicId = "PUB-6", businessName = "Libreria", neighborhood = "Centro", status = "pending", eta = "16:00"),
    DeliveryOrderDTO(id = "o7", publicId = "PUB-7", businessName = "Kiosco", neighborhood = "Norte", status = "delivered", eta = "10:00")
)

private val sampleProfileData = DeliveryProfileData(
    profile = DeliveryProfile(
        fullName = "Carlos Delivery",
        email = "carlos@example.com",
        phone = "+541145667788",
        vehicle = DeliveryVehicle(type = "Moto", model = "Honda CB", plate = "AB123CD")
    ),
    zones = listOf(DeliveryZone(id = "z1", name = "Centro", description = "Zona centrica"))
)

private val sampleAvailability = DeliveryAvailabilityConfig(
    timezone = "America/Argentina/Buenos_Aires",
    slots = listOf(
        DeliveryAvailabilitySlot(
            dayOfWeek = DayOfWeek.MONDAY,
            mode = DeliveryAvailabilityMode.BLOCK,
            block = DeliveryAvailabilityBlock.MORNING,
            start = "06:00",
            end = "12:00"
        )
    )
)

private val testLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

// --- Fakes para DeliveryHomeViewModel ---

private class FakeOrdersService(
    private val summaryResult: Result<DeliveryOrdersSummaryDTO> = Result.success(sampleSummary),
    private val activeResult: Result<List<DeliveryOrderDTO>> = Result.success(sampleActiveOrders),
    private val availableResult: Result<List<DeliveryOrderDTO>> = Result.success(emptyList())
) : CommDeliveryOrdersService {
    override suspend fun fetchSummary(date: LocalDate): Result<DeliveryOrdersSummaryDTO> = summaryResult
    override suspend fun fetchActiveOrders(): Result<List<DeliveryOrderDTO>> = activeResult
    override suspend fun fetchAvailableOrders(): Result<List<DeliveryOrderDTO>> = availableResult
}

// --- Fakes para DeliveryProfileViewModel ---

private class FakeGetDeliveryProfile(
    private val result: Result<DeliveryProfileData> = Result.success(sampleProfileData)
) : ToDoGetDeliveryProfile {
    override suspend fun execute(): Result<DeliveryProfileData> = result
}

private class FakeUpdateDeliveryProfile(
    private val result: Result<DeliveryProfileData> = Result.success(sampleProfileData)
) : ToDoUpdateDeliveryProfile {
    override suspend fun execute(profile: DeliveryProfile): Result<DeliveryProfileData> = result
}

private class FakeGetDeliveryAvailability(
    private val result: Result<DeliveryAvailabilityConfig> = Result.success(sampleAvailability)
) : ToDoGetDeliveryAvailability {
    override suspend fun execute(): Result<DeliveryAvailabilityConfig> = result
}

private class FakeUpdateDeliveryAvailability(
    private val result: Result<DeliveryAvailabilityConfig> = Result.success(sampleAvailability)
) : ToDoUpdateDeliveryAvailability {
    override suspend fun execute(config: DeliveryAvailabilityConfig): Result<DeliveryAvailabilityConfig> = result
}

private class FakeResetCache : ToDoResetLoginCache {
    var called: Boolean = false
    override suspend fun execute() {
        called = true
    }
}

// ==================== Tests DeliveryHomeViewModel ====================

class DeliveryHomeViewModelTest {

    @BeforeTest
    fun setUp() {
        SessionStore.clear()
    }

    @Test
    fun `loadData exitoso carga resumen y ordenes`() = runTest {
        SessionStore.updateRole(UserRole.Delivery)
        val viewModel = DeliveryHomeViewModel(ordersService = FakeOrdersService())

        viewModel.loadData()

        val summaryState = viewModel.state.summaryState
        assertTrue(summaryState is DeliverySummaryState.Loaded)
        assertEquals(3, summaryState.summary.pending)
        assertEquals(2, summaryState.summary.inProgress)
        assertEquals(5, summaryState.summary.delivered)

        val activeState = viewModel.state.activeOrdersState
        assertTrue(activeState is DeliveryActiveOrdersState.Loaded)
        assertTrue(activeState.orders.isNotEmpty())
    }

    @Test
    fun `loadData sin rol delivery muestra error`() = runTest {
        // No se establece el rol Delivery
        val viewModel = DeliveryHomeViewModel(ordersService = FakeOrdersService())

        viewModel.loadData()

        val summaryState = viewModel.state.summaryState
        assertTrue(summaryState is DeliverySummaryState.Error)
        assertTrue(summaryState.message.contains("permisos"))

        val activeState = viewModel.state.activeOrdersState
        assertTrue(activeState is DeliveryActiveOrdersState.Empty)
    }

    @Test
    fun `refreshSummary actualiza resumen`() = runTest {
        SessionStore.updateRole(UserRole.Delivery)
        val updatedSummary = DeliveryOrdersSummaryDTO(pending = 10, inProgress = 5, delivered = 20)
        val viewModel = DeliveryHomeViewModel(
            ordersService = FakeOrdersService(summaryResult = Result.success(updatedSummary))
        )

        viewModel.refreshSummary()

        val summaryState = viewModel.state.summaryState
        assertTrue(summaryState is DeliverySummaryState.Loaded)
        assertEquals(10, summaryState.summary.pending)
        assertEquals(5, summaryState.summary.inProgress)
        assertEquals(20, summaryState.summary.delivered)
    }

    @Test
    fun `loadData con ordenes activas las ordena y limita`() = runTest {
        SessionStore.updateRole(UserRole.Delivery)
        val viewModel = DeliveryHomeViewModel(ordersService = FakeOrdersService())

        viewModel.loadData()

        val activeState = viewModel.state.activeOrdersState
        assertTrue(activeState is DeliveryActiveOrdersState.Loaded)
        // Se filtran los "delivered" (o7), quedan 6 ordenes, pero se toma max 5
        assertEquals(5, activeState.orders.size)
        // Verificar que "delivered" no aparece
        assertTrue(activeState.orders.none { it.status.equals("delivered", ignoreCase = true) })
        // Verificar orden: pending (idx 0) va primero, luego inprogress (idx 1), luego assigned (idx 3)
        assertEquals("pending", activeState.orders.first().status)
    }

    @Test
    fun `loadData con error muestra error`() = runTest {
        SessionStore.updateRole(UserRole.Delivery)
        val viewModel = DeliveryHomeViewModel(
            ordersService = FakeOrdersService(
                summaryResult = Result.failure(Exception("Error de red")),
                activeResult = Result.failure(Exception("Error de red"))
            )
        )

        viewModel.loadData()

        val summaryState = viewModel.state.summaryState
        assertTrue(summaryState is DeliverySummaryState.Error)

        val activeState = viewModel.state.activeOrdersState
        assertTrue(activeState is DeliveryActiveOrdersState.Error)
    }
}

// ==================== Tests DeliveryProfileViewModel ====================

class DeliveryProfileViewModelTest2 {

    @BeforeTest
    fun setUp() {
        SessionStore.clear()
    }

    @Test
    fun `loadProfile exitoso carga formulario y disponibilidad`() = runTest {
        val viewModel = DeliveryProfileViewModel(
            getDeliveryProfile = FakeGetDeliveryProfile(),
            updateDeliveryProfile = FakeUpdateDeliveryProfile(),
            getDeliveryAvailability = FakeGetDeliveryAvailability(),
            updateDeliveryAvailability = FakeUpdateDeliveryAvailability(),
            toDoResetLoginCache = FakeResetCache(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadProfile()

        assertFalse(viewModel.state.loading)
        assertNull(viewModel.state.error)
        assertEquals("Carlos Delivery", viewModel.state.form.fullName)
        assertEquals("carlos@example.com", viewModel.state.form.email)
        assertEquals("+541145667788", viewModel.state.form.phone)
        assertEquals("Moto", viewModel.state.form.vehicleType)
        assertEquals("Honda CB", viewModel.state.form.vehicleModel)
        assertEquals("AB123CD", viewModel.state.form.vehiclePlate)
        assertEquals(1, viewModel.state.zones.size)
        assertEquals("Centro", viewModel.state.zones.first().name)
        assertEquals("America/Argentina/Buenos_Aires", viewModel.state.availability.timezone)
        assertTrue(viewModel.state.availability.slots.first { it.dayOfWeek == DayOfWeek.MONDAY }.enabled)
    }

    @Test
    fun `loadProfile con error muestra error`() = runTest {
        val viewModel = DeliveryProfileViewModel(
            getDeliveryProfile = FakeGetDeliveryProfile(Result.failure(Exception("Sin conexion"))),
            updateDeliveryProfile = FakeUpdateDeliveryProfile(),
            getDeliveryAvailability = FakeGetDeliveryAvailability(),
            updateDeliveryAvailability = FakeUpdateDeliveryAvailability(),
            toDoResetLoginCache = FakeResetCache(),
            loggerFactory = testLoggerFactory
        )

        viewModel.loadProfile()

        assertFalse(viewModel.state.loading)
        assertEquals("Sin conexion", viewModel.state.error)
    }

    @Test
    fun `onNameChange actualiza nombre en formulario`() = runTest {
        val viewModel = DeliveryProfileViewModel(
            getDeliveryProfile = FakeGetDeliveryProfile(),
            updateDeliveryProfile = FakeUpdateDeliveryProfile(),
            getDeliveryAvailability = FakeGetDeliveryAvailability(),
            updateDeliveryAvailability = FakeUpdateDeliveryAvailability(),
            toDoResetLoginCache = FakeResetCache(),
            loggerFactory = testLoggerFactory
        )

        viewModel.onNameChange("Nuevo Nombre")

        assertEquals("Nuevo Nombre", viewModel.state.form.fullName)
    }

    @Test
    fun `onVehicleTypeChange actualiza tipo de vehiculo`() = runTest {
        val viewModel = DeliveryProfileViewModel(
            getDeliveryProfile = FakeGetDeliveryProfile(),
            updateDeliveryProfile = FakeUpdateDeliveryProfile(),
            getDeliveryAvailability = FakeGetDeliveryAvailability(),
            updateDeliveryAvailability = FakeUpdateDeliveryAvailability(),
            toDoResetLoginCache = FakeResetCache(),
            loggerFactory = testLoggerFactory
        )

        viewModel.onVehicleTypeChange("Bicicleta")

        assertEquals("Bicicleta", viewModel.state.form.vehicleType)
    }

    @Test
    fun `saveProfile exitoso actualiza datos`() = runTest {
        val viewModel = DeliveryProfileViewModel(
            getDeliveryProfile = FakeGetDeliveryProfile(),
            updateDeliveryProfile = FakeUpdateDeliveryProfile(),
            getDeliveryAvailability = FakeGetDeliveryAvailability(),
            updateDeliveryAvailability = FakeUpdateDeliveryAvailability(),
            toDoResetLoginCache = FakeResetCache(),
            loggerFactory = testLoggerFactory
        )

        // Cargar datos primero para tener un formulario valido con disponibilidad
        viewModel.loadProfile()

        viewModel.saveProfile()

        assertFalse(viewModel.state.saving)
        assertNull(viewModel.state.error)
        assertEquals(MessageKey.delivery_availability_saved, viewModel.state.successKey)
    }

    @Test
    fun `logout limpia sesion`() = runTest {
        SessionStore.updateRole(UserRole.Delivery)
        val resetCache = FakeResetCache()
        val viewModel = DeliveryProfileViewModel(
            getDeliveryProfile = FakeGetDeliveryProfile(),
            updateDeliveryProfile = FakeUpdateDeliveryProfile(),
            getDeliveryAvailability = FakeGetDeliveryAvailability(),
            updateDeliveryAvailability = FakeUpdateDeliveryAvailability(),
            toDoResetLoginCache = resetCache,
            loggerFactory = testLoggerFactory
        )

        viewModel.logout()

        assertTrue(resetCache.called)
        assertNull(SessionStore.sessionState.value.role)
    }
}
