package ext.business

import ext.dto.SearchBusinessesResponse

interface CommSearchBusinessesService {
    suspend fun execute(
        query: String = "",
        status: String? = null,
        limit: Int? = null,
        lastKey: String? = null
    ): Result<SearchBusinessesResponse>
}
