package asdo

import ext.SearchBusinessesResponse

interface ToGetBusinesses {
    suspend fun execute(
        query: String = "",
        status: String? = null,
        limit: Int? = null,
        lastKey: String? = null
    ): Result<SearchBusinessesResponse>
}
