package ar.com.intrale

import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Repositorio in-memory para sugerencias de promo generadas automaticamente.
 */
class PromoSuggestionRepository {

    private val suggestions = ConcurrentHashMap<String, PromoSuggestion>()

    private fun key(business: String, id: String) = "${business.lowercase()}#$id"

    fun save(business: String, suggestion: PromoSuggestion): PromoSuggestion {
        val saved = suggestion.copy(
            id = suggestion.id.ifBlank { UUID.randomUUID().toString() },
            businessId = business.lowercase()
        )
        suggestions[key(business, saved.id)] = saved
        return saved
    }

    fun listByBusiness(business: String): List<PromoSuggestion> =
        suggestions.values
            .filter { it.businessId == business.lowercase() }
            .sortedByDescending { it.createdAt }
            .map { it.copy() }

    fun listPending(business: String): List<PromoSuggestion> =
        listByBusiness(business).filter { it.status == "PENDING" }

    fun get(business: String, id: String): PromoSuggestion? =
        suggestions[key(business, id)]?.copy()

    fun updateStatus(business: String, id: String, newStatus: String): PromoSuggestion? {
        val existing = suggestions[key(business, id)] ?: return null
        val updated = existing.copy(status = newStatus)
        suggestions[key(business, id)] = updated
        return updated
    }

    fun update(business: String, id: String, suggestion: PromoSuggestion): PromoSuggestion? {
        val existing = suggestions[key(business, id)] ?: return null
        val updated = suggestion.copy(
            id = existing.id,
            businessId = existing.businessId
        )
        suggestions[key(business, id)] = updated
        return updated
    }
}
