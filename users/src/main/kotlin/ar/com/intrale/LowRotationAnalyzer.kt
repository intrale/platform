package ar.com.intrale

import org.slf4j.Logger
import org.slf4j.LoggerFactory
import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * Resultado del analisis de rotacion de un producto.
 */
data class LowRotationProduct(
    val productId: String,
    val productName: String,
    val basePrice: Double,
    val unit: String,
    val daysSinceLastSale: Int,
    val totalSalesInPeriod: Int,
    val stockQuantity: Int?
)

/**
 * Analiza la rotacion de productos de un negocio comparando ordenes recientes
 * contra el catalogo de productos publicados.
 *
 * Un producto se considera de "baja rotacion" si no se vendio en los ultimos
 * N dias (configurable via thresholdDays).
 */
class LowRotationAnalyzer(
    private val productRepository: ProductRepository,
    private val orderRepository: ClientOrderRepository
) {
    private val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")

    /**
     * Detecta productos con baja rotacion para un negocio.
     *
     * @param business nombre del negocio
     * @param thresholdDays dias sin venta para considerar baja rotacion
     * @return lista de productos con baja rotacion, ordenados por dias sin venta (descendente)
     */
    fun detectLowRotation(business: String, thresholdDays: Int = 7): List<LowRotationProduct> {
        val publishedProducts = productRepository.listPublishedProducts(business)
        if (publishedProducts.isEmpty()) {
            logger.debug("No hay productos publicados para negocio=$business")
            return emptyList()
        }

        val allOrders = orderRepository.listAllOrdersForBusiness(business)
        val now = Instant.now()
        val cutoffDate = now.minus(thresholdDays.toLong(), ChronoUnit.DAYS).toString()

        // Contar ventas por producto en el periodo
        val salesByProduct = mutableMapOf<String, Int>()
        val lastSaleByProduct = mutableMapOf<String, String>()

        for (orderItem in allOrders) {
            val order = orderItem.order
            // Solo considerar ordenes completadas o en proceso (no canceladas)
            if (order.status.uppercase() in listOf("CANCELLED", "REJECTED")) continue

            val orderDate = order.createdAt ?: continue
            if (orderDate >= cutoffDate) {
                for (item in order.items) {
                    val productName = item.productName
                    salesByProduct[productName] = (salesByProduct[productName] ?: 0) + item.quantity
                }
            }

            // Rastrear ultima venta de cada producto (sin importar periodo)
            for (item in order.items) {
                val currentLast = lastSaleByProduct[item.productName]
                if (currentLast == null || orderDate > currentLast) {
                    lastSaleByProduct[item.productName] = orderDate
                }
            }
        }

        // Identificar productos con baja rotacion
        val lowRotation = mutableListOf<LowRotationProduct>()
        for (product in publishedProducts) {
            val salesCount = salesByProduct[product.name] ?: 0
            if (salesCount == 0) {
                // Producto sin ventas en el periodo
                val lastSaleDate = lastSaleByProduct[product.name]
                val daysSince = if (lastSaleDate != null) {
                    try {
                        ChronoUnit.DAYS.between(
                            Instant.parse(lastSaleDate),
                            now
                        ).toInt()
                    } catch (e: Exception) {
                        thresholdDays // fallback
                    }
                } else {
                    thresholdDays * 2 // nunca se vendio
                }

                lowRotation.add(
                    LowRotationProduct(
                        productId = product.id,
                        productName = product.name,
                        basePrice = product.basePrice,
                        unit = product.unit,
                        daysSinceLastSale = daysSince,
                        totalSalesInPeriod = 0,
                        stockQuantity = product.stockQuantity
                    )
                )
            }
        }

        logger.info("Analisis de rotacion para negocio=$business: ${lowRotation.size}/${publishedProducts.size} productos con baja rotacion (umbral=${thresholdDays} dias)")
        return lowRotation.sortedByDescending { it.daysSinceLastSale }
    }
}
