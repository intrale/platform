package ui.sc.delivery

import asdo.delivery.DeliveryOrderDetail
import asdo.delivery.DeliveryOrderItem
import asdo.delivery.DeliveryOrderStatus
import asdo.delivery.DeliveryOrderStatusUpdateResult
import asdo.delivery.ToDoGetDeliveryOrderDetail
import asdo.delivery.ToDoUpdateDeliveryOrderStatus
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val sampleDetail = DeliveryOrderDetail(
    id = "o1",
    label = "PUB-1",
    businessName = "Pizzeria Roma",
    neighborhood = "Centro",
    status = DeliveryOrderStatus.PENDING,
    eta = "12:00",
    distance = "2.5 km",
    address = "Av. Siempre Viva 742",
    addressNotes = "Puerta roja",
    items = listOf(
        DeliveryOrderItem(name = "Pizza grande", quantity = 2, notes = "Sin cebolla"),
        DeliveryOrderItem(name = "Empanadas", quantity = 6, notes = null)
    ),
    notes = "Entregar antes del mediodia",
    customerName = "Juan Perez",
    customerPhone = "+5491155551234",
    paymentMethod = "Efectivo",
    collectOnDelivery = true,
    createdAt = "2026-02-25T10:00:00",
    updatedAt = "2026-02-25T10:30:00"
)

private class FakeGetDeliveryOrderDetail(
    private val result: Result<DeliveryOrderDetail> = Result.success(sampleDetail)
) : ToDoGetDeliveryOrderDetail {
    override suspend fun execute(orderId: String): Result<DeliveryOrderDetail> = result
}

private class FakeUpdateOrderStatus(
    private val result: Result<DeliveryOrderStatusUpdateResult> = Result.success(
        DeliveryOrderStatusUpdateResult(orderId = "o1", newStatus = DeliveryOrderStatus.IN_PROGRESS)
    )
) : ToDoUpdateDeliveryOrderStatus {
    override suspend fun execute(orderId: String, newStatus: DeliveryOrderStatus): Result<DeliveryOrderStatusUpdateResult> = result
}

class DeliveryOrderDetailViewModelTest {

    @Test
    fun `loadDetail exitoso muestra detalle completo`() = runTest {
        DeliveryOrderSelectionStore.select("o1")
        val viewModel = DeliveryOrderDetailViewModel(
            getOrderDetail = FakeGetDeliveryOrderDetail(),
            updateOrderStatus = FakeUpdateOrderStatus()
        )

        viewModel.loadDetail()

        assertEquals(DeliveryOrderDetailStatus.Loaded, viewModel.state.status)
        assertNotNull(viewModel.state.detail)
        assertEquals("o1", viewModel.state.detail?.id)
        assertEquals("Pizzeria Roma", viewModel.state.detail?.businessName)
        assertEquals("Juan Perez", viewModel.state.detail?.customerName)
        assertEquals(2, viewModel.state.detail?.items?.size)
        assertEquals("Efectivo", viewModel.state.detail?.paymentMethod)
        assertEquals(true, viewModel.state.detail?.collectOnDelivery)
    }

    @Test
    fun `loadDetail sin seleccion muestra error`() = runTest {
        DeliveryOrderSelectionStore.clear()
        val viewModel = DeliveryOrderDetailViewModel(
            getOrderDetail = FakeGetDeliveryOrderDetail(),
            updateOrderStatus = FakeUpdateOrderStatus()
        )

        viewModel.loadDetail()

        assertEquals(DeliveryOrderDetailStatus.Error, viewModel.state.status)
        assertNotNull(viewModel.state.errorMessage)
    }

    @Test
    fun `loadDetail con error de red muestra error`() = runTest {
        DeliveryOrderSelectionStore.select("o1")
        val viewModel = DeliveryOrderDetailViewModel(
            getOrderDetail = FakeGetDeliveryOrderDetail(Result.failure(RuntimeException("Sin conexion"))),
            updateOrderStatus = FakeUpdateOrderStatus()
        )

        viewModel.loadDetail()

        assertEquals(DeliveryOrderDetailStatus.Error, viewModel.state.status)
        assertNotNull(viewModel.state.errorMessage)
    }

    @Test
    fun `updateStatus exitoso actualiza estado del detalle`() = runTest {
        DeliveryOrderSelectionStore.select("o1")
        val viewModel = DeliveryOrderDetailViewModel(
            getOrderDetail = FakeGetDeliveryOrderDetail(),
            updateOrderStatus = FakeUpdateOrderStatus(
                Result.success(DeliveryOrderStatusUpdateResult(orderId = "o1", newStatus = DeliveryOrderStatus.IN_PROGRESS))
            )
        )

        viewModel.loadDetail()
        viewModel.updateStatus(DeliveryOrderStatus.IN_PROGRESS)

        assertTrue(viewModel.state.statusUpdateSuccess)
        assertFalse(viewModel.state.updatingStatus)
        assertEquals(DeliveryOrderStatus.IN_PROGRESS, viewModel.state.detail?.status)
    }

    @Test
    fun `updateStatus con error muestra mensaje de error`() = runTest {
        DeliveryOrderSelectionStore.select("o1")
        val viewModel = DeliveryOrderDetailViewModel(
            getOrderDetail = FakeGetDeliveryOrderDetail(),
            updateOrderStatus = FakeUpdateOrderStatus(Result.failure(RuntimeException("Error de red")))
        )

        viewModel.loadDetail()
        viewModel.updateStatus(DeliveryOrderStatus.IN_PROGRESS)

        assertNotNull(viewModel.state.statusUpdateError)
        assertFalse(viewModel.state.updatingStatus)
    }

    @Test
    fun `clearStatusFeedback limpia success y error`() = runTest {
        DeliveryOrderSelectionStore.select("o1")
        val viewModel = DeliveryOrderDetailViewModel(
            getOrderDetail = FakeGetDeliveryOrderDetail(),
            updateOrderStatus = FakeUpdateOrderStatus()
        )

        viewModel.loadDetail()
        viewModel.updateStatus(DeliveryOrderStatus.IN_PROGRESS)
        assertTrue(viewModel.state.statusUpdateSuccess)

        viewModel.clearStatusFeedback()

        assertFalse(viewModel.state.statusUpdateSuccess)
        assertNull(viewModel.state.statusUpdateError)
    }
}
