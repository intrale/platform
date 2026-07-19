package ar.com.intrale.kernel.projection

import ar.com.intrale.kernel.OperatorIdentity
import ar.com.intrale.kernel.authz.OperatorProductAuthz
import ar.com.intrale.kernel.store.KernelProductRecord
import ar.com.intrale.kernel.store.KernelProductState
import ar.com.intrale.kernel.store.KernelStore

/**
 * Proyeccion read-model de un producto, MINIMIZADA (SEC-4 / SEC-5 / OWASP A02).
 *
 * Contiene EXCLUSIVAMENTE una allowlist de campos pensada para render movil
 * (paridad de bolsillo con el dashboard). NUNCA incluye secretos, env, ni
 * internals de autoridad (ej. `KernelProductRecord.internalNote` queda afuera).
 *
 * Incluye `availableActions` (segun estado + authz del operador) y metadatos de
 * render (`label`, `lastActionAt`) para evitar N+1 de red en el cliente.
 */
data class KernelProductProjection(
    val kernelProductId: String,
    val state: String,
    val label: String,
    val availableActions: List<String>,
    val lastActionAt: String?
)

/**
 * Construye proyecciones read-model minimizadas, solo para los productos que la
 * identidad esta autorizada a operar. TLS obligatorio extremo a extremo se exige
 * a nivel transporte (documentado en el contrato) — la proyeccion no viaja en claro.
 */
class KernelProjection(
    private val store: KernelStore,
    private val authz: OperatorProductAuthz
) {
    companion object {
        /** Acciones de mutacion disponibles segun el estado del producto. */
        fun actionsFor(state: KernelProductState): List<String> = when (state) {
            KernelProductState.DRAFT -> listOf("approve", "reject")
            KernelProductState.PENDING -> listOf("approve", "reject")
            KernelProductState.APPROVED -> listOf("sign", "reject")
            KernelProductState.REJECTED -> listOf("approve")
            KernelProductState.SIGNED -> emptyList()
        }
    }

    /** Proyeccion de un producto puntual si [identity] esta autorizada; `null` si no. */
    fun projectOne(identity: OperatorIdentity, kernelProductId: String): KernelProductProjection? {
        if (!authz.canOperate(identity, kernelProductId)) return null
        val record = store.get(kernelProductId) ?: return null
        return toProjection(record)
    }

    /** Proyeccion de TODOS los productos autorizados para [identity] (sin N+1). */
    fun projectFor(identity: OperatorIdentity): List<KernelProductProjection> =
        authz.authorizedProducts(identity.subject)
            .mapNotNull { store.get(it) }
            .map { toProjection(it) }
            .sortedBy { it.kernelProductId }

    private fun toProjection(record: KernelProductRecord): KernelProductProjection =
        KernelProductProjection(
            kernelProductId = record.kernelProductId,
            state = record.state.name,
            label = record.label,
            availableActions = actionsFor(record.state),
            lastActionAt = record.lastActionAt
            // NB: internalNote / actor / campos de autoridad NO se proyectan (SEC-5).
        )
}
