package ar.com.intrale

import io.ktor.http.HttpStatusCode

/**
 * Payload de una sugerencia de producto para el buscador.
 * Incluye campos mínimos para mostrar en la lista de sugerencias.
 */
data class ProductSuggestionPayload(
    val id: String,
    val name: String,
    val basePrice: Double,
    val emoji: String? = null,
    val categoryId: String = "",
    val isAvailable: Boolean = true
)

/**
 * Respuesta del endpoint de sugerencias de búsqueda de productos.
 */
class ProductSuggestionsResponse(
    val suggestions: List<ProductSuggestionPayload>,
    val query: String,
    val total: Int,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * Respuesta del endpoint de historial de búsquedas.
 */
class SearchHistoryResponse(
    val history: List<SearchHistoryEntry>,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * Request para agregar una búsqueda al historial.
 */
data class AddSearchHistoryRequest(
    val query: String = ""
)

/**
 * Convierte un ProductRecord a un payload de sugerencia.
 */
fun ProductRecord.toSuggestionPayload() = ProductSuggestionPayload(
    id = id,
    name = name,
    basePrice = basePrice,
    categoryId = categoryId,
    isAvailable = isAvailable
)
