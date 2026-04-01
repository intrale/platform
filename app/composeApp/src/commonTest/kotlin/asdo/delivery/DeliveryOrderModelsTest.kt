package asdo.delivery

import ar.com.intrale.shared.delivery.DeliveryOrderDTO
import ar.com.intrale.shared.delivery.DeliveryOrderItemDTO
import ar.com.intrale.shared.delivery.DeliveryOrderStatusUpdateResponse
import ar.com.intrale.shared.delivery.DeliveryOrdersSummaryDTO
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class DeliveryOrderModelsTest {

    @Test
    fun `toDeliveryOrderStatus mapea pending correctamente`() {
        assertEquals(DeliveryOrderStatus.PENDING, "pending".toDeliveryOrderStatus())
    }

    @Test
    fun `toDeliveryOrderStatus mapea inprogress correctamente`() {
        assertEquals(DeliveryOrderStatus.IN_PROGRESS, "inprogress".toDeliveryOrderStatus())
    }

    @Test
    fun `toDeliveryOrderStatus mapea in_progress correctamente`() {
        assertEquals(DeliveryOrderStatus.IN_PROGRESS, "in_progress".toDeliveryOrderStatus())
    }

    @Test
    fun `toDeliveryOrderStatus mapea assigned a IN_PROGRESS`() {
        assertEquals(DeliveryOrderStatus.IN_PROGRESS, "assigned".toDeliveryOrderStatus())
    }

    @Test
    fun `toDeliveryOrderStatus mapea delivered correctamente`() {
        assertEquals(DeliveryOrderStatus.DELIVERED, "delivered".toDeliveryOrderStatus())
    }

    @Test
    fun `toDeliveryOrderStatus mapea not_delivered correctamente`() {
        assertEquals(DeliveryOrderStatus.NOT_DELIVERED, "not_delivered".toDeliveryOrderStatus())
    }

    @Test
    fun `toDeliveryOrderStatus mapea notdelivered correctamente`() {
        assertEquals(DeliveryOrderStatus.NOT_DELIVERED, "notdelivered".toDeliveryOrderStatus())
    }

    @Test
    fun `toDeliveryOrderStatus retorna UNKNOWN para valor desconocido`() {
        assertEquals(DeliveryOrderStatus.UNKNOWN, "invalid_status".toDeliveryOrderStatus())
    }

    @Test
    fun `toDeliveryOrderStatus es case insensitive`() {
        assertEquals(DeliveryOrderStatus.PENDING, "PENDING".toDeliveryOrderStatus())
        assertEquals(DeliveryOrderStatus.DELIVERED, "Delivered".toDeliveryOrderStatus())
    }

    @Test
    fun `toApiString mapea todos los estados correctamente`() {
        assertEquals("pending", DeliveryOrderStatus.PENDING.toApiString())
        assertEquals("inprogress", DeliveryOrderStatus.IN_PROGRESS.toApiString())
        assertEquals("delivered", DeliveryOrderStatus.DELIVERED.toApiString())
        assertEquals("not_delivered", DeliveryOrderStatus.NOT_DELIVERED.toApiString())
        assertEquals("unknown", DeliveryOrderStatus.UNKNOWN.toApiString())
    }

    @Test
    fun `DeliveryOrderDTO toDomain mapea campos basicos`() {
        val dto = DeliveryOrderDTO(
            id = "order-1",
            publicId = "PUB-001",
            businessName = "Tienda Test",
            neighborhood = "Palermo",
            status = "pending",
            eta = "15 min"
        )
        val domain = dto.toDomain()
        assertEquals("order-1", domain.id)
        assertEquals("PUB-001", domain.label)
        assertEquals("Tienda Test", domain.businessName)
        assertEquals("Palermo", domain.neighborhood)
        assertEquals(DeliveryOrderStatus.PENDING, domain.status)
        assertEquals("15 min", domain.eta)
    }

    @Test
    fun `DeliveryOrderDTO toDomain usa shortCode cuando publicId es null`() {
        val dto = DeliveryOrderDTO(
            id = "order-2",
            publicId = null,
            shortCode = "SC-002",
            businessName = "Tienda",
            neighborhood = "Recoleta",
            status = "delivered"
        )
        assertEquals("SC-002", dto.toDomain().label)
    }

    @Test
    fun `DeliveryOrderDTO toDomain usa id cuando publicId y shortCode son null`() {
        val dto = DeliveryOrderDTO(
            id = "order-3",
            publicId = null,
            shortCode = null,
            businessName = "Tienda",
            neighborhood = "Belgrano",
            status = "pending"
        )
        assertEquals("order-3", dto.toDomain().label)
    }

    @Test
    fun `DeliveryOrderDTO toDomain usa promisedAt como fallback para eta`() {
        val dto = DeliveryOrderDTO(
            id = "order-4",
            businessName = "Tienda",
            neighborhood = "Centro",
            status = "in_progress",
            eta = null,
            promisedAt = "16:30"
        )
        assertEquals("16:30", dto.toDomain().eta)
    }

    @Test
    fun `DeliveryOrderItemDTO toDomain mapea correctamente`() {
        val dto = DeliveryOrderItemDTO(
            name = "Pizza Grande",
            quantity = 2,
            notes = "Sin cebolla"
        )
        val domain = dto.toDomain()
        assertEquals("Pizza Grande", domain.name)
        assertEquals(2, domain.quantity)
        assertEquals("Sin cebolla", domain.notes)
    }

    @Test
    fun `DeliveryOrdersSummaryDTO toDomain mapea contadores`() {
        val dto = DeliveryOrdersSummaryDTO(
            pending = 3,
            inProgress = 2,
            delivered = 10
        )
        val domain = dto.toDomain()
        assertEquals(3, domain.pending)
        assertEquals(2, domain.inProgress)
        assertEquals(10, domain.delivered)
    }

    @Test
    fun `DeliveryOrderStatusUpdateResponse toDomain mapea correctamente`() {
        val response = DeliveryOrderStatusUpdateResponse(
            orderId = "order-5",
            status = "delivered"
        )
        val domain = response.toDomain()
        assertEquals("order-5", domain.orderId)
        assertEquals(DeliveryOrderStatus.DELIVERED, domain.newStatus)
    }

    @Test
    fun `DeliveryOrderDTO toDetailDomain mapea todos los campos de detalle`() {
        val dto = DeliveryOrderDTO(
            id = "order-6",
            publicId = "PUB-006",
            businessName = "Panaderia",
            neighborhood = "Flores",
            status = "in_progress",
            eta = "20 min",
            distance = "2.5 km",
            address = "Av. Rivadavia 1234",
            addressNotes = "Piso 3",
            items = listOf(
                DeliveryOrderItemDTO(name = "Facturas", quantity = 6, notes = null)
            ),
            notes = "Tocar timbre",
            customerName = "Juan",
            customerPhone = "1155551234",
            paymentMethod = "cash",
            collectOnDelivery = true,
            createdAt = "2026-04-01T10:00:00",
            updatedAt = "2026-04-01T10:15:00"
        )
        val detail = dto.toDetailDomain()
        assertEquals("order-6", detail.id)
        assertEquals("PUB-006", detail.label)
        assertEquals("Panaderia", detail.businessName)
        assertEquals(DeliveryOrderStatus.IN_PROGRESS, detail.status)
        assertEquals("2.5 km", detail.distance)
        assertEquals("Av. Rivadavia 1234", detail.address)
        assertEquals("Piso 3", detail.addressNotes)
        assertEquals(1, detail.items.size)
        assertEquals("Facturas", detail.items[0].name)
        assertEquals("Tocar timbre", detail.notes)
        assertEquals("Juan", detail.customerName)
        assertEquals("1155551234", detail.customerPhone)
        assertEquals("cash", detail.paymentMethod)
        assertEquals(true, detail.collectOnDelivery)
        assertEquals("2026-04-01T10:00:00", detail.createdAt)
        assertEquals("2026-04-01T10:15:00", detail.updatedAt)
    }
}
