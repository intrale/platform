package asdo.business

import ext.dto.SearchBusinessesResponse

interface ToGetBusinesses {
    suspend fun execute(
        query: String = "",
        status: String? = null,
        limit: Int? = null,
        lastKey: String? = null
    ): Result<SearchBusinessesResponse>
}
