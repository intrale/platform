package asdo.client

import ar.com.intrale.shared.client.PaymentMethodDTO
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PaymentMethodModelsTest {

    @Test
    fun `toDomain convierte correctamente un DTO de efectivo`() {
        val dto = PaymentMethodDTO(
            id = "pm-1",
            name = "Efectivo",
            type = "CASH",
            description = "Pago en efectivo al recibir",
            isCashOnDelivery = true,
            enabled = true
        )

        val domain = dto.toDomain()

        assertEquals("pm-1", domain.id)
        assertEquals("Efectivo", domain.name)
        assertEquals(PaymentMethodType.CASH, domain.type)
        assertEquals("Pago en efectivo al recibir", domain.description)
        assertTrue(domain.isCashOnDelivery)
        assertTrue(domain.enabled)
    }

    @Test
    fun `toDomain convierte correctamente un DTO de transferencia`() {
        val dto = PaymentMethodDTO(
            id = "pm-2",
            name = "Transferencia",
            type = "TRANSFER",
            description = null,
            isCashOnDelivery = false,
            enabled = true
        )

        val domain = dto.toDomain()

        assertEquals("pm-2", domain.id)
        assertEquals(PaymentMethodType.TRANSFER, domain.type)
        assertFalse(domain.isCashOnDelivery)
    }

    @Test
    fun `toDomain convierte correctamente un DTO de tarjeta`() {
        val dto = PaymentMethodDTO(
            id = "pm-3",
            name = "Tarjeta",
            type = "CARD",
            enabled = true
        )

        val domain = dto.toDomain()

        assertEquals(PaymentMethodType.CARD, domain.type)
    }

    @Test
    fun `toDomain convierte correctamente un DTO de billetera digital`() {
        val dto = PaymentMethodDTO(
            id = "pm-4",
            name = "MercadoPago",
            type = "DIGITAL_WALLET",
            enabled = true
        )

        val domain = dto.toDomain()

        assertEquals(PaymentMethodType.DIGITAL_WALLET, domain.type)
    }

    @Test
    fun `toDomain convierte tipo desconocido a OTHER`() {
        val dto = PaymentMethodDTO(
            id = "pm-5",
            name = "Crypto",
            type = "CRYPTO",
            enabled = true
        )

        val domain = dto.toDomain()

        assertEquals(PaymentMethodType.OTHER, domain.type)
    }

    @Test
    fun `toDomain convierte correctamente un DTO de Mercado Pago`() {
        val dto = PaymentMethodDTO(
            id = "pm-mp-1",
            name = "Mercado Pago",
            type = "MERCADO_PAGO",
            description = "Pagá con QR, tarjeta o transferencia",
            isCashOnDelivery = false,
            enabled = true
        )

        val domain = dto.toDomain()

        assertEquals("pm-mp-1", domain.id)
        assertEquals(PaymentMethodType.MERCADO_PAGO, domain.type)
        assertFalse(domain.isCashOnDelivery)
        assertTrue(domain.type.requiresExternalPayment)
    }

    @Test
    fun `toDomain convierte MERCADOPAGO sin guion bajo a MERCADO_PAGO`() {
        val dto = PaymentMethodDTO(
            id = "pm-mp-2",
            name = "MercadoPago",
            type = "MERCADOPAGO",
            enabled = true
        )

        val domain = dto.toDomain()

        assertEquals(PaymentMethodType.MERCADO_PAGO, domain.type)
    }

    @Test
    fun `PaymentMethodType fromString convierte tipos correctamente`() {
        assertEquals(PaymentMethodType.CASH, PaymentMethodType.fromString("CASH"))
        assertEquals(PaymentMethodType.CASH, PaymentMethodType.fromString("cash"))
        assertEquals(PaymentMethodType.TRANSFER, PaymentMethodType.fromString("TRANSFER"))
        assertEquals(PaymentMethodType.CARD, PaymentMethodType.fromString("CARD"))
        assertEquals(PaymentMethodType.DIGITAL_WALLET, PaymentMethodType.fromString("DIGITAL_WALLET"))
        assertEquals(PaymentMethodType.MERCADO_PAGO, PaymentMethodType.fromString("MERCADO_PAGO"))
        assertEquals(PaymentMethodType.MERCADO_PAGO, PaymentMethodType.fromString("MERCADOPAGO"))
        assertEquals(PaymentMethodType.OTHER, PaymentMethodType.fromString("unknown"))
    }

    @Test
    fun `requiresExternalPayment es true solo para MERCADO_PAGO`() {
        assertFalse(PaymentMethodType.CASH.requiresExternalPayment)
        assertFalse(PaymentMethodType.TRANSFER.requiresExternalPayment)
        assertFalse(PaymentMethodType.CARD.requiresExternalPayment)
        assertFalse(PaymentMethodType.DIGITAL_WALLET.requiresExternalPayment)
        assertFalse(PaymentMethodType.OTHER.requiresExternalPayment)
        assertTrue(PaymentMethodType.MERCADO_PAGO.requiresExternalPayment)
    }

    @Test
    fun `toDomain con DTO deshabilitado preserva enabled false`() {
        val dto = PaymentMethodDTO(
            id = "pm-6",
            name = "Deshabilitado",
            type = "CASH",
            enabled = false
        )

        val domain = dto.toDomain()

        assertFalse(domain.enabled)
    }
}
