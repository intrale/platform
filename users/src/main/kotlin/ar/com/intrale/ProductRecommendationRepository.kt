package ar.com.intrale

import org.slf4j.Logger
import org.slf4j.LoggerFactory

/**
 * Repositorio de recomendaciones de productos basadas en co-ocurrencia.
 *
 * Algoritmo:
 * 1. Para un usuario con historial: analiza los productos que compro en ordenes anteriores,
 *    busca otros pedidos del mismo negocio que contengan esos productos, y recomienda los
 *    productos co-ocurrentes ordenados por frecuencia.
 * 2. Para un usuario sin historial (fallback): devuelve los productos mas vendidos del negocio.
 */
class ProductRecommendationRepository(
    private val orderRepository: ClientOrderRepository,
    private val productRepository: ProductRepository
) {

    val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")

    companion object {
        const val DEFAULT_LIMIT = 8
        const val MIN_RESULTS = 4
    }

    /**
     * Obtiene recomendaciones personalizadas para un usuario en un negocio.
     *
     * @param business negocio
     * @param email email del usuario
     * @param limit cantidad maxima de recomendaciones
     * @return lista de productos recomendados (publicados y con stock)
     */
    fun getRecommendations(business: String, email: String, limit: Int = DEFAULT_LIMIT): List<ProductRecord> {
        logger.debug("Calculando recomendaciones para usuario=$email negocio=$business limit=$limit")

        val userOrders = orderRepository.listOrders(business, email)
        val userProductIds = userOrders
            .filter { it.status != "CANCELLED" }
            .flatMap { order -> order.items.map { it.productId } }
            .toSet()

        logger.debug("Productos del historial del usuario: ${userProductIds.size}")

        val recommendations = if (userProductIds.isNotEmpty()) {
            getCoOccurrenceRecommendations(business, email, userProductIds, limit)
        } else {
            emptyList()
        }

        // Si no hay suficientes recomendaciones, completar con los mas vendidos
        val result = if (recommendations.size < MIN_RESULTS) {
            logger.debug("Recomendaciones insuficientes (${recommendations.size}), complementando con mas vendidos")
            val alreadyRecommended = recommendations.map { it.id }.toSet()
            val topSelling = getTopSellingProducts(business, limit)
                .filter { it.id !in alreadyRecommended && it.id !in userProductIds }
            (recommendations + topSelling).take(limit)
        } else {
            recommendations
        }

        logger.debug("Recomendaciones finales: ${result.size} productos para usuario=$email")
        return result
    }

    /**
     * Recomendaciones basadas en co-ocurrencia:
     * "Otros usuarios que compraron X tambien compraron Y"
     */
    internal fun getCoOccurrenceRecommendations(
        business: String,
        email: String,
        userProductIds: Set<String>,
        limit: Int
    ): List<ProductRecord> {
        val allOrders = orderRepository.listAllOrdersForBusiness(business)

        // Contar co-ocurrencias: para cada orden que contenga al menos un producto del usuario,
        // sumar los otros productos de esa orden
        val coOccurrenceCount = mutableMapOf<String, Int>()

        for (orderItem in allOrders) {
            // Excluir ordenes canceladas y las propias del usuario
            if (orderItem.order.status == "CANCELLED") continue
            if (orderItem.clientEmail.equals(email, ignoreCase = true)) continue

            val orderProductIds = orderItem.order.items.map { it.productId }.toSet()
            val hasOverlap = orderProductIds.any { it in userProductIds }

            if (hasOverlap) {
                // Sumar productos que el usuario NO compro todavia
                for (productId in orderProductIds) {
                    if (productId !in userProductIds) {
                        coOccurrenceCount[productId] = (coOccurrenceCount[productId] ?: 0) + 1
                    }
                }
            }
        }

        logger.debug("Co-ocurrencias encontradas: ${coOccurrenceCount.size} productos candidatos")

        // Ordenar por frecuencia de co-ocurrencia descendente
        val sortedProductIds = coOccurrenceCount.entries
            .sortedByDescending { it.value }
            .map { it.key }

        // Filtrar: solo publicados, disponibles y con stock
        return sortedProductIds
            .mapNotNull { productId -> productRepository.getProduct(business, productId) }
            .filter { it.status.uppercase() == "PUBLISHED" && it.isAvailable && hasStock(it) }
            .take(limit)
    }

    /**
     * Fallback: productos mas vendidos del negocio (para usuarios sin historial).
     */
    internal fun getTopSellingProducts(business: String, limit: Int): List<ProductRecord> {
        val allOrders = orderRepository.listAllOrdersForBusiness(business)

        val salesCount = mutableMapOf<String, Int>()
        for (orderItem in allOrders) {
            if (orderItem.order.status == "CANCELLED") continue
            for (item in orderItem.order.items) {
                salesCount[item.productId] = (salesCount[item.productId] ?: 0) + item.quantity
            }
        }

        val sortedProductIds = salesCount.entries
            .sortedByDescending { it.value }
            .map { it.key }

        return sortedProductIds
            .mapNotNull { productId -> productRepository.getProduct(business, productId) }
            .filter { it.status.uppercase() == "PUBLISHED" && it.isAvailable && hasStock(it) }
            .take(limit)
    }

    /**
     * Verifica si el usuario tiene historial de compras en el negocio.
     */
    fun hasUserHistory(business: String, email: String): Boolean {
        return orderRepository.listOrders(business, email)
            .any { it.status != "CANCELLED" }
    }

    private fun hasStock(product: ProductRecord): Boolean {
        // Si stockQuantity es null, se asume stock ilimitado
        return product.stockQuantity == null || product.stockQuantity > 0
    }
}
