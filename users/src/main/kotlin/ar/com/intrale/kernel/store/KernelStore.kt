package ar.com.intrale.kernel.store

import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

/** Estado operativo de un producto del kernel. */
enum class KernelProductState { DRAFT, PENDING, APPROVED, REJECTED, SIGNED }

/**
 * Registro durable del estado por producto operativo del kernel, keyeado por
 * `kernelProductId` (SEC-1: toda mutacion queda scopeada a un unico producto).
 *
 * `internalNote` representa un campo interno/de autoridad que la proyeccion
 * read-model NUNCA debe exponer (verificable en test de minimizacion SEC-5).
 */
data class KernelProductRecord(
    val kernelProductId: String,
    val label: String,
    val state: KernelProductState,
    val lastAction: String?,
    val lastActor: String?,
    val lastActionAt: String?,
    val internalNote: String? = null
)

/**
 * Store durable in-memory (thread-safe) del estado por producto del kernel.
 * Sigue el patron de repositorios del repo; mapea a una tabla DynamoDB aditiva
 * `kernel_products` (PK=`kernelProductId`). El aislamiento por producto lo
 * garantiza el keyeo: no hay operacion que abarque mas de un `kernelProductId`.
 */
class KernelStore(
    private val clock: () -> Instant = { Instant.now() }
) {
    private val products = ConcurrentHashMap<String, KernelProductRecord>()

    fun exists(kernelProductId: String): Boolean = products.containsKey(kernelProductId)

    fun get(kernelProductId: String): KernelProductRecord? = products[kernelProductId]

    /** Alta de proyecto. Devuelve `null` si el producto ya existe (no pisar). */
    fun create(kernelProductId: String, label: String, actor: String): KernelProductRecord? {
        val now = clock().toString()
        val record = KernelProductRecord(
            kernelProductId = kernelProductId,
            label = label,
            state = KernelProductState.DRAFT,
            lastAction = "project-create",
            lastActor = actor,
            lastActionAt = now
        )
        return if (products.putIfAbsent(kernelProductId, record) == null) record else null
    }

    /** Transiciona el estado de un producto existente registrando actor/accion/timestamp. */
    fun transition(
        kernelProductId: String,
        newState: KernelProductState,
        action: String,
        actor: String
    ): KernelProductRecord? {
        val now = clock().toString()
        return products.computeIfPresent(kernelProductId) { _, prev ->
            prev.copy(
                state = newState,
                lastAction = action,
                lastActor = actor,
                lastActionAt = now
            )
        }
    }
}
