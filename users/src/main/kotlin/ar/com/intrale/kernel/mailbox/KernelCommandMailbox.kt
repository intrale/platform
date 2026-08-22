package ar.com.intrale.kernel.mailbox

import java.util.concurrent.ConcurrentHashMap

/** Ciclo de vida del comando asincrono expuesto al operador (paridad UX con dashboard). */
enum class CommandStatus { ENQUEUED, PROCESSING, CONFIRMED, REJECTED }

/**
 * Entrada del buzon de comandos, keyeada por `idempotencyKey`.
 * `responseBody`/`responseStatus` se completan al confirmar/rechazar para poder
 * devolver la respuesta ORIGINAL en un replay sin re-ejecutar la mutacion.
 */
data class MailboxEntry(
    val idempotencyKey: String,
    val kernelProductId: String,
    val actor: String,
    val status: CommandStatus,
    val responseStatus: Int? = null,
    val responseBody: String? = null
)

/**
 * Buzon de comandos asincrono con anti-replay atomico (SEC-3 / OWASP A07/A08).
 *
 * El anti-replay es un check-and-set ATOMICO ([ConcurrentHashMap.putIfAbsent]),
 * NO read-then-write — evita el TOCTOU que marcaron security (A07) y guru #4.
 * Mapea 1:1 a un `putItem` DynamoDB con
 * `conditionExpression(attribute_not_exists(idempotencyKey))`.
 *
 * Uso:
 *   val existing = mailbox.reserve(key, product, actor)
 *   if (existing != null) return <replay: respuesta original de `existing`>
 *   // ... ejecutar mutacion exactamente una vez ...
 *   mailbox.complete(key, CONFIRMED, statusCode, body)
 */
class KernelCommandMailbox {

    private val store = ConcurrentHashMap<String, MailboxEntry>()

    /**
     * Reserva atomicamente [idempotencyKey]. Devuelve:
     *   - `null` si la clave es NUEVA (el caller es dueño: debe ejecutar la mutacion), o
     *   - la [MailboxEntry] EXISTENTE si es un replay (el caller NO debe re-ejecutar;
     *     debe devolver la respuesta original).
     */
    fun reserve(idempotencyKey: String, kernelProductId: String, actor: String): MailboxEntry? {
        val fresh = MailboxEntry(
            idempotencyKey = idempotencyKey,
            kernelProductId = kernelProductId,
            actor = actor,
            status = CommandStatus.PROCESSING
        )
        return store.putIfAbsent(idempotencyKey, fresh)
    }

    /** Marca el comando como confirmado/rechazado y persiste la respuesta original para replays. */
    fun complete(idempotencyKey: String, status: CommandStatus, responseStatus: Int, responseBody: String) {
        store.computeIfPresent(idempotencyKey) { _, prev ->
            prev.copy(status = status, responseStatus = responseStatus, responseBody = responseBody)
        }
    }

    /** Estado actual del comando (para lectura de estado por idempotency-key). */
    fun get(idempotencyKey: String): MailboxEntry? = store[idempotencyKey]
}
