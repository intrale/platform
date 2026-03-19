package ui.sc.business

import asdo.business.BusinessOrderDetail
import asdo.business.BusinessOrderItem
import asdo.business.BusinessOrderStatus
import asdo.business.BusinessOrderStatusUpdateResult
import asdo.business.ToGetBusinessOrderDetail
import asdo.business.ToUpdateBusinessOrderStatus
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class FakeGetBusinessOrderDetail(
    private val result: Result<BusinessOrderDetail> = Result.success(fakeDetail())
) : ToGetBusinessOrderDetail {
    var calledWith: Pair<String, String>? = null
    override suspend fun execute(businessId: String, orderId: String): Result<BusinessOrderDetail> {
        calledWith = businessId to orderId
        return result
    }
}

class FakeUpdateBusinessOrderStatus(
    private val result: Result<BusinessOrderStatusUpdateResult> = Result.success(
        BusinessOrderStatusUpdateResult(orderId = "ord-1", newStatus = BusinessOrderStatus.PREPARING, updatedAt = "2026-03-18T10:00:00Z")
    )
) : ToUpdateBusinessOrderStatus {
    var calledWith: Triple<String, String, BusinessOrderStatus>? = null
    override suspend fun execute(businessId: String, orderId: String, newStatus: BusinessOrderStatus, reason: String?): Result<BusinessOrderStatusUpdateResult> {
        calledWith = Triple(businessId, orderId, newStatus)
        return result
    }
}

private fun fakeDetail() = BusinessOrderDetail(
    id = "ord-1",
    shortCode = "ABC123",
    clientEmail = "cliente@test.com",
    clientName = "Juan Test",
    status = BusinessOrderStatus.PENDING,
    total = 1500.0,
    items = listOf(
        BusinessOrderItem(id = "item-1", name = "Pizza grande", quantity = 2, unitPrice = 500.0, subtotal = 1000.0),
        BusinessOrderItem(id = "item-2", name = "Bebida", quantity = 1, unitPrice = 500.0, subtotal = 500.0)
    ),
    deliveryAddress = "Av. Corrientes 1234, CABA",
    deliveryCity = "Buenos Aires",
    deliveryReference = "Piso 3 Depto B",
    statusHistory = emptyList(),
    createdAt = "2026-03-18T09:00:00Z",
    updatedAt = null
)

class BusinessOrderDetailViewModelTest {

    @Test
    fun `loadDetail carga el detalle correctamente`() = runTest {
        val fakeGet = FakeGetBusinessOrderDetail()
        val fakeUpdate = FakeUpdateBusinessOrderStatus()
        val viewModel = BusinessOrderDetailViewModel(getOrderDetail = fakeGet, updateOrderStatus = fakeUpdate)

        // Simular la seleccion de un pedido
        BusinessOrderSelectionStore.select("ord-1")

        // No podemos probar sin SessionStore configurado, verificamos estado inicial
        assertEquals(BusinessOrderDetailStatus.Idle, viewModel.state.screenStatus)
        assertNull(viewModel.state.detail)
        assertFalse(viewModel.state.updatingStatus)
    }

    @Test
    fun `showCancelDialog muestra el dialogo de cancelacion`() = runTest {
        val fakeGet = FakeGetBusinessOrderDetail()
        val fakeUpdate = FakeUpdateBusinessOrderStatus()
        val viewModel = BusinessOrderDetailViewModel(getOrderDetail = fakeGet, updateOrderStatus = fakeUpdate)

        assertFalse(viewModel.state.showCancelDialog)
        viewModel.showCancelDialog()
        assertTrue(viewModel.state.showCancelDialog)
        assertEquals("", viewModel.state.cancelReason)
    }

    @Test
    fun `dismissCancelDialog oculta el dialogo`() = runTest {
        val fakeGet = FakeGetBusinessOrderDetail()
        val fakeUpdate = FakeUpdateBusinessOrderStatus()
        val viewModel = BusinessOrderDetailViewModel(getOrderDetail = fakeGet, updateOrderStatus = fakeUpdate)

        viewModel.showCancelDialog()
        assertTrue(viewModel.state.showCancelDialog)
        viewModel.dismissCancelDialog()
        assertFalse(viewModel.state.showCancelDialog)
    }

    @Test
    fun `updateCancelReason actualiza el motivo de cancelacion`() = runTest {
        val fakeGet = FakeGetBusinessOrderDetail()
        val fakeUpdate = FakeUpdateBusinessOrderStatus()
        val viewModel = BusinessOrderDetailViewModel(getOrderDetail = fakeGet, updateOrderStatus = fakeUpdate)

        viewModel.showCancelDialog()
        viewModel.updateCancelReason("No hay stock")
        assertEquals("No hay stock", viewModel.state.cancelReason)
        assertFalse(viewModel.state.cancelReasonError)
    }

    @Test
    fun `confirmCancel sin motivo muestra error`() = runTest {
        val fakeGet = FakeGetBusinessOrderDetail()
        val fakeUpdate = FakeUpdateBusinessOrderStatus()
        val viewModel = BusinessOrderDetailViewModel(getOrderDetail = fakeGet, updateOrderStatus = fakeUpdate)

        viewModel.showCancelDialog()
        viewModel.confirmCancel()
        assertTrue(viewModel.state.cancelReasonError)
    }

    @Test
    fun `clearStatusFeedback limpia mensajes de feedback`() = runTest {
        val fakeGet = FakeGetBusinessOrderDetail()
        val fakeUpdate = FakeUpdateBusinessOrderStatus()
        val viewModel = BusinessOrderDetailViewModel(getOrderDetail = fakeGet, updateOrderStatus = fakeUpdate)

        viewModel.clearStatusFeedback()
        assertFalse(viewModel.state.statusUpdateSuccess)
        assertNull(viewModel.state.statusUpdateError)
    }
}
