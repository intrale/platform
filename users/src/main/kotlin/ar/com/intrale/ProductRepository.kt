package ar.com.intrale

import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class ProductRepository {

    private val products = ConcurrentHashMap<String, ProductRecord>()

    private fun key(business: String, productId: String) = "${business.lowercase()}#$productId"

    fun listProducts(business: String): List<ProductRecord> =
        products.values.filter { it.businessId == business.lowercase() }.map { it.copy() }

    fun listPublishedProducts(business: String): List<ProductRecord> =
        products.values.filter {
            it.businessId == business.lowercase()
                && it.status.uppercase() == "PUBLISHED"
                && it.isAvailable
        }.map { it.copy() }

    fun getProduct(business: String, productId: String): ProductRecord? =
        products[key(business, productId)]?.copy()

    fun saveProduct(business: String, record: ProductRecord): ProductRecord {
        val saved = record.copy(
            id = record.id.ifBlank { UUID.randomUUID().toString() },
            businessId = business.lowercase()
        )
        products[key(business, saved.id)] = saved
        return saved
    }

    fun updateProduct(business: String, productId: String, record: ProductRecord): ProductRecord? {
        val existing = products[key(business, productId)] ?: return null
        val updated = existing.copy(
            name = record.name,
            shortDescription = record.shortDescription,
            basePrice = record.basePrice,
            unit = record.unit,
            categoryId = record.categoryId,
            status = record.status,
            isAvailable = record.isAvailable,
            stockQuantity = record.stockQuantity,
            minStock = record.minStock,
            isFeatured = record.isFeatured,
            promotionPrice = record.promotionPrice
        )
        products[key(business, productId)] = updated
        return updated
    }

    fun deleteProduct(business: String, productId: String): Boolean {
        return products.remove(key(business, productId)) != null
    }

    fun listPublishedProductsPaginated(
        business: String,
        offset: Int = 0,
        limit: Int = 20,
        category: String? = null,
        search: String? = null
    ): PaginatedResult<ProductRecord> {
        var filtered = products.values.filter {
            it.businessId == business.lowercase()
                && it.status.uppercase() == "PUBLISHED"
                && it.isAvailable
        }

        if (!category.isNullOrBlank()) {
            filtered = filtered.filter { it.categoryId.equals(category, ignoreCase = true) }
        }

        if (!search.isNullOrBlank()) {
            val searchLower = search.lowercase()
            filtered = filtered.filter { it.name.lowercase().contains(searchLower) }
        }

        val total = filtered.size
        val sortedList = filtered.sortedBy { it.name }
        val paged = sortedList.drop(offset).take(limit).map { it.copy() }
        val hasMore = offset + limit < total

        return PaginatedResult(
            items = paged,
            total = total,
            offset = offset,
            limit = limit,
            hasMore = hasMore
        )
    }

    /**
     * Lista productos ordenados por stock ascendente (los mas bajos primero).
     * Solo incluye productos que tienen stock gestionado (stockQuantity != null).
     */
    fun listProductsByStock(business: String): List<ProductRecord> =
        products.values
            .filter { it.businessId == business.lowercase() && it.stockQuantity != null }
            .sortedBy { it.stockQuantity }
            .map { it.copy() }

    /**
     * Lista productos cuyo stock esta por debajo del minimo configurado.
     */
    fun listLowStockProducts(business: String): List<ProductRecord> =
        products.values
            .filter { record ->
                record.businessId == business.lowercase()
                    && record.stockQuantity != null
                    && record.minStock != null
                    && record.stockQuantity <= record.minStock
            }
            .sortedBy { it.stockQuantity }
            .map { it.copy() }

    /**
     * Ajusta el stock de un producto sumando (o restando si negativo) la cantidad indicada.
     * Si el stock resultante es 0, marca isAvailable = false.
     * Retorna el producto actualizado o null si no existe.
     */
    fun adjustStock(business: String, productId: String, delta: Int): ProductRecord? {
        val k = key(business, productId)
        val existing = products[k] ?: return null
        val currentStock = existing.stockQuantity ?: 0
        val newStock = maxOf(0, currentStock + delta)
        val updated = existing.copy(
            stockQuantity = newStock,
            isAvailable = newStock > 0
        )
        products[k] = updated
        return updated
    }

    /**
     * Establece el stock a un valor absoluto.
     * Si el stock resultante es 0, marca isAvailable = false.
     */
    fun setStock(business: String, productId: String, quantity: Int): ProductRecord? {
        val k = key(business, productId)
        val existing = products[k] ?: return null
        val safeQuantity = maxOf(0, quantity)
        val updated = existing.copy(
            stockQuantity = safeQuantity,
            isAvailable = safeQuantity > 0
        )
        products[k] = updated
        return updated
    }

    /**
     * Descuenta stock para multiples productos (usado al completar un pedido).
     * Retorna la lista de productos que quedaron por debajo de su stock minimo.
     */
    fun deductStockBatch(business: String, items: List<StockDeductionItem>): StockDeductionResult {
        val updatedProducts = mutableListOf<ProductRecord>()
        val lowStockAlerts = mutableListOf<ProductRecord>()
        val errors = mutableListOf<String>()

        for (item in items) {
            val k = key(business, item.productId)
            val existing = products[k]
            if (existing == null) {
                errors.add("Producto ${item.productId} no encontrado")
                continue
            }
            val currentStock = existing.stockQuantity ?: 0
            val newStock = maxOf(0, currentStock - item.quantity)
            val updated = existing.copy(
                stockQuantity = newStock,
                isAvailable = newStock > 0
            )
            products[k] = updated
            updatedProducts.add(updated)

            if (updated.minStock != null && newStock <= updated.minStock) {
                lowStockAlerts.add(updated)
            }
        }

        return StockDeductionResult(
            updatedProducts = updatedProducts,
            lowStockAlerts = lowStockAlerts,
            errors = errors
        )
    }
}

data class StockDeductionItem(
    val productId: String,
    val quantity: Int
)

data class StockDeductionResult(
    val updatedProducts: List<ProductRecord>,
    val lowStockAlerts: List<ProductRecord>,
    val errors: List<String>
)

data class PaginatedResult<T>(
    val items: List<T>,
    val total: Int,
    val offset: Int,
    val limit: Int,
    val hasMore: Boolean
)
