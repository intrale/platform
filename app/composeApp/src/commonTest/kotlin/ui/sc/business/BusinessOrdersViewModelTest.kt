package ui.sc.business

import asdo.business.BusinessOrder
import asdo.business.BusinessOrderStatus
import asdo.business.DeliveryPersonSummary
import asdo.business.ToDoAssignOrderDeliveryPerson
import asdo.business.ToDoGetBusinessDeliveryPeople
import asdo.business.ToGetBusinessOrders
import kotlinx.coroutines.test.runTest
import ui.session.SessionStore
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val sampleOrders = listOf(
    BusinessOrder(
        id = "order-1",
        shortCode = "ABC123",
        clientEmail = "client@test.com",
        status = BusinessOrderStatus.PENDING,
        total = 100.0,
        assignedDeliveryPersonEmail = null,
        createdAt = "2026-03-18T10:00:00Z"
    ),
    BusinessOrder(
        id = "order-2",
        shortCode = "DEF456",
        clientEmail = "other@test.com",
        status = BusinessOrderStatus.DELIVERING,
        total = 50.0,
        assignedDeliveryPersonEmail = "driver@test.com",
        createdAt = "2026-03-18T11:00:00Z"
    )
)

private val sampleDeliveryPeople = listOf(
    DeliveryPersonSummary(email = "driver@test.com", fullName = "Juan Perez"),
    DeliveryPersonSummary(email = "driver2@test.com", fullName = "Maria Lopez")
)

private class FakeGetBusinessOrders(
    private val result: Result<List<BusinessOrder>>
) : ToGetBusinessOrders {
    override suspend fun execute(businessId: String): Result<List<BusinessOrder>> = result
}

private class FakeAssignOrderDeliveryPerson(
    private val result: Result<BusinessOrder>? = null
) : ToDoAssignOrderDeliveryPerson {
    var lastOrderId: String? = null
        private set
    var lastEmail: String? = null
        private set

    override suspend fun execute(
        businessId: String,
        orderId: String,
        deliveryPersonEmail: String?
    ): Result<BusinessOrder> {
        lastOrderId = orderId
        lastEmail = deliveryPersonEmail
        return result ?: Result.success(
            sampleOrders.first { it.id == orderId }.copy(
                assignedDeliveryPersonEmail = deliveryPersonEmail
            )
        )
    }
}

private class FakeGetBusinessDeliveryPeople(
    private val result: Result<List<DeliveryPersonSummary>>
) : ToDoGetBusinessDeliveryPeople {
    override suspend fun execute(businessId: String): Result<List<DeliveryPersonSummary>> = result
}

class BusinessOrdersViewModelTest {

    @BeforeTest
    fun setup() {
        SessionStore.clear()
        SessionStore.updateSelectedBusiness("biz-1")
    }

    @Test
    fun `loadOrders exitoso carga pedidos en el estado`() = runTest {
        val vm = BusinessOrdersViewModel(
            getBusinessOrders = FakeGetBusinessOrders(Result.success(sampleOrders)),
            assignOrderDeliveryPerson = FakeAssignOrderDeliveryPerson(),
            getBusinessDeliveryPeople = FakeGetBusinessDeliveryPeople(Result.success(emptyList()))
        )

        vm.loadOrders()

        assertFalse(vm.state.isLoading)
        assertEquals(2, vm.state.orders.size)
        assertEquals("order-1", vm.state.orders[0].id)
        assertNull(vm.state.error)
    }

    @Test
    fun `loadOrders con error actualiza el estado con mensaje de error`() = runTest {
        val vm = BusinessOrdersViewModel(
            getBusinessOrders = FakeGetBusinessOrders(Result.failure(RuntimeException("network error"))),
            assignOrderDeliveryPerson = FakeAssignOrderDeliveryPerson(),
            getBusinessDeliveryPeople = FakeGetBusinessDeliveryPeople(Result.success(emptyList()))
        )

        vm.loadOrders()

        assertFalse(vm.state.isLoading)
        assertNotNull(vm.state.error)
    }

    @Test
    fun `loadDeliveryPeople exitoso carga repartidores`() = runTest {
        val vm = BusinessOrdersViewModel(
            getBusinessOrders = FakeGetBusinessOrders(Result.success(emptyList())),
            assignOrderDeliveryPerson = FakeAssignOrderDeliveryPerson(),
            getBusinessDeliveryPeople = FakeGetBusinessDeliveryPeople(Result.success(sampleDeliveryPeople))
        )

        vm.loadDeliveryPeople()

        assertFalse(vm.state.isLoadingDeliveryPeople)
        assertEquals(2, vm.state.deliveryPeople.size)
        assertEquals("Juan Perez", vm.state.deliveryPeople[0].fullName)
    }

    @Test
    fun `assignDeliveryPerson exitoso actualiza el pedido`() = runTest {
        val fakeAssign = FakeAssignOrderDeliveryPerson()
        val vm = BusinessOrdersViewModel(
            getBusinessOrders = FakeGetBusinessOrders(Result.success(sampleOrders)),
            assignOrderDeliveryPerson = fakeAssign,
            getBusinessDeliveryPeople = FakeGetBusinessDeliveryPeople(Result.success(sampleDeliveryPeople))
        )

        vm.loadOrders()
        vm.assignDeliveryPerson("order-1", "driver@test.com")

        assertEquals("order-1", fakeAssign.lastOrderId)
        assertEquals("driver@test.com", fakeAssign.lastEmail)
        val updatedOrder = vm.state.orders.first { it.id == "order-1" }
        assertEquals("driver@test.com", updatedOrder.assignedDeliveryPersonEmail)
        assertNull(vm.state.assigningOrderId)
        assertNotNull(vm.state.assignSuccess)
    }

    @Test
    fun `assignDeliveryPerson con null desasigna repartidor`() = runTest {
        val fakeAssign = FakeAssignOrderDeliveryPerson()
        val vm = BusinessOrdersViewModel(
            getBusinessOrders = FakeGetBusinessOrders(Result.success(sampleOrders)),
            assignOrderDeliveryPerson = fakeAssign,
            getBusinessDeliveryPeople = FakeGetBusinessDeliveryPeople(Result.success(emptyList()))
        )

        vm.loadOrders()
        vm.assignDeliveryPerson("order-2", null)

        assertEquals("order-2", fakeAssign.lastOrderId)
        assertNull(fakeAssign.lastEmail)
        val updatedOrder = vm.state.orders.first { it.id == "order-2" }
        assertNull(updatedOrder.assignedDeliveryPersonEmail)
    }

    @Test
    fun `selectOrderForAssignment actualiza selectedOrderId`() = runTest {
        val vm = BusinessOrdersViewModel(
            getBusinessOrders = FakeGetBusinessOrders(Result.success(emptyList())),
            assignOrderDeliveryPerson = FakeAssignOrderDeliveryPerson(),
            getBusinessDeliveryPeople = FakeGetBusinessDeliveryPeople(Result.success(emptyList()))
        )

        vm.selectOrderForAssignment("order-1")
        assertEquals("order-1", vm.state.selectedOrderId)

        vm.selectOrderForAssignment(null)
        assertNull(vm.state.selectedOrderId)
    }

    @Test
    fun `assignDeliveryPerson con error muestra assignError`() = runTest {
        val fakeAssign = FakeAssignOrderDeliveryPerson(
            result = Result.failure(RuntimeException("assign failed"))
        )
        val vm = BusinessOrdersViewModel(
            getBusinessOrders = FakeGetBusinessOrders(Result.success(sampleOrders)),
            assignOrderDeliveryPerson = fakeAssign,
            getBusinessDeliveryPeople = FakeGetBusinessDeliveryPeople(Result.success(emptyList()))
        )

        vm.loadOrders()
        vm.assignDeliveryPerson("order-1", "driver@test.com")

        assertNull(vm.state.assigningOrderId)
        assertNotNull(vm.state.assignError)
    }
}
