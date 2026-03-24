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
    status = DeliveryOrderStatus.AT_BUSINESS,
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
        DeliveryOrderStatusUpdateResult(orderId = "o1", newStatus = DeliveryOrderStatus.HEADING_TO_CLIENT)
    )
) : ToDoUpdateDeliveryOrderStatus {
    var lastReason: String? = null

    override suspend fun execute(
        orderId: String,
        newStatus: DeliveryOrderStatus,
        reason: String?
    ): Result<DeliveryOrderStatusUpdateResult> {
        lastReason = reason
        return result
    }
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
                Result.success(DeliveryOrderStatusUpdateResult(orderId = "o1", newStatus = DeliveryOrderStatus.HEADING_TO_CLIENT))
            )
        )

        viewModel.loadDetail()
        viewModel.updateStatus(DeliveryOrderStatus.HEADING_TO_CLIENT)

        assertTrue(viewModel.state.statusUpdateSuccess)
        assertFalse(viewModel.state.updatingStatus)
        assertEquals(DeliveryOrderStatus.HEADING_TO_CLIENT, viewModel.state.detail?.status)
    }

    @Test
    fun `updateStatus con error muestra mensaje de error`() = runTest {
        DeliveryOrderSelectionStore.select("o1")
        val viewModel = DeliveryOrderDetailViewModel(
            getOrderDetail = FakeGetDeliveryOrderDetail(),
            updateOrderStatus = FakeUpdateOrderStatus(Result.failure(RuntimeException("Error de red")))
        )

        viewModel.loadDetail()
        viewModel.updateStatus(DeliveryOrderStatus.HEADING_TO_CLIENT)

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
        viewModel.updateStatus(DeliveryOrderStatus.HEADING_TO_CLIENT)
        assertTrue(viewModel.state.statusUpdateSuccess)

        viewModel.clearStatusFeedback()

        assertFalse(viewModel.state.statusUpdateSuccess)
        assertNull(viewModel.state.statusUpdateError)
    }

    @Test
    fun `showDeliveredConfirm abre dialogo de confirmacion`() = runTest {
        DeliveryOrderSelectionStore.select("o1")
        val viewModel = DeliveryOrderDetailViewModel(
            getOrderDetail = FakeGetDeliveryOrderDetail(),
            updateOrderStatus = FakeUpdateOrderStatus(
                Result.success(DeliveryOrderStatusUpdateResult(orderId = "o1", newStatus = DeliveryOrderStatus.DELIVERED))
            )
        )

        viewModel.loadDetail()
        viewModel.showDeliveredConfirm()

        assertTrue(viewModel.state.showDeliveredConfirmDialog)
    }

    @Test
    fun `confirmDelivered cierra dialogo y actualiza estado a DELIVERED`() = runTest {
        DeliveryOrderSelectionStore.select("o1")
        val viewModel = DeliveryOrderDetailViewModel(
            getOrderDetail = FakeGetDeliveryOrderDetail(),
            updateOrderStatus = FakeUpdateOrderStatus(
                Result.success(DeliveryOrderStatusUpdateResult(orderId = "o1", newStatus = DeliveryOrderStatus.DELIVERED))
            )
        )

        viewModel.loadDetail()
        viewModel.showDeliveredConfirm()
        assertTrue(viewModel.state.showDeliveredConfirmDialog)

        viewModel.confirmDelivered()

        assertFalse(viewModel.state.showDeliveredConfirmDialog)
        assertTrue(viewModel.state.statusUpdateSuccess)
        assertEquals(DeliveryOrderStatus.DELIVERED, viewModel.state.detail?.status)
    }

    @Test
    fun `dismissDeliveredConfirm cierra dialogo sin actualizar estado`() = runTest {
        DeliveryOrderSelectionStore.select("o1")
        val viewModel = DeliveryOrderDetailViewModel(
            getOrderDetail = FakeGetDeliveryOrderDetail(),
            updateOrderStatus = FakeUpdateOrderStatus()
        )

        viewModel.loadDetail()
        viewModel.showDeliveredConfirm()
        viewModel.dismissDeliveredConfirm()

        assertFalse(viewModel.state.showDeliveredConfirmDialog)
        assertFalse(viewModel.state.statusUpdateSuccess)
    }

    @Test
    fun `confirmNotDelivered con motivo ausente actualiza estado a NOT_DELIVERED`() = runTest {
        DeliveryOrderSelectionStore.select("o1")
        val fakeUpdate = FakeUpdateOrderStatus(
            Result.success(DeliveryOrderStatusUpdateResult(orderId = "o1", newStatus = DeliveryOrderStatus.NOT_DELIVERED))
        )
        val viewModel = DeliveryOrderDetailViewModel(
            getOrderDetail = FakeGetDeliveryOrderDetail(),
            updateOrderStatus = fakeUpdate
        )

        viewModel.loadDetail()
        viewModel.showNotDeliveredSheet()
        viewModel.selectNotDeliveredReason(NotDeliveredReason.ABSENT)
        viewModel.confirmNotDelivered()

        assertFalse(viewModel.state.showNotDeliveredSheet)
        assertTrue(viewModel.state.notDeliveredSuccess)
        assertEquals(DeliveryOrderStatus.NOT_DELIVERED, viewModel.state.detail?.status)
        assertEquals("absent", fakeUpdate.lastReason)
    }

    @Test
    fun `confirmNotDelivered sin motivo seleccionado muestra error de validacion`() = runTest {
        DeliveryOrderSelectionStore.select("o1")
        val viewModel = DeliveryOrderDetailViewModel(
            getOrderDetail = FakeGetDeliveryOrderDetail(),
            updateOrderStatus = FakeUpdateOrderStatus()
        )

        viewModel.loadDetail()
        viewModel.showNotDeliveredSheet()
        viewModel.confirmNotDelivered()

        assertTrue(viewModel.state.notDeliveredReasonError)
        assertTrue(viewModel.state.showNotDeliveredSheet)
        assertFalse(viewModel.state.notDeliveredSuccess)
    }

    @Test
    fun `confirmNotDelivered con motivo Otro sin texto muestra error de texto requerido`() = runTest {
        DeliveryOrderSelectionStore.select("o1")
        val viewModel = DeliveryOrderDetailViewModel(
            getOrderDetail = FakeGetDeliveryOrderDetail(),
            updateOrderStatus = FakeUpdateOrderStatus()
        )

        viewModel.loadDetail()
        viewModel.showNotDeliveredSheet()
        viewModel.selectNotDeliveredReason(NotDeliveredReason.OTHER)
        viewModel.confirmNotDelivered()

        assertTrue(viewModel.state.notDeliveredOtherError)
        assertFalse(viewModel.state.notDeliveredReasonError)
        assertFalse(viewModel.state.notDeliveredSuccess)
    }

    @Test
    fun `confirmNotDelivered con motivo Otro y texto envia texto como razon`() = runTest {
        DeliveryOrderSelectionStore.select("o1")
        val fakeUpdate = FakeUpdateOrderStatus(
            Result.success(DeliveryOrderStatusUpdateResult(orderId = "o1", newStatus = DeliveryOrderStatus.NOT_DELIVERED))
        )
        val viewModel = DeliveryOrderDetailViewModel(
            getOrderDetail = FakeGetDeliveryOrderDetail(),
            updateOrderStatus = fakeUpdate
        )

        viewModel.loadDetail()
        viewModel.showNotDeliveredSheet()
        viewModel.selectNotDeliveredReason(NotDeliveredReason.OTHER)
        viewModel.updateNotDeliveredOtherText("Perro agresivo en la puerta")
        viewModel.confirmNotDelivered()

        assertFalse(viewModel.state.notDeliveredOtherError)
        assertTrue(viewModel.state.notDeliveredSuccess)
        assertEquals("Perro agresivo en la puerta", fakeUpdate.lastReason)
    }

    @Test
    fun `advanceToNextStatus avanza al siguiente estado desde AT_BUSINESS`() = runTest {
        DeliveryOrderSelectionStore.select("o1")
        val fakeUpdate = FakeUpdateOrderStatus(
            Result.success(DeliveryOrderStatusUpdateResult(orderId = "o1", newStatus = DeliveryOrderStatus.HEADING_TO_CLIENT))
        )
        val viewModel = DeliveryOrderDetailViewModel(
            getOrderDetail = FakeGetDeliveryOrderDetail(), // sampleDetail tiene AT_BUSINESS
            updateOrderStatus = fakeUpdate
        )

        viewModel.loadDetail()
        viewModel.advanceToNextStatus()

        assertTrue(viewModel.state.statusUpdateSuccess)
        assertEquals(DeliveryOrderStatus.HEADING_TO_CLIENT, viewModel.state.detail?.status)
    }

    @Test
    fun `advanceToNextStatus no hace nada si el estado es terminal`() = runTest {
        DeliveryOrderSelectionStore.select("o1")
        val fakeUpdate = FakeUpdateOrderStatus()
        val detailTerminal = sampleDetail.copy(status = DeliveryOrderStatus.DELIVERED)
        val viewModel = DeliveryOrderDetailViewModel(
            getOrderDetail = FakeGetDeliveryOrderDetail(Result.success(detailTerminal)),
            updateOrderStatus = fakeUpdate
        )

        viewModel.loadDetail()
        viewModel.advanceToNextStatus()

        assertFalse(viewModel.state.statusUpdateSuccess)
        assertEquals(DeliveryOrderStatus.DELIVERED, viewModel.state.detail?.status)
    }

    @Test
    fun `updateStatus agrega entrada al historial en el state`() = runTest {
        DeliveryOrderSelectionStore.select("o1")
        val fakeUpdate = FakeUpdateOrderStatus(
            Result.success(DeliveryOrderStatusUpdateResult(orderId = "o1", newStatus = DeliveryOrderStatus.HEADING_TO_CLIENT))
        )
        val viewModel = DeliveryOrderDetailViewModel(
            getOrderDetail = FakeGetDeliveryOrderDetail(),
            updateOrderStatus = fakeUpdate
        )

        viewModel.loadDetail()
        val initialHistorySize = viewModel.state.statusHistory.size
        viewModel.updateStatus(DeliveryOrderStatus.HEADING_TO_CLIENT)

        assertEquals(initialHistorySize + 1, viewModel.state.statusHistory.size)
        assertEquals(DeliveryOrderStatus.HEADING_TO_CLIENT, viewModel.state.statusHistory.last().status)
    }
}
