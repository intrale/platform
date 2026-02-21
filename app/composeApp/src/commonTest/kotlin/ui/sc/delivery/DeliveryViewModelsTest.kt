package ui.sc.delivery

import asdo.auth.ToDoResetLoginCache
import asdo.delivery.DeliveryAvailabilityBlock
import asdo.delivery.DeliveryAvailabilityConfig
import asdo.delivery.DeliveryAvailabilityMode
import asdo.delivery.DeliveryAvailabilitySlot
import asdo.delivery.DeliveryOrder
import asdo.delivery.DeliveryOrderStatus
import asdo.delivery.DeliveryOrdersSummary
import asdo.delivery.DeliveryProfile
import asdo.delivery.DeliveryProfileData
import asdo.delivery.DeliveryVehicle
import asdo.delivery.DeliveryZone
import asdo.delivery.DeliveryOrderStatusUpdateResult
import asdo.delivery.ToDoGetActiveDeliveryOrders
import asdo.delivery.ToDoGetDeliveryAvailability
import asdo.delivery.ToDoGetDeliveryOrdersSummary
import asdo.delivery.ToDoGetDeliveryProfile
import asdo.delivery.ToDoUpdateDeliveryAvailability
import asdo.delivery.ToDoUpdateDeliveryOrderStatus
import asdo.delivery.ToDoUpdateDeliveryProfile
import ar.com.intrale.strings.model.MessageKey
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

private val sampleSummary = DeliveryOrdersSummary(pending = 3, inProgress = 2, delivered = 5)

private val sampleActiveOrders = listOf(
    DeliveryOrder(id = "o1", label = "PUB-1", businessName = "Pizzeria", neighborhood = "Centro", status = DeliveryOrderStatus.PENDING, eta = "12:00"),
    DeliveryOrder(id = "o2", label = "PUB-2", businessName = "Farmacia", neighborhood = "Norte", status = DeliveryOrderStatus.IN_PROGRESS, eta = "11:30"),
    DeliveryOrder(id = "o3", label = "SC3", businessName = "Panaderia", neighborhood = "Sur", status = DeliveryOrderStatus.IN_PROGRESS, eta = "13:00"),
    DeliveryOrder(id = "o4", label = "PUB-4", businessName = "Verduleria", neighborhood = "Oeste", status = DeliveryOrderStatus.PENDING, eta = "14:00"),
    DeliveryOrder(id = "o5", label = "PUB-5", businessName = "Carniceria", neighborhood = "Este", status = DeliveryOrderStatus.PENDING, eta = "15:00"),
    DeliveryOrder(id = "o6", label = "PUB-6", businessName = "Libreria", neighborhood = "Centro", status = DeliveryOrderStatus.PENDING, eta = "16:00"),
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

private class FakeGetActiveDeliveryOrders(
    private val result: Result<List<DeliveryOrder>> = Result.success(sampleActiveOrders)
) : ToDoGetActiveDeliveryOrders {
    override suspend fun execute(): Result<List<DeliveryOrder>> = result
}

private class FakeGetDeliveryOrdersSummary(
    private val result: Result<DeliveryOrdersSummary> = Result.success(sampleSummary)
) : ToDoGetDeliveryOrdersSummary {
    override suspend fun execute(date: LocalDate): Result<DeliveryOrdersSummary> = result
}

private class FakeUpdateDeliveryOrderStatusForHome(
    private val result: Result<DeliveryOrderStatusUpdateResult> = Result.success(
        DeliveryOrderStatusUpdateResult(orderId = "o1", newStatus = DeliveryOrderStatus.IN_PROGRESS)
    )
) : ToDoUpdateDeliveryOrderStatus {
    override suspend fun execute(orderId: String, newStatus: DeliveryOrderStatus): Result<DeliveryOrderStatusUpdateResult> = result
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
        val viewModel = DeliveryHomeViewModel(
            getActiveOrders = FakeGetActiveDeliveryOrders(),
            getOrdersSummary = FakeGetDeliveryOrdersSummary(),
            updateOrderStatus = FakeUpdateDeliveryOrderStatusForHome()
        )

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
        val viewModel = DeliveryHomeViewModel(
            getActiveOrders = FakeGetActiveDeliveryOrders(),
            getOrdersSummary = FakeGetDeliveryOrdersSummary(),
            updateOrderStatus = FakeUpdateDeliveryOrderStatusForHome()
        )

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
        val updatedSummary = DeliveryOrdersSummary(pending = 10, inProgress = 5, delivered = 20)
        val viewModel = DeliveryHomeViewModel(
            getActiveOrders = FakeGetActiveDeliveryOrders(),
            getOrdersSummary = FakeGetDeliveryOrdersSummary(Result.success(updatedSummary)),
            updateOrderStatus = FakeUpdateDeliveryOrderStatusForHome()
        )

        viewModel.refreshSummary()

        val summaryState = viewModel.state.summaryState
        assertTrue(summaryState is DeliverySummaryState.Loaded)
        assertEquals(10, summaryState.summary.pending)
        assertEquals(5, summaryState.summary.inProgress)
        assertEquals(20, summaryState.summary.delivered)
    }

    @Test
    fun `loadData con ordenes activas las limita a 5`() = runTest {
        SessionStore.updateRole(UserRole.Delivery)
        val viewModel = DeliveryHomeViewModel(
            getActiveOrders = FakeGetActiveDeliveryOrders(),
            getOrdersSummary = FakeGetDeliveryOrdersSummary(),
            updateOrderStatus = FakeUpdateDeliveryOrderStatusForHome()
        )

        viewModel.loadData()

        val activeState = viewModel.state.activeOrdersState
        assertTrue(activeState is DeliveryActiveOrdersState.Loaded)
        assertEquals(5, activeState.orders.size)
        assertTrue(activeState.orders.none { it.status == DeliveryOrderStatus.DELIVERED })
        assertEquals(DeliveryOrderStatus.PENDING, activeState.orders.first().status)
    }

    @Test
    fun `loadData con error muestra error`() = runTest {
        SessionStore.updateRole(UserRole.Delivery)
        val viewModel = DeliveryHomeViewModel(
            getActiveOrders = FakeGetActiveDeliveryOrders(Result.failure(Exception("Error de red"))),
            getOrdersSummary = FakeGetDeliveryOrdersSummary(Result.failure(Exception("Error de red"))),
            updateOrderStatus = FakeUpdateDeliveryOrderStatusForHome()
        )

        viewModel.loadData()

        val summaryState = viewModel.state.summaryState
        assertTrue(summaryState is DeliverySummaryState.Error)

        val activeState = viewModel.state.activeOrdersState
        assertTrue(activeState is DeliveryActiveOrdersState.Error)
    }
    @Test
    fun `updateStatus exitoso refresca resumen y ordenes activas`() = runTest {
        SessionStore.updateRole(UserRole.Delivery)
        val viewModel = DeliveryHomeViewModel(
            getActiveOrders = FakeGetActiveDeliveryOrders(),
            getOrdersSummary = FakeGetDeliveryOrdersSummary(),
            updateOrderStatus = FakeUpdateDeliveryOrderStatusForHome()
        )

        viewModel.loadData()
        viewModel.updateStatus("o1", DeliveryOrderStatus.IN_PROGRESS)

        assertTrue(viewModel.state.statusUpdateSuccess)
        assertNull(viewModel.state.updatingOrderId)
        val summaryState = viewModel.state.summaryState
        assertTrue(summaryState is DeliverySummaryState.Loaded)
    }

    @Test
    fun `updateStatus con error muestra mensaje de error`() = runTest {
        SessionStore.updateRole(UserRole.Delivery)
        val viewModel = DeliveryHomeViewModel(
            getActiveOrders = FakeGetActiveDeliveryOrders(),
            getOrdersSummary = FakeGetDeliveryOrdersSummary(),
            updateOrderStatus = FakeUpdateDeliveryOrderStatusForHome(
                Result.failure(RuntimeException("Error de red"))
            )
        )

        viewModel.loadData()
        viewModel.updateStatus("o1", DeliveryOrderStatus.IN_PROGRESS)

        assertTrue(viewModel.state.statusUpdateError != null)
        assertNull(viewModel.state.updatingOrderId)
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
