package ar.com.intrale.kernel.audit

import java.security.MessageDigest
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

/**
 * Audit trail inmutable de acciones de autoridad del kernel (SEC-7 / OWASP A09).
 *
 * Reimplementacion en Kotlin del patron conceptual de
 * `.pipeline/lib/kernel-actions-audit.js` (NO es dependencia importable: aquel es
 * Node.js del pipeline — hallazgo guru #3). Portea:
 *   - append-only encadenado (hash-chain SHA-256: `hash = sha256(prevHash + payload)`).
 *   - log-ANTES-de-mutar (el handler llama [appendChained] antes de tocar el store).
 *   - sanitizacion de `reason`/campos libres: redact de secrets + escape CRLF
 *     (anti log-forging) + truncado.
 *
 * Registro por producto con `actor + kernelProductId + timestamp + origen`.
 * In-memory thread-safe; mapea a una tabla DynamoDB aditiva `kernel_actions_audit`.
 */
class KernelActionsAudit(
    private val clock: () -> Instant = { Instant.now() }
) {
    companion object {
        val GENESIS_HASH = "0".repeat(64)
        const val REDACTION_MARKER = "[REDACTED]"
        const val MAX_REASON_LEN = 500
        private const val TRUNCATION_NOTICE = "...[truncated]"

        /** Patrones defensivos de secrets (espejo del JS). */
        private val SECRET_LEAK_PATTERNS = listOf(
            Regex("""\bAKIA[0-9A-Z]{16}\b"""),                                    // AWS Access Key
            Regex("""\baws_secret_access_key\s*[:=]\s*[A-Za-z0-9/+=]{40}\b""", RegexOption.IGNORE_CASE),
            Regex("""\bxox[bpoas]-[A-Za-z0-9-]{10,}\b"""),                        // Slack
            Regex("""\bey[A-Za-z0-9_-]{8,}\.ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}\b"""), // JWT
            Regex("""\bsk-[A-Za-z0-9]{20,}\b"""),                                 // OpenAI / Anthropic
            Regex("""\bghp_[A-Za-z0-9]{30,}\b"""),                                // GitHub PAT
            Regex("""\bgho_[A-Za-z0-9]{30,}\b"""),                                // GitHub OAuth
            Regex("""\b[0-9]{8,}:[A-Za-z0-9_-]{30,}\b""")                         // Telegram bot token
        )

        /**
         * Sanitiza texto libre antes de persistirlo: redact de secrets + escape CRLF
         * + truncado. Es un helper puro y testeable.
         */
        fun sanitizeReason(text: String?): SanitizedReason {
            if (text == null) return SanitizedReason("", didRedact = false, didEscapeCrlf = false, didTruncate = false)
            var out: String = text
            var didRedact = false
            for (re in SECRET_LEAK_PATTERNS) {
                val before = out
                out = re.replace(out, REDACTION_MARKER)
                if (out != before) didRedact = true
            }
            var didEscapeCrlf = false
            if (out.contains('\r') || out.contains('\n')) {
                out = out.replace("\r\n", "\\n").replace("\n", "\\n").replace("\r", "\\r")
                didEscapeCrlf = true
            }
            var didTruncate = false
            if (out.length > MAX_REASON_LEN) {
                val keep = (MAX_REASON_LEN - TRUNCATION_NOTICE.length).coerceAtLeast(0)
                out = out.take(keep) + TRUNCATION_NOTICE
                didTruncate = true
            }
            return SanitizedReason(out, didRedact, didEscapeCrlf, didTruncate)
        }

        private fun sha256(input: String): String =
            MessageDigest.getInstance("SHA-256")
                .digest(input.toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
    }

    data class SanitizedReason(
        val sanitized: String,
        val didRedact: Boolean,
        val didEscapeCrlf: Boolean,
        val didTruncate: Boolean
    )

    data class KernelAuditEntry(
        val seq: Long,
        val actor: String,
        val kernelProductId: String,
        val action: String,
        val timestamp: String,
        val origin: String,
        val reason: String,
        val reasonRedacted: Boolean,
        val prevHash: String,
        val hash: String
    )

    // Cadena append-only por producto + secuencia global monotona.
    private val chainByProduct = ConcurrentHashMap<String, MutableList<KernelAuditEntry>>()
    private var lastHash: String = GENESIS_HASH
    private var seq: Long = 0

    /**
     * Registra (log-antes-de-mutar) una accion de autoridad y la encadena.
     * Sincronizado para mantener la integridad de la cadena (hash + seq).
     */
    @Synchronized
    fun appendChained(
        actor: String,
        kernelProductId: String,
        action: String,
        origin: String,
        reason: String? = null
    ): KernelAuditEntry {
        val san = sanitizeReason(reason)
        val ts = clock().toString()
        val nextSeq = seq + 1
        val payload = "$nextSeq|$actor|$kernelProductId|$action|$ts|$origin|${san.sanitized}"
        val hash = sha256(lastHash + "|" + payload)
        val entry = KernelAuditEntry(
            seq = nextSeq,
            actor = actor,
            kernelProductId = kernelProductId,
            action = action,
            timestamp = ts,
            origin = origin,
            reason = san.sanitized,
            reasonRedacted = san.didRedact,
            prevHash = lastHash,
            hash = hash
        )
        chainByProduct.computeIfAbsent(kernelProductId) { mutableListOf() }.add(entry)
        lastHash = hash
        seq = nextSeq
        return entry
    }

    /** Entradas registradas para un producto (copia inmutable, orden de insercion). */
    fun entries(kernelProductId: String): List<KernelAuditEntry> =
        chainByProduct[kernelProductId]?.toList() ?: emptyList()

    /** Cantidad total de entradas registradas. */
    fun size(): Int = chainByProduct.values.sumOf { it.size }

    /**
     * Verifica la integridad de la cadena global reconstruyendo los hashes en
     * orden de secuencia. Verdadero si ninguna entrada fue alterada.
     */
    fun verifyChain(): Boolean {
        val all = chainByProduct.values.flatten().sortedBy { it.seq }
        var prev = GENESIS_HASH
        for (e in all) {
            val payload = "${e.seq}|${e.actor}|${e.kernelProductId}|${e.action}|${e.timestamp}|${e.origin}|${e.reason}"
            val expected = sha256(prev + "|" + payload)
            if (e.prevHash != prev || e.hash != expected) return false
            prev = e.hash
        }
        return true
    }
}
