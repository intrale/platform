package ar.com.intrale

import java.time.LocalDate
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Representa una sugerencia de menu del dia almacenada en memoria.
 */
data class DailyMenuSuggestion(
    val id: String = UUID.randomUUID().toString(),
    val businessName: String = "",
    val date: String = LocalDate.now().toString(),
    val title: String = "",
    val description: String = "",
    val items: List<DailyMenuItem> = emptyList(),
    val reasoning: String = "",
    val status: String = "PENDING",
    val createdAt: String = java.time.Instant.now().toString()
)

/**
 * Item individual dentro de una sugerencia de menu.
 */
data class DailyMenuItem(
    val productId: String = "",
    val productName: String = "",
    val description: String = "",
    val suggestedPrice: Double = 0.0
)

/**
 * Repositorio en memoria para sugerencias de menu del dia.
 * Almacena las sugerencias por negocio y fecha.
 */
class DailyMenuRepository {

    private val suggestions = ConcurrentHashMap<String, MutableList<DailyMenuSuggestion>>()

    private fun key(business: String) = business.lowercase()

    /**
     * Obtiene la sugerencia mas reciente para un negocio en una fecha dada.
     */
    fun getLatestSuggestion(business: String, date: String = LocalDate.now().toString()): DailyMenuSuggestion? =
        suggestions.getOrDefault(key(business), mutableListOf())
            .filter { it.date == date }
            .maxByOrNull { it.createdAt }

    /**
     * Obtiene una sugerencia por su ID.
     */
    fun getSuggestionById(business: String, suggestionId: String): DailyMenuSuggestion? =
        suggestions.getOrDefault(key(business), mutableListOf())
            .firstOrNull { it.id == suggestionId }

    /**
     * Almacena una nueva sugerencia.
     */
    fun storeSuggestion(business: String, suggestion: DailyMenuSuggestion): DailyMenuSuggestion {
        suggestions.getOrPut(key(business)) { mutableListOf() }.add(suggestion)
        return suggestion
    }

    /**
     * Actualiza el estado de una sugerencia (PENDING -> APPROVED / REJECTED).
     */
    fun updateSuggestionStatus(business: String, suggestionId: String, newStatus: String): DailyMenuSuggestion? {
        val list = suggestions[key(business)] ?: return null
        val index = list.indexOfFirst { it.id == suggestionId }
        if (index < 0) return null
        val updated = list[index].copy(status = newStatus)
        list[index] = updated
        return updated
    }

    /**
     * Retorna los menus aprobados de los ultimos N dias para evitar repeticiones.
     */
    fun getRecentApprovedMenus(business: String, days: Int = 3): List<DailyMenuSuggestion> {
        val cutoff = LocalDate.now().minusDays(days.toLong()).toString()
        return suggestions.getOrDefault(key(business), mutableListOf())
            .filter { it.status == "APPROVED" && it.date >= cutoff }
            .sortedByDescending { it.date }
    }

    /**
     * Cuenta las sugerencias generadas hoy para un negocio (para limitar regeneraciones).
     */
    fun countTodaySuggestions(business: String): Int {
        val today = LocalDate.now().toString()
        return suggestions.getOrDefault(key(business), mutableListOf())
            .count { it.date == today }
    }
}
