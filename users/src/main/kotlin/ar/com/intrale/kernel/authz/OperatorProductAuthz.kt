package ar.com.intrale.kernel.authz

import ar.com.intrale.kernel.OperatorIdentity
import java.util.concurrent.ConcurrentHashMap

/**
 * Autorizacion operador -> productos operativos del kernel (SEC-1 / OWASP A01).
 *
 * Fuente de verdad del scope multi-tenant: mapeo `subject` (identidad del JWT)
 * -> conjunto de `kernelProductId` autorizados. El scope se deriva SIEMPRE de la
 * identidad, NUNCA de un `kernelProductId` provisto por el cliente en el body/param.
 *
 * Nota de nomenclatura (hallazgo guru #2): se usa `kernelProductId` (producto
 * operativo/instancia del modelo), distinto de `productId` (SKU de catalogo
 * ecommerce en `BusinessProducts`/`ProductRepository`). No reutilizar.
 *
 * Implementacion in-memory thread-safe ([ConcurrentHashMap]) siguiendo el patron
 * de repositorios durables del repo (`ClientOrderRepository`, etc.). Mapea 1:1 a
 * una tabla DynamoDB `kernel_operator_products` (PK=`subject`, SK=`kernelProductId`,
 * registro aditivo). Al portar a DynamoDB, `canOperate` es un `getItem` puntual.
 */
class OperatorProductAuthz {

    private val grants = ConcurrentHashMap<String, MutableSet<String>>()

    /** Otorga a [subject] permiso de operar sobre [kernelProductId]. Aditivo e idempotente. */
    fun grant(subject: String, kernelProductId: String) {
        grants.computeIfAbsent(subject) { ConcurrentHashMap.newKeySet() }.add(kernelProductId)
    }

    /** Revoca el permiso de [subject] sobre [kernelProductId]. */
    fun revoke(subject: String, kernelProductId: String) {
        grants[subject]?.remove(kernelProductId)
    }

    /** Conjunto de productos que [subject] puede operar (copia inmutable). */
    fun authorizedProducts(subject: String): Set<String> =
        grants[subject]?.toSet() ?: emptySet()

    /**
     * Verdadero solo si la [identity] esta autorizada para [kernelProductId].
     * Es el gate SEC-1: una identidad autorizada para el producto A debe recibir
     * `false` (=> 403) al intentar operar sobre el producto B.
     */
    fun canOperate(identity: OperatorIdentity, kernelProductId: String): Boolean =
        grants[identity.subject]?.contains(kernelProductId) == true

    /** Verdadero si ninguna identidad reclama [kernelProductId] todavia (para alta de proyecto). */
    fun isUnclaimed(kernelProductId: String): Boolean =
        grants.values.none { it.contains(kernelProductId) }
}
