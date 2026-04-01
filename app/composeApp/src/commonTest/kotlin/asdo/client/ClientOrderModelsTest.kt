package asdo.client

import ar.com.intrale.shared.client.ClientAddressDTO
import ar.com.intrale.shared.client.ClientOrderDTO
import ar.com.intrale.shared.client.ClientOrderDetailDTO
import ar.com.intrale.shared.client.ClientOrderItemDTO
import ar.com.intrale.shared.client.ClientOrderStatusEventDTO
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class ClientOrderModelsTest {

    @Test
    fun `toClientOrderStatus mapea todos los estados conocidos`() {
        assertEquals(ClientOrderStatus.PENDING, "PENDING".toClientOrderStatus())
        assertEquals(ClientOrderStatus.CONFIRMED, "CONFIRMED".toClientOrderStatus())
        assertEquals(ClientOrderStatus.PREPARING, "PREPARING".toClientOrderStatus())
        assertEquals(ClientOrderStatus.READY, "READY".toClientOrderStatus())
        assertEquals(ClientOrderStatus.DELIVERING, "DELIVERING".toClientOrderStatus())
        assertEquals(ClientOrderStatus.DELIVERED, "DELIVERED".toClientOrderStatus())
        assertEquals(ClientOrderStatus.CANCELLED, "CANCELLED".toClientOrderStatus())
    }

    @Test
    fun `toClientOrderStatus es case insensitive`() {
        assertEquals(ClientOrderStatus.PENDING, "pending".toClientOrderStatus())
        assertEquals(ClientOrderStatus.DELIVERED, "delivered".toClientOrderStatus())
        assertEquals(ClientOrderStatus.CONFIRMED, "Confirmed".toClientOrderStatus())
    }

    @Test
    fun `toClientOrderStatus retorna UNKNOWN para valor desconocido`() {
        assertEquals(ClientOrderStatus.UNKNOWN, "invalid".toClientOrderStatus())
        assertEquals(ClientOrderStatus.UNKNOWN, "".toClientOrderStatus())
    }

    @Test
    fun `ClientOrderDTO toDomain mapea campos basicos`() {
        val dto = ClientOrderDTO(
            id = "order-1",
            publicId = "PUB-001",
            shortCode = "SC-001",
            businessName = "Pizzeria",
            status = "CONFIRMED",
            createdAt = "2026-04-01T10:00:00",
            promisedAt = "2026-04-01T11:00:00",
            total = 2500.0,
            itemCount = 3
        )
        val domain = dto.toDomain()
        assertEquals("order-1", domain.id)
        assertEquals("PUB-001", domain.publicId)
        assertEquals("SC-001", domain.shortCode)
        assertEquals("Pizzeria", domain.businessName)
        assertEquals(ClientOrderStatus.CONFIRMED, domain.status)
        assertEquals("2026-04-01T10:00:00", domain.createdAt)
        assertEquals("2026-04-01T11:00:00", domain.promisedAt)
        assertEquals(2500.0, domain.total)
        assertEquals(3, domain.itemCount)
    }

    @Test
    fun `ClientOrderDTO toDomain con id null usa string vacio`() {
        val dto = ClientOrderDTO(id = null, businessName = "Test", status = "PENDING")
        assertEquals("", dto.toDomain().id)
    }

    @Test
    fun `ClientOrderItemDTO toDomain mapea correctamente`() {
        val dto = ClientOrderItemDTO(
            id = "item-1",
            name = "Pizza Grande",
            quantity = 2,
            unitPrice = 1200.0,
            subtotal = 2400.0
        )
        val domain = dto.toDomain()
        assertEquals("item-1", domain.id)
        assertEquals("Pizza Grande", domain.name)
        assertEquals(2, domain.quantity)
        assertEquals(1200.0, domain.unitPrice)
        assertEquals(2400.0, domain.subtotal)
    }

    @Test
    fun `ClientOrderStatusEventDTO toDomain mapea correctamente`() {
        val dto = ClientOrderStatusEventDTO(
            status = "PREPARING",
            timestamp = "2026-04-01T10:30:00",
            message = "Tu pedido se está preparando"
        )
        val domain = dto.toDomain()
        assertEquals(ClientOrderStatus.PREPARING, domain.status)
        assertEquals("2026-04-01T10:30:00", domain.timestamp)
        assertEquals("Tu pedido se está preparando", domain.message)
    }

    @Test
    fun `ClientOrderDetailDTO toDomain mapea todos los campos incluyendo address`() {
        val dto = ClientOrderDetailDTO(
            id = "order-2",
            publicId = "PUB-002",
            shortCode = "SC-002",
            businessName = "Heladeria",
            status = "DELIVERING",
            createdAt = "2026-04-01T14:00:00",
            promisedAt = "2026-04-01T14:30:00",
            total = 800.0,
            itemCount = 1,
            items = listOf(
                ClientOrderItemDTO(name = "Helado 1kg", quantity = 1, unitPrice = 800.0, subtotal = 800.0)
            ),
            address = ClientAddressDTO(
                id = "addr-1",
                label = "Casa",
                street = "Av. Corrientes",
                number = "1234",
                city = "CABA",
                reference = "Piso 5",
                postalCode = "1043"
            ),
            paymentMethod = "mercadopago",
            statusHistory = listOf(
                ClientOrderStatusEventDTO(status = "PENDING", timestamp = "2026-04-01T14:00:00"),
                ClientOrderStatusEventDTO(status = "CONFIRMED", timestamp = "2026-04-01T14:05:00")
            ),
            businessMessage = "Enviamos tu pedido",
            businessPhone = "1155559999"
        )
        val detail = dto.toDomain()
        assertEquals("order-2", detail.id)
        assertEquals("PUB-002", detail.publicId)
        assertEquals(ClientOrderStatus.DELIVERING, detail.status)
        assertEquals(1, detail.items.size)
        assertEquals("Helado 1kg", detail.items[0].name)
        assertNotNull(detail.address)
        assertEquals("Casa", detail.address?.label)
        assertEquals("Av. Corrientes", detail.address?.street)
        assertEquals("1234", detail.address?.number)
        assertEquals("CABA", detail.address?.city)
        assertEquals("Piso 5", detail.address?.reference)
        assertEquals("1043", detail.address?.postalCode)
        assertEquals("mercadopago", detail.paymentMethod)
        assertEquals(2, detail.statusHistory.size)
        assertEquals("Enviamos tu pedido", detail.businessMessage)
        assertEquals("1155559999", detail.businessPhone)
    }

    @Test
    fun `ClientOrderDetailDTO toDomain con address null`() {
        val dto = ClientOrderDetailDTO(
            publicId = "PUB-003",
            shortCode = "SC-003",
            businessName = "Test",
            status = "PENDING",
            address = null
        )
        assertNull(dto.toDomain().address)
    }
}
