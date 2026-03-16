package asdo.business

import ar.com.intrale.shared.business.SearchBusinessesResponse

interface ToGetBusinesses {
    suspend fun execute(
        query: String = "",
        status: String? = null,
        limit: Int? = null,
        lastKey: String? = null
    ): Result<SearchBusinessesResponse>
}
