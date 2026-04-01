package ui.sc.client

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Store para el historial de búsquedas recientes del usuario.
 * Mantiene las últimas [MAX_HISTORY_SIZE] búsquedas en memoria.
 */
object SearchHistoryStore {

    private const val MAX_HISTORY_SIZE = 10

    private val _history = MutableStateFlow<List<String>>(emptyList())
    val history: StateFlow<List<String>> = _history.asStateFlow()

    /**
     * Agrega una búsqueda al historial. Si ya existe, la mueve al tope.
     * Solo se agregan queries con 2+ caracteres.
     */
    fun addSearch(query: String) {
        val trimmed = query.trim()
        if (trimmed.length < 2) return

        val current = _history.value.toMutableList()
        current.remove(trimmed)
        current.add(0, trimmed)

        _history.value = current.take(MAX_HISTORY_SIZE)
    }

    /**
     * Elimina una búsqueda específica del historial.
     */
    fun removeSearch(query: String) {
        _history.value = _history.value.filter { it != query }
    }

    /**
     * Limpia todo el historial de búsquedas.
     */
    fun clearHistory() {
        _history.value = emptyList()
    }

    /**
     * Retorna el historial filtrado por un prefijo opcional.
     */
    fun filteredHistory(prefix: String = ""): List<String> {
        if (prefix.isBlank()) return _history.value
        return _history.value.filter { it.contains(prefix, ignoreCase = true) }
    }
}
