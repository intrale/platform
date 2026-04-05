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
    status = DeliveryOrderStatus.IN_PROGRESS,
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
    var lastReason: String? = null
    var lastNote: String? = null
    var lastPhotoBase64: String? = null

    override suspend fun execute(
        orderId: String,
        newStatus: DeliveryOrderStatus,
        reason: String?,
        note: String?,
        photoBase64: String?
    ): Result<DeliveryOrderStatusUpdateResult> {
        lastReason = reason
        lastNote = note
        lastPhotoBase64 = photoBase64
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
    fun `loadDetail exitoso muestra datos de ubicacion con direccion`() = runTest {
        DeliveryOrderSelectionStore.select("o1")
        val viewModel = DeliveryOrderDetailViewModel(
            getOrderDetail = FakeGetDeliveryOrderDetail(),
            updateOrderStatus = FakeUpdateOrderStatus()
        )

        viewModel.loadDetail()

        assertEquals(DeliveryOrderDetailStatus.Loaded, viewModel.state.status)
        assertNotNull(viewModel.state.detail?.address)
        assertEquals("Av. Siempre Viva 742", viewModel.state.detail?.address)
        assertEquals("Pizzeria Roma", viewModel.state.detail?.businessName)
        assertEquals("Centro", viewModel.state.detail?.neighborhood)
        assertEquals("2.5 km", viewModel.state.detail?.distance)
    }

    @Test
    fun `loadDetail con pedido sin direccion muestra detalle sin address`() = runTest {
        DeliveryOrderSelectionStore.select("o1")
        val detailSinDireccion = sampleDetail.copy(address = null, addressNotes = null)
        val viewModel = DeliveryOrderDetailViewModel(
            getOrderDetail = FakeGetDeliveryOrderDetail(Result.success(detailSinDireccion)),
            updateOrderStatus = FakeUpdateOrderStatus()
        )

        viewModel.loadDetail()

        assertEquals(DeliveryOrderDetailStatus.Loaded, viewModel.state.status)
        assertNull(viewModel.state.detail?.address)
        assertNotNull(viewModel.state.detail?.businessName)
    }

    @Test
    fun `detalle cargado tiene datos suficientes para navegacion al comercio`() = runTest {
        DeliveryOrderSelectionStore.select("o1")
        val viewModel = DeliveryOrderDetailViewModel(
            getOrderDetail = FakeGetDeliveryOrderDetail(),
            updateOrderStatus = FakeUpdateOrderStatus()
        )

        viewModel.loadDetail()

        val detail = viewModel.state.detail
        assertNotNull(detail)
        // Se puede construir la dirección del comercio para navegación
        val originAddress = "${detail.businessName}, ${detail.neighborhood}"
        assertEquals("Pizzeria Roma, Centro", originAddress)
    }

    @Test
    fun `detalle cargado tiene distancia y ETA para mostrar antes de navegar`() = runTest {
        DeliveryOrderSelectionStore.select("o1")
        val viewModel = DeliveryOrderDetailViewModel(
            getOrderDetail = FakeGetDeliveryOrderDetail(),
            updateOrderStatus = FakeUpdateOrderStatus()
        )

        viewModel.loadDetail()

        val detail = viewModel.state.detail
        assertNotNull(detail)
        assertNotNull(detail.distance, "La distancia debe estar disponible para mostrar al repartidor")
        assertNotNull(detail.eta, "El ETA debe estar disponible para mostrar al repartidor")
        assertEquals("2.5 km", detail.distance)
        assertEquals("12:00", detail.eta)
    }

    @Test
    fun `detalle sin distancia ni ETA sigue siendo valido para navegacion`() = runTest {
        DeliveryOrderSelectionStore.select("o1")
        val detailSinEstimacion = sampleDetail.copy(distance = null, eta = null)
        val viewModel = DeliveryOrderDetailViewModel(
            getOrderDetail = FakeGetDeliveryOrderDetail(Result.success(detailSinEstimacion)),
            updateOrderStatus = FakeUpdateOrderStatus()
        )

        viewModel.loadDetail()

        val detail = viewModel.state.detail
        assertNotNull(detail)
        assertEquals(DeliveryOrderDetailStatus.Loaded, viewModel.state.status)
        assertNull(detail.distance)
        assertNull(detail.eta)
        // La dirección de destino sigue disponible para navegación
        assertNotNull(detail.address)
    }

    @Test
    fun `updateNotDeliveredNote actualiza la nota en el estado`() = runTest {
        val viewModel = DeliveryOrderDetailViewModel(
            getOrderDetail = FakeGetDeliveryOrderDetail(),
            updateOrderStatus = FakeUpdateOrderStatus()
        )

        viewModel.showNotDeliveredSheet()
        viewModel.updateNotDeliveredNote("El portero no me dejo pasar")

        assertEquals("El portero no me dejo pasar", viewModel.state.notDeliveredNote)
    }

    @Test
    fun `updateNotDeliveredPhoto almacena bytes de la foto`() = runTest {
        val viewModel = DeliveryOrderDetailViewModel(
            getOrderDetail = FakeGetDeliveryOrderDetail(),
            updateOrderStatus = FakeUpdateOrderStatus()
        )

        val fakePhotoBytes = byteArrayOf(1, 2, 3, 4, 5)
        viewModel.showNotDeliveredSheet()
        viewModel.updateNotDeliveredPhoto(fakePhotoBytes)

        assertNotNull(viewModel.state.notDeliveredPhotoBytes)
        assertEquals(5, viewModel.state.notDeliveredPhotoBytes?.size)
    }

    @Test
    fun `removeNotDeliveredPhoto limpia la foto del estado`() = runTest {
        val viewModel = DeliveryOrderDetailViewModel(
            getOrderDetail = FakeGetDeliveryOrderDetail(),
            updateOrderStatus = FakeUpdateOrderStatus()
        )

        viewModel.showNotDeliveredSheet()
        viewModel.updateNotDeliveredPhoto(byteArrayOf(1, 2, 3))
        assertNotNull(viewModel.state.notDeliveredPhotoBytes)

        viewModel.removeNotDeliveredPhoto()

        assertNull(viewModel.state.notDeliveredPhotoBytes)
    }

    @Test
    fun `confirmNotDelivered envia nota y foto al caso de uso`() = runTest {
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
        viewModel.updateNotDeliveredNote("Toque el timbre varias veces")
        viewModel.updateNotDeliveredPhoto(byteArrayOf(10, 20, 30))
        viewModel.confirmNotDelivered()

        assertTrue(viewModel.state.notDeliveredSuccess)
        assertEquals("absent", fakeUpdate.lastReason)
        assertEquals("Toque el timbre varias veces", fakeUpdate.lastNote)
        assertNotNull(fakeUpdate.lastPhotoBase64)
    }

    @Test
    fun `confirmNotDelivered sin nota ni foto envia null para ambos`() = runTest {
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
        viewModel.selectNotDeliveredReason(NotDeliveredReason.WRONG_ADDRESS)
        viewModel.confirmNotDelivered()

        assertTrue(viewModel.state.notDeliveredSuccess)
        assertEquals("wrong_address", fakeUpdate.lastReason)
        assertNull(fakeUpdate.lastNote)
        assertNull(fakeUpdate.lastPhotoBase64)
    }

    @Test
    fun `showNotDeliveredSheet resetea nota y foto`() = runTest {
        val viewModel = DeliveryOrderDetailViewModel(
            getOrderDetail = FakeGetDeliveryOrderDetail(),
            updateOrderStatus = FakeUpdateOrderStatus()
        )

        viewModel.updateNotDeliveredNote("Nota previa")
        viewModel.updateNotDeliveredPhoto(byteArrayOf(1, 2))

        viewModel.showNotDeliveredSheet()

        assertEquals("", viewModel.state.notDeliveredNote)
        assertNull(viewModel.state.notDeliveredPhotoBytes)
    }

    @Test
    fun `confirmNotDelivered exitoso actualiza detalle con motivo y nota`() = runTest {
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
        viewModel.selectNotDeliveredReason(NotDeliveredReason.PAYMENT)
        viewModel.updateNotDeliveredNote("No tenia cambio")
        viewModel.confirmNotDelivered()

        val detail = viewModel.state.detail
        assertNotNull(detail)
        assertEquals(DeliveryOrderStatus.NOT_DELIVERED, detail.status)
        assertEquals("payment", detail.notDeliveryReason)
        assertEquals("No tenia cambio", detail.notDeliveryNote)
    }
}
