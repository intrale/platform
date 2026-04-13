package ar.com.intrale

import java.util.concurrent.ConcurrentHashMap

/**
 * Repositorio en memoria para el historial de búsquedas de productos por usuario.
 * Almacena las últimas MAX_HISTORY_SIZE búsquedas por usuario+negocio.
 */
class SearchHistoryRepository {

    companion object {
        const val MAX_HISTORY_SIZE = 10
    }

    // Clave: "email#business" → lista ordenada por reciente (más reciente primero)
    private val history = ConcurrentHashMap<String, MutableList<SearchHistoryEntry>>()

    private fun key(email: String, business: String) = "${email.lowercase()}#${business.lowercase()}"

    /**
     * Agrega una búsqueda al historial del usuario.
     * Si la query ya existe, la mueve al inicio (más reciente).
     * Mantiene máximo MAX_HISTORY_SIZE entradas.
     */
    fun addSearch(email: String, business: String, query: String): List<SearchHistoryEntry> {
        val k = key(email, business)
        val trimmedQuery = query.trim()
        if (trimmedQuery.isBlank()) return getHistory(email, business)

        val entries = history.getOrPut(k) { mutableListOf() }
        synchronized(entries) {
            // Eliminar duplicado si existe
            entries.removeAll { it.query.equals(trimmedQuery, ignoreCase = true) }
            // Agregar al inicio
            entries.add(0, SearchHistoryEntry(query = trimmedQuery, timestamp = System.currentTimeMillis()))
            // Recortar si excede el máximo
            while (entries.size > MAX_HISTORY_SIZE) {
                entries.removeAt(entries.size - 1)
            }
        }
        return entries.toList()
    }

    /**
     * Obtiene el historial de búsquedas del usuario, ordenado por más reciente.
     */
    fun getHistory(email: String, business: String): List<SearchHistoryEntry> {
        val k = key(email, business)
        return history[k]?.toList() ?: emptyList()
    }

    /**
     * Elimina todo el historial de búsquedas del usuario.
     */
    fun clearHistory(email: String, business: String) {
        val k = key(email, business)
        history.remove(k)
    }
}

data class SearchHistoryEntry(
    val query: String,
    val timestamp: Long
)
