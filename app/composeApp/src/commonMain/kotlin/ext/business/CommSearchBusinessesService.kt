package ext.business

import ar.com.intrale.shared.business.SearchBusinessesResponse

interface CommSearchBusinessesService {
    suspend fun execute(
        query: String = "",
        status: String? = null,
        limit: Int? = null,
        lastKey: String? = null
    ): Result<SearchBusinessesResponse>
}
