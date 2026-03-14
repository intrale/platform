package ar.com.intrale

import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class ProductRepository {

    private val products = ConcurrentHashMap<String, ProductRecord>()

    private fun key(business: String, productId: String) = "${business.lowercase()}#$productId"

    fun listProducts(business: String): List<ProductRecord> =
        products.values.filter { it.businessId == business.lowercase() }.map { it.copy() }

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
            stockQuantity = record.stockQuantity
        )
        products[key(business, productId)] = updated
        return updated
    }

    fun deleteProduct(business: String, productId: String): Boolean {
        return products.remove(key(business, productId)) != null
    }
}
