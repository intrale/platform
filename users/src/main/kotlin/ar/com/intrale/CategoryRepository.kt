package ar.com.intrale

import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class CategoryRepository {

    private val categories = ConcurrentHashMap<String, CategoryRecord>()

    private fun key(business: String, categoryId: String) = "${business.lowercase()}#$categoryId"

    fun listCategories(business: String): List<CategoryRecord> =
        categories.values.filter { it.businessId == business.lowercase() }.map { it.copy() }

    fun getCategory(business: String, categoryId: String): CategoryRecord? =
        categories[key(business, categoryId)]?.copy()

    fun saveCategory(business: String, record: CategoryRecord): CategoryRecord {
        val saved = record.copy(
            id = record.id.ifBlank { UUID.randomUUID().toString() },
            businessId = business.lowercase()
        )
        categories[key(business, saved.id)] = saved
        return saved
    }

    fun updateCategory(business: String, categoryId: String, record: CategoryRecord): CategoryRecord? {
        val existing = categories[key(business, categoryId)] ?: return null
        val updated = existing.copy(
            name = record.name,
            description = record.description
        )
        categories[key(business, categoryId)] = updated
        return updated
    }

    fun deleteCategory(business: String, categoryId: String): Boolean {
        return categories.remove(key(business, categoryId)) != null
    }
}
