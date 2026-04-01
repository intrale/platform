package asdo.delivery

import ar.com.intrale.shared.delivery.DeliveryAvailabilityDTO
import ar.com.intrale.shared.delivery.DeliveryAvailabilitySlotDTO
import ar.com.intrale.shared.delivery.DeliveryProfileDTO
import ar.com.intrale.shared.delivery.DeliveryVehicleDTO
import ar.com.intrale.shared.delivery.DeliveryZoneDTO
import kotlinx.datetime.DayOfWeek
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class DeliveryProfileModelsTest {

    @Test
    fun `DeliveryProfileDTO toDomain mapea campos basicos`() {
        val dto = DeliveryProfileDTO(
            fullName = "Juan Perez",
            email = "juan@test.com",
            phone = "1155551234",
            vehicle = DeliveryVehicleDTO(type = "moto", model = "Honda CG", plate = "ABC123")
        )
        val domain = dto.toDomain()
        assertEquals("Juan Perez", domain.fullName)
        assertEquals("juan@test.com", domain.email)
        assertEquals("1155551234", domain.phone)
        assertEquals("moto", domain.vehicle.type)
        assertEquals("Honda CG", domain.vehicle.model)
        assertEquals("ABC123", domain.vehicle.plate)
    }

    @Test
    fun `DeliveryVehicleDTO toDomain mapea correctamente`() {
        val dto = DeliveryVehicleDTO(type = "bici", model = "Mountain", plate = null)
        val domain = dto.toDomain()
        assertEquals("bici", domain.type)
        assertEquals("Mountain", domain.model)
        assertNull(domain.plate)
    }

    @Test
    fun `DeliveryZoneDTO toDomain mapea correctamente`() {
        val dto = DeliveryZoneDTO(id = "zone-1", name = "Centro", description = "Zona centro")
        val domain = dto.toDomain()
        assertEquals("zone-1", domain.id)
        assertEquals("Centro", domain.name)
        assertEquals("Zona centro", domain.description)
    }

    @Test
    fun `DeliveryProfile toDto ida y vuelta`() {
        val profile = DeliveryProfile(
            fullName = "Ana Lopez",
            email = "ana@test.com",
            phone = "1166662222",
            vehicle = DeliveryVehicle(type = "auto", model = "Corsa", plate = "XYZ789")
        )
        val dto = profile.toDto()
        val backToDomain = dto.toDomain()
        assertEquals(profile.fullName, backToDomain.fullName)
        assertEquals(profile.email, backToDomain.email)
        assertEquals(profile.phone, backToDomain.phone)
        assertEquals(profile.vehicle.type, backToDomain.vehicle.type)
    }

    @Test
    fun `DeliveryAvailabilitySlotDTO toDomain con datos validos`() {
        val dto = DeliveryAvailabilitySlotDTO(
            dayOfWeek = "monday",
            mode = "BLOCK",
            block = "MORNING",
            start = "08:00",
            end = "12:00"
        )
        val slot = dto.toDomain()
        assertEquals(DayOfWeek.MONDAY, slot?.dayOfWeek)
        assertEquals(DeliveryAvailabilityMode.BLOCK, slot?.mode)
        assertEquals(DeliveryAvailabilityBlock.MORNING, slot?.block)
        assertEquals("08:00", slot?.start)
        assertEquals("12:00", slot?.end)
    }

    @Test
    fun `DeliveryAvailabilitySlotDTO toDomain retorna null con dia invalido`() {
        val dto = DeliveryAvailabilitySlotDTO(
            dayOfWeek = "invalid_day",
            mode = "BLOCK"
        )
        assertNull(dto.toDomain())
    }

    @Test
    fun `DeliveryAvailabilitySlotDTO toDomain retorna null con modo invalido`() {
        val dto = DeliveryAvailabilitySlotDTO(
            dayOfWeek = "monday",
            mode = "invalid_mode"
        )
        assertNull(dto.toDomain())
    }

    @Test
    fun `DeliveryAvailabilityDTO toDomain filtra slots invalidos`() {
        val dto = DeliveryAvailabilityDTO(
            timezone = "America/Buenos_Aires",
            slots = listOf(
                DeliveryAvailabilitySlotDTO(dayOfWeek = "monday", mode = "BLOCK", block = "MORNING"),
                DeliveryAvailabilitySlotDTO(dayOfWeek = "invalid", mode = "BLOCK"), // será filtrado
                DeliveryAvailabilitySlotDTO(dayOfWeek = "friday", mode = "CUSTOM", start = "09:00", end = "18:00")
            )
        )
        val config = dto.toDomain()
        assertEquals("America/Buenos_Aires", config.timezone)
        assertEquals(2, config.slots.size) // solo 2 validos
    }

    @Test
    fun `DeliveryAvailabilitySlot toDto mapea correctamente`() {
        val slot = DeliveryAvailabilitySlot(
            dayOfWeek = DayOfWeek.WEDNESDAY,
            mode = DeliveryAvailabilityMode.CUSTOM,
            block = null,
            start = "14:00",
            end = "20:00"
        )
        val dto = slot.toDto()
        assertEquals("wednesday", dto.dayOfWeek)
        assertEquals("CUSTOM", dto.mode)
        assertNull(dto.block)
        assertEquals("14:00", dto.start)
        assertEquals("20:00", dto.end)
    }

    @Test
    fun `DeliveryAvailabilityConfig toDto ida y vuelta`() {
        val config = DeliveryAvailabilityConfig(
            timezone = "America/Buenos_Aires",
            slots = listOf(
                DeliveryAvailabilitySlot(
                    dayOfWeek = DayOfWeek.TUESDAY,
                    mode = DeliveryAvailabilityMode.BLOCK,
                    block = DeliveryAvailabilityBlock.AFTERNOON
                )
            )
        )
        val dto = config.toDto()
        val backToDomain = dto.toDomain()
        assertEquals(config.timezone, backToDomain.timezone)
        assertEquals(1, backToDomain.slots.size)
        assertEquals(DayOfWeek.TUESDAY, backToDomain.slots[0].dayOfWeek)
        assertEquals(DeliveryAvailabilityMode.BLOCK, backToDomain.slots[0].mode)
        assertEquals(DeliveryAvailabilityBlock.AFTERNOON, backToDomain.slots[0].block)
    }
}
