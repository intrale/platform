package ui.sc.delivery

import asdo.delivery.DeliveryNotification
import asdo.delivery.DeliveryNotificationEventType
import asdo.delivery.DeliveryOrderStatus
import asdo.delivery.ToDoGetDeliveryNotifications
import asdo.delivery.ToDoMarkAllDeliveryNotificationsRead
import asdo.delivery.ToDoMarkDeliveryNotificationRead
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class FakeGetDeliveryNotifications(
    private var result: Result<List<DeliveryNotification>> = Result.success(emptyList())
) : ToDoGetDeliveryNotifications {
    fun setResult(r: Result<List<DeliveryNotification>>) { result = r }
    override suspend fun execute(): Result<List<DeliveryNotification>> = result
}

class FakeMarkDeliveryNotificationRead(
    private var result: Result<Unit> = Result.success(Unit)
) : ToDoMarkDeliveryNotificationRead {
    var lastId: String? = null
    override suspend fun execute(notificationId: String): Result<Unit> {
        lastId = notificationId
        return result
    }
}

class FakeMarkAllDeliveryNotificationsRead(
    private var result: Result<Unit> = Result.success(Unit)
) : ToDoMarkAllDeliveryNotificationsRead {
    var called = false
    override suspend fun execute(): Result<Unit> {
        called = true
        return result
    }
}

class DeliveryNotificationsViewModelTest {

    private lateinit var fakeGet: FakeGetDeliveryNotifications
    private lateinit var fakeMarkRead: FakeMarkDeliveryNotificationRead
    private lateinit var fakeMarkAllRead: FakeMarkAllDeliveryNotificationsRead
    private lateinit var viewModel: DeliveryNotificationsViewModel

    private val sampleNotifications = listOf(
        DeliveryNotification(
            id = "ord-1_PENDING",
            orderId = "ord-1",
            label = "Pedido #001",
            businessName = "Panaderia Sur",
            neighborhood = "Centro",
            eventType = DeliveryNotificationEventType.NEW_ORDER_AVAILABLE,
            timestamp = "2025-03-20T10:00:00",
            isRead = false
        ),
        DeliveryNotification(
            id = "ord-2_IN_PROGRESS",
            orderId = "ord-2",
            label = "Pedido #002",
            businessName = "Farmacia Norte",
            neighborhood = "Alberdi",
            eventType = DeliveryNotificationEventType.ORDER_ASSIGNED,
            timestamp = "2025-03-20T09:00:00",
            isRead = true
        )
    )

    @BeforeTest
    fun setup() {
        fakeGet = FakeGetDeliveryNotifications()
        fakeMarkRead = FakeMarkDeliveryNotificationRead()
        fakeMarkAllRead = FakeMarkAllDeliveryNotificationsRead()
        viewModel = DeliveryNotificationsViewModel(
            getNotifications = fakeGet,
            markRead = fakeMarkRead,
            markAllRead = fakeMarkAllRead,
            loggerFactory = LoggerFactory.default
        )
    }

    @Test
    fun `loadNotifications actualiza estado a Loaded con notificaciones`() = runTest {
        fakeGet.setResult(Result.success(sampleNotifications))

        viewModel.loadNotifications()

        assertEquals(DeliveryNotificationsStatus.Loaded, viewModel.state.status)
        assertEquals(2, viewModel.state.notifications.size)
        assertEquals(1, viewModel.state.unreadCount)
        assertNull(viewModel.state.errorMessage)
    }

    @Test
    fun `loadNotifications actualiza estado a Empty sin notificaciones`() = runTest {
        fakeGet.setResult(Result.success(emptyList()))

        viewModel.loadNotifications()

        assertEquals(DeliveryNotificationsStatus.Empty, viewModel.state.status)
        assertTrue(viewModel.state.notifications.isEmpty())
        assertEquals(0, viewModel.state.unreadCount)
    }

    @Test
    fun `loadNotifications maneja error correctamente`() = runTest {
        fakeGet.setResult(Result.failure(RuntimeException("Sin conexion")))

        viewModel.loadNotifications()

        assertEquals(DeliveryNotificationsStatus.Empty, viewModel.state.status)
        assertEquals("Sin conexion", viewModel.state.errorMessage)
    }

    @Test
    fun `markNotificationAsRead invoca caso de uso y recarga`() = runTest {
        fakeGet.setResult(Result.success(sampleNotifications))

        viewModel.markNotificationAsRead("ord-1_PENDING")

        assertEquals("ord-1_PENDING", fakeMarkRead.lastId)
    }

    @Test
    fun `markAllNotificationsAsRead invoca caso de uso y recarga`() = runTest {
        fakeGet.setResult(Result.success(sampleNotifications))

        viewModel.markAllNotificationsAsRead()

        assertTrue(fakeMarkAllRead.called)
    }

    @Test
    fun `clearError limpia el mensaje de error`() = runTest {
        fakeGet.setResult(Result.failure(RuntimeException("Error")))
        viewModel.loadNotifications()
        assertEquals("Error", viewModel.state.errorMessage)

        viewModel.clearError()

        assertNull(viewModel.state.errorMessage)
    }
}
