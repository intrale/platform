package asdo.client

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PaymentStatusModelsTest {

    @Test
    fun `PaymentStatus fromString convierte estados correctamente`() {
        assertEquals(PaymentStatus.APPROVED, PaymentStatus.fromString("APPROVED"))
        assertEquals(PaymentStatus.REJECTED, PaymentStatus.fromString("REJECTED"))
        assertEquals(PaymentStatus.CANCELLED, PaymentStatus.fromString("CANCELLED"))
        assertEquals(PaymentStatus.IN_PROCESS, PaymentStatus.fromString("IN_PROCESS"))
        assertEquals(PaymentStatus.IN_PROCESS, PaymentStatus.fromString("IN_MEDIATION"))
        assertEquals(PaymentStatus.REFUNDED, PaymentStatus.fromString("REFUNDED"))
        assertEquals(PaymentStatus.REFUNDED, PaymentStatus.fromString("CHARGED_BACK"))
        assertEquals(PaymentStatus.PENDING, PaymentStatus.fromString("PENDING"))
        assertEquals(PaymentStatus.PENDING, PaymentStatus.fromString("unknown"))
    }

    @Test
    fun `isTerminal es true para estados finales`() {
        assertTrue(PaymentStatus.APPROVED.isTerminal)
        assertTrue(PaymentStatus.REJECTED.isTerminal)
        assertTrue(PaymentStatus.CANCELLED.isTerminal)
        assertTrue(PaymentStatus.REFUNDED.isTerminal)
    }

    @Test
    fun `isTerminal es false para estados intermedios`() {
        assertFalse(PaymentStatus.PENDING.isTerminal)
        assertFalse(PaymentStatus.IN_PROCESS.isTerminal)
    }
}
