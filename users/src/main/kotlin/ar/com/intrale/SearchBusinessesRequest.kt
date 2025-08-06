package ar.com.intrale

data class SearchBusinessesRequest(
    val query: String = "",
    val status: String? = null,
    val limit: Int? = null,
    val lastKey: String? = null
)
