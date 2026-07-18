package ar.com.intrale.kernel

import ar.com.intrale.kernel.mailbox.CommandStatus
import ar.com.intrale.kernel.mailbox.KernelCommandMailbox
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class KernelCommandMailboxTest {

    @Test
    fun `reserve devuelve null la primera vez y la entrada existente en el replay`() {
        val mailbox = KernelCommandMailbox()
        val first = mailbox.reserve("idem-123456", "kp-alpha", "op-a")
        assertNull(first) // el caller es dueño -> debe ejecutar

        val replay = mailbox.reserve("idem-123456", "kp-alpha", "op-a")
        assertNotNull(replay) // replay -> NO re-ejecutar
        assertEquals("kp-alpha", replay.kernelProductId)
    }

    @Test
    fun `complete persiste la respuesta original para el replay`() {
        val mailbox = KernelCommandMailbox()
        mailbox.reserve("idem-abcdef01", "kp-alpha", "op-a")
        mailbox.complete("idem-abcdef01", CommandStatus.CONFIRMED, 200, "{\"ok\":true}")

        val entry = mailbox.get("idem-abcdef01")
        assertNotNull(entry)
        assertEquals(CommandStatus.CONFIRMED, entry.status)
        assertEquals(200, entry.responseStatus)
        assertEquals("{\"ok\":true}", entry.responseBody)
    }

    @Test
    fun `claves distintas se reservan independientemente`() {
        val mailbox = KernelCommandMailbox()
        assertNull(mailbox.reserve("idem-11111111", "kp-alpha", "op-a"))
        assertNull(mailbox.reserve("idem-22222222", "kp-alpha", "op-a"))
    }
}
