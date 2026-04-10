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
            it.businessId == business.lowercase() && it.status.uppercase() == "PUBLISHED"
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
            isFeatured = record.isFeatured,
            promotionPrice = record.promotionPrice
        )
        products[key(business, productId)] = updated
        return updated
    }

    fun deleteProduct(business: String, productId: String): Boolean {
        return products.remove(key(business, productId)) != null
    }

    /**
     * Busca productos por IDs dentro de un negocio.
     * Retorna solo los encontrados; los IDs ausentes no aparecen en el resultado.
     */
    fun getProductsByIds(business: String, productIds: List<String>): List<ProductRecord> {
        return productIds.mapNotNull { id -> products[key(business, id)]?.copy() }
    }

    fun listPublishedProductsPaginated(
        business: String,
        offset: Int = 0,
        limit: Int = 20,
        category: String? = null,
        search: String? = null
    ): PaginatedResult<ProductRecord> {
        var filtered = products.values.filter {
            it.businessId == business.lowercase() && it.status.uppercase() == "PUBLISHED"
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

}

data class PaginatedResult<T>(
    val items: List<T>,
    val total: Int,
    val offset: Int,
    val limit: Int,
    val hasMore: Boolean
)
