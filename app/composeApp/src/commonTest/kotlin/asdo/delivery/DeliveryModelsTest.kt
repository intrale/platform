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
    fun `toDeliveryOrderStatus mapea assigned como IN_PROGRESS`() {
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
    fun `toDeliveryOrderStatus con valor desconocido devuelve UNKNOWN`() {
        assertEquals(DeliveryOrderStatus.UNKNOWN, "algo_raro".toDeliveryOrderStatus())
    }

    @Test
    fun `toApiString mapea cada estado correctamente`() {
        assertEquals("pending", DeliveryOrderStatus.PENDING.toApiString())
        assertEquals("inprogress", DeliveryOrderStatus.IN_PROGRESS.toApiString())
        assertEquals("delivered", DeliveryOrderStatus.DELIVERED.toApiString())
        assertEquals("not_delivered", DeliveryOrderStatus.NOT_DELIVERED.toApiString())
        assertEquals("unknown", DeliveryOrderStatus.UNKNOWN.toApiString())
    }

    @Test
    fun `DeliveryOrderDTO toDomain mapea campos correctamente`() {
        val dto = DeliveryOrderDTO(
            id = "order1",
            publicId = "PUB-1",
            shortCode = "SC1",
            businessName = "Panaderia",
            neighborhood = "Centro",
            status = "pending",
            eta = "12:00",
            promisedAt = null,
            distance = null,
            address = null,
            addressNotes = null,
            items = emptyList(),
            notes = null,
            customerName = null,
            customerPhone = null,
            paymentMethod = null,
            collectOnDelivery = null,
            createdAt = null,
            updatedAt = "2026-03-25T10:00:00"
        )

        val domain = dto.toDomain()

        assertEquals("order1", domain.id)
        assertEquals("PUB-1", domain.label)
        assertEquals("Panaderia", domain.businessName)
        assertEquals("Centro", domain.neighborhood)
        assertEquals(DeliveryOrderStatus.PENDING, domain.status)
        assertEquals("12:00", domain.eta)
        assertEquals("2026-03-25T10:00:00", domain.finishedAt)
    }

    @Test
    fun `DeliveryOrderDTO toDomain usa shortCode si publicId es null`() {
        val dto = DeliveryOrderDTO(
            id = "order1",
            publicId = null,
            shortCode = "SC1",
            businessName = "Test",
            neighborhood = "Test",
            status = "pending",
            eta = null,
            promisedAt = "13:00",
            distance = null,
            address = null,
            addressNotes = null,
            items = emptyList(),
            notes = null,
            customerName = null,
            customerPhone = null,
            paymentMethod = null,
            collectOnDelivery = null,
            createdAt = null,
            updatedAt = null
        )

        val domain = dto.toDomain()
        assertEquals("SC1", domain.label)
        assertEquals("13:00", domain.eta) // fallback a promisedAt
    }

    @Test
    fun `DeliveryOrderDTO toDomain usa id si publicId y shortCode son null`() {
        val dto = DeliveryOrderDTO(
            id = "order1",
            publicId = null,
            shortCode = null,
            businessName = "Test",
            neighborhood = "Test",
            status = "delivered",
            eta = null,
            promisedAt = null,
            distance = null,
            address = null,
            addressNotes = null,
            items = emptyList(),
            notes = null,
            customerName = null,
            customerPhone = null,
            paymentMethod = null,
            collectOnDelivery = null,
            createdAt = null,
            updatedAt = null
        )

        val domain = dto.toDomain()
        assertEquals("order1", domain.label)
        assertNull(domain.eta)
    }

    @Test
    fun `DeliveryOrderDTO toDetailDomain mapea todos los campos`() {
        val dto = DeliveryOrderDTO(
            id = "order1",
            publicId = "PUB-1",
            shortCode = null,
            businessName = "Pizzeria",
            neighborhood = "Centro",
            status = "in_progress",
            eta = "12:00",
            promisedAt = null,
            distance = "2.5 km",
            address = "Av. Siempre Viva 742",
            addressNotes = "Piso 3",
            items = listOf(
                DeliveryOrderItemDTO(name = "Pizza", quantity = 2, notes = "Sin aceitunas")
            ),
            notes = "Dejar en porteria",
            customerName = "Juan Perez",
            customerPhone = "+541155667788",
            paymentMethod = "Efectivo",
            collectOnDelivery = true,
            createdAt = "2026-03-25T09:00:00",
            updatedAt = "2026-03-25T10:00:00"
        )

        val detail = dto.toDetailDomain()

        assertEquals("order1", detail.id)
        assertEquals("PUB-1", detail.label)
        assertEquals(DeliveryOrderStatus.IN_PROGRESS, detail.status)
        assertEquals("2.5 km", detail.distance)
        assertEquals("Av. Siempre Viva 742", detail.address)
        assertEquals("Piso 3", detail.addressNotes)
        assertEquals(1, detail.items.size)
        assertEquals("Pizza", detail.items.first().name)
        assertEquals(2, detail.items.first().quantity)
        assertEquals("Sin aceitunas", detail.items.first().notes)
        assertEquals("Juan Perez", detail.customerName)
        assertEquals("Efectivo", detail.paymentMethod)
        assertEquals(true, detail.collectOnDelivery)
    }

    @Test
    fun `DeliveryOrderItemDTO toDomain mapea correctamente`() {
        val dto = DeliveryOrderItemDTO(name = "Empanadas", quantity = 6, notes = null)
        val domain = dto.toDomain()

        assertEquals("Empanadas", domain.name)
        assertEquals(6, domain.quantity)
        assertNull(domain.notes)
    }

    @Test
    fun `DeliveryOrdersSummaryDTO toDomain mapea correctamente`() {
        val dto = DeliveryOrdersSummaryDTO(pending = 5, inProgress = 3, delivered = 12)
        val domain = dto.toDomain()

        assertEquals(5, domain.pending)
        assertEquals(3, domain.inProgress)
        assertEquals(12, domain.delivered)
    }

    @Test
    fun `DeliveryOrderStatusUpdateResponse toDomain mapea correctamente`() {
        val response = DeliveryOrderStatusUpdateResponse(orderId = "order1", status = "delivered")
        val domain = response.toDomain()

        assertEquals("order1", domain.orderId)
        assertEquals(DeliveryOrderStatus.DELIVERED, domain.newStatus)
    }
}

class DeliveryStateModelsTest {

    @Test
    fun `toDeliveryState mapea pending correctamente`() {
        assertEquals(DeliveryState.PENDING, "pending".toDeliveryState())
    }

    @Test
    fun `toDeliveryState mapea picked_up correctamente`() {
        assertEquals(DeliveryState.PICKED_UP, "picked_up".toDeliveryState())
    }

    @Test
    fun `toDeliveryState mapea pickedup correctamente`() {
        assertEquals(DeliveryState.PICKED_UP, "pickedup".toDeliveryState())
    }

    @Test
    fun `toDeliveryState mapea in_transit correctamente`() {
        assertEquals(DeliveryState.IN_TRANSIT, "in_transit".toDeliveryState())
    }

    @Test
    fun `toDeliveryState mapea intransit correctamente`() {
        assertEquals(DeliveryState.IN_TRANSIT, "intransit".toDeliveryState())
    }

    @Test
    fun `toDeliveryState mapea delivered correctamente`() {
        assertEquals(DeliveryState.DELIVERED, "delivered".toDeliveryState())
    }

    @Test
    fun `toDeliveryState mapea cancelled correctamente`() {
        assertEquals(DeliveryState.CANCELLED, "cancelled".toDeliveryState())
    }

    @Test
    fun `toDeliveryState con valor desconocido devuelve PENDING`() {
        assertEquals(DeliveryState.PENDING, "desconocido".toDeliveryState())
    }

    @Test
    fun `DeliveryState toApiString mapea todos los estados`() {
        assertEquals("pending", DeliveryState.PENDING.toApiString())
        assertEquals("picked_up", DeliveryState.PICKED_UP.toApiString())
        assertEquals("in_transit", DeliveryState.IN_TRANSIT.toApiString())
        assertEquals("delivered", DeliveryState.DELIVERED.toApiString())
        assertEquals("cancelled", DeliveryState.CANCELLED.toApiString())
    }

    @Test
    fun `DeliveryStateChangeResponse toDomain mapea correctamente`() {
        val response = ar.com.intrale.shared.delivery.DeliveryStateChangeResponse(
            orderId = "order1",
            state = "delivered"
        )
        val domain = response.toDomain()
        assertEquals("order1", domain.orderId)
        assertEquals(DeliveryState.DELIVERED, domain.newState)
    }
}

class DeliveryProfileModelsTest {

    @Test
    fun `DeliveryProfileDTO toDomain mapea todos los campos`() {
        val dto = ar.com.intrale.shared.delivery.DeliveryProfileDTO(
            fullName = "Carlos Repartidor",
            email = "carlos@test.com",
            phone = "+5491155667788",
            vehicle = ar.com.intrale.shared.delivery.DeliveryVehicleDTO(
                type = "Moto",
                model = "Honda CB",
                plate = "AB123CD"
            )
        )
        val domain = dto.toDomain()
        assertEquals("Carlos Repartidor", domain.fullName)
        assertEquals("carlos@test.com", domain.email)
        assertEquals("+5491155667788", domain.phone)
        assertEquals("Moto", domain.vehicle.type)
        assertEquals("Honda CB", domain.vehicle.model)
        assertEquals("AB123CD", domain.vehicle.plate)
    }

    @Test
    fun `DeliveryZoneDTO toDomain mapea correctamente`() {
        val dto = ar.com.intrale.shared.delivery.DeliveryZoneDTO(
            id = "z1",
            name = "Centro",
            description = "Zona centrica"
        )
        val domain = dto.toDomain()
        assertEquals("z1", domain.id)
        assertEquals("Centro", domain.name)
        assertEquals("Zona centrica", domain.description)
    }

    @Test
    fun `DeliveryProfile toDto y vuelta preserva datos`() {
        val profile = DeliveryProfile(
            fullName = "Test User",
            email = "test@test.com",
            phone = "+5491133445566",
            vehicle = DeliveryVehicle(type = "Auto", model = "Ford Ka", plate = "XY456ZW")
        )
        val dto = profile.toDto()
        val back = dto.toDomain()
        assertEquals(profile.fullName, back.fullName)
        assertEquals(profile.email, back.email)
        assertEquals(profile.phone, back.phone)
        assertEquals(profile.vehicle.type, back.vehicle.type)
    }

    @Test
    fun `DeliveryAvailabilitySlot toDto mapea correctamente`() {
        val slot = DeliveryAvailabilitySlot(
            dayOfWeek = kotlinx.datetime.DayOfWeek.MONDAY,
            mode = DeliveryAvailabilityMode.BLOCK,
            block = DeliveryAvailabilityBlock.MORNING,
            start = "06:00",
            end = "12:00"
        )
        val dto = slot.toDto()
        assertEquals("monday", dto.dayOfWeek)
        assertEquals("BLOCK", dto.mode)
        assertEquals("MORNING", dto.block)
        assertEquals("06:00", dto.start)
        assertEquals("12:00", dto.end)
    }

    @Test
    fun `DeliveryAvailabilityConfig toDto y vuelta preserva datos`() {
        val config = DeliveryAvailabilityConfig(
            timezone = "America/Argentina/Buenos_Aires",
            slots = listOf(
                DeliveryAvailabilitySlot(
                    dayOfWeek = kotlinx.datetime.DayOfWeek.TUESDAY,
                    mode = DeliveryAvailabilityMode.CUSTOM,
                    block = null,
                    start = "08:00",
                    end = "18:00"
                )
            )
        )
        val dto = config.toDto()
        assertEquals("America/Argentina/Buenos_Aires", dto.timezone)
        assertEquals(1, dto.slots.size)

        val back = dto.toDomain()
        assertEquals(config.timezone, back.timezone)
        assertEquals(1, back.slots.size)
        assertEquals(kotlinx.datetime.DayOfWeek.TUESDAY, back.slots.first().dayOfWeek)
    }

    @Test
    fun `DeliveryAvailabilitySlotDTO toDomain con dia invalido devuelve null`() {
        val dto = ar.com.intrale.shared.delivery.DeliveryAvailabilitySlotDTO(
            dayOfWeek = "dia_invalido",
            mode = "BLOCK",
            block = null,
            start = null,
            end = null
        )
        val result = dto.toDomain()
        assertNull(result)
    }

    @Test
    fun `DeliveryAvailabilitySlotDTO toDomain con modo invalido devuelve null`() {
        val dto = ar.com.intrale.shared.delivery.DeliveryAvailabilitySlotDTO(
            dayOfWeek = "monday",
            mode = "modo_invalido",
            block = null,
            start = null,
            end = null
        )
        val result = dto.toDomain()
        assertNull(result)
    }
}

class DeliveryNotificationModelsTest {

    @Test
    fun `toNotificationEventType mapea PENDING a ORDER_AVAILABLE`() {
        assertEquals(DeliveryNotificationEventType.ORDER_AVAILABLE, DeliveryOrderStatus.PENDING.toNotificationEventType())
    }

    @Test
    fun `toNotificationEventType mapea IN_PROGRESS a ORDER_ASSIGNED`() {
        assertEquals(DeliveryNotificationEventType.ORDER_ASSIGNED, DeliveryOrderStatus.IN_PROGRESS.toNotificationEventType())
    }

    @Test
    fun `toNotificationEventType mapea DELIVERED a ORDER_DELIVERED`() {
        assertEquals(DeliveryNotificationEventType.ORDER_DELIVERED, DeliveryOrderStatus.DELIVERED.toNotificationEventType())
    }

    @Test
    fun `toNotificationEventType mapea NOT_DELIVERED a ORDER_NOT_DELIVERED`() {
        assertEquals(DeliveryNotificationEventType.ORDER_NOT_DELIVERED, DeliveryOrderStatus.NOT_DELIVERED.toNotificationEventType())
    }

    @Test
    fun `toNotificationEventType mapea UNKNOWN a ORDER_AVAILABLE`() {
        assertEquals(DeliveryNotificationEventType.ORDER_AVAILABLE, DeliveryOrderStatus.UNKNOWN.toNotificationEventType())
    }
}
