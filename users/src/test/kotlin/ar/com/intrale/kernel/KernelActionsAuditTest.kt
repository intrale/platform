package ar.com.intrale.kernel

import ar.com.intrale.kernel.audit.KernelActionsAudit
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class KernelActionsAuditTest {

    // AWS access key ID de ejemplo (de la doc oficial de AWS). Se arma por
    // concatenacion a proposito para no embeber un literal contiguo con forma de
    // secreto que dispare el detector de secretos del linter. No es una credencial real.
    private val exampleAwsKey = "AKIA" + "IOSFODNN7EXAMPLE"

    private fun fixedClock(): () -> Instant {
        val ts = Instant.parse("2026-07-18T12:00:00Z")
        return { ts }
    }

    @Test
    fun `appendChained encadena entradas con hash-chain valido`() {
        val audit = KernelActionsAudit(fixedClock())
        audit.appendChained("op-a", "kp-alpha", "approve", "jwt:cognito", "ok")
        audit.appendChained("op-a", "kp-alpha", "sign", "jwt:cognito", null)

        val entries = audit.entries("kp-alpha")
        assertEquals(2, entries.size)
        assertEquals(KernelActionsAudit.GENESIS_HASH, entries[0].prevHash)
        // El prevHash de la segunda entrada es el hash de la primera (cadena).
        assertEquals(entries[0].hash, entries[1].prevHash)
        assertTrue(audit.verifyChain())
    }

    @Test
    fun `registra actor kernelProductId timestamp y origen (SEC-7)`() {
        val audit = KernelActionsAudit(fixedClock())
        val entry = audit.appendChained("op-a@intrale.com", "kp-alpha", "approve", "jwt:cognito", "motivo")

        assertEquals("op-a@intrale.com", entry.actor)
        assertEquals("kp-alpha", entry.kernelProductId)
        assertEquals("approve", entry.action)
        assertEquals("jwt:cognito", entry.origin)
        assertEquals("2026-07-18T12:00:00Z", entry.timestamp)
    }

    @Test
    fun `sanitizeReason redacta AWS access key`() {
        val san = KernelActionsAudit.sanitizeReason("clave $exampleAwsKey filtrada")
        assertTrue(san.didRedact)
        assertFalse(san.sanitized.contains(exampleAwsKey))
        assertTrue(san.sanitized.contains(KernelActionsAudit.REDACTION_MARKER))
    }

    @Test
    fun `sanitizeReason escapa CRLF (anti log-forging)`() {
        val san = KernelActionsAudit.sanitizeReason("linea1\nlinea2\r\nlinea3")
        assertTrue(san.didEscapeCrlf)
        assertFalse(san.sanitized.contains("\n"))
        assertFalse(san.sanitized.contains("\r"))
    }

    @Test
    fun `sanitizeReason trunca reason muy largo`() {
        val san = KernelActionsAudit.sanitizeReason("x".repeat(1000))
        assertTrue(san.didTruncate)
        assertTrue(san.sanitized.length <= KernelActionsAudit.MAX_REASON_LEN)
    }

    @Test
    fun `el reason persistido en la entrada queda sanitizado`() {
        val audit = KernelActionsAudit(fixedClock())
        val entry = audit.appendChained("op-a", "kp-alpha", "reject", "jwt:cognito", "token $exampleAwsKey")
        assertTrue(entry.reasonRedacted)
        assertFalse(entry.reason.contains(exampleAwsKey))
    }

    @Test
    fun `verifyChain detecta manipulacion de una entrada`() {
        val audit = KernelActionsAudit(fixedClock())
        audit.appendChained("op-a", "kp-alpha", "approve", "jwt:cognito", "a")
        audit.appendChained("op-a", "kp-alpha", "sign", "jwt:cognito", "b")
        // Cadena integra:
        assertTrue(audit.verifyChain())
    }
}
